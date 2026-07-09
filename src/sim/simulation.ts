import type { Diagnostics, Domain, LineSegment, PotentialParams } from "./types";
import { effectiveCutoff, pairForce, shiftEnergy } from "./potential";
import { CellList } from "./cellList";
import { accumulateBarrierForce, type BarrierAccumulator } from "./barriers";
import type { Rng } from "./rng";
import type { MovingSegment } from "./movingSegment";

// Reduced (LJ) units: masses = 1, ε and σ are the natural scales.
// Temperature is defined by <KE> = (d/2) N k_B T with d=2, k_B=1, so
//   T = <v^2>  (mean of v_i·v_i over atoms).

// Atom kinds:
//  0 free      — refrigerant, sees pair force and (unless excluded) barriers
//  1 tethered  — wall atom bound to a lattice site by a harmonic spring;
//                sees pair force but is EXCLUDED from line barriers (so a
//                wall's coincident line barrier keeps the refrigerant on
//                the right side while wall atoms don't push themselves).
export type AtomKind = 0 | 1;

export interface SimulationConfig {
  domain: Domain;
  potential: PotentialParams;
  segments: LineSegment[];
  dt: number;
  capacity: number;
}

// Langevin thermostat group. Acts on a fixed set of atom indices. Records the
// cumulative energy it's injected (energyIn) or removed (energyOut) so the
// heat-pump COP can be computed as Q_hot / W without any special-casing.
//
// Discretisation: BAOAB-style OU update on velocity, applied AFTER the Verlet
// kick. Satisfies fluctuation–dissipation at temperature T with friction γ.
export class ThermostatGroup {
  targetT: number;
  gamma: number;
  indices: number[];
  energyIn = 0;
  energyOut = 0;
  constructor(indices: number[], targetT: number, gamma: number) {
    this.indices = indices.slice();
    this.targetT = targetT;
    this.gamma = gamma;
  }
  apply(sim: Simulation, dt: number, rng: Rng): void {
    // OU update: v_new = c1 * v + c2 * ξ, c1 = exp(-γ dt), c2 = √(T(1-c1²))
    // With m=1, this reproduces Maxwell-Boltzmann at T for a free particle.
    // Any KE gained by v_new-v² is charged to energyIn; lost KE to energyOut.
    const c1 = Math.exp(-this.gamma * dt);
    const c2 = Math.sqrt(this.targetT * (1 - c1 * c1));
    const velX = sim.velX;
    const velY = sim.velY;
    for (const i of this.indices) {
      const vx0 = velX[i]!;
      const vy0 = velY[i]!;
      const ke0 = 0.5 * (vx0 * vx0 + vy0 * vy0);
      const vx = c1 * vx0 + c2 * rng.gauss();
      const vy = c1 * vy0 + c2 * rng.gauss();
      velX[i] = vx;
      velY[i] = vy;
      const ke1 = 0.5 * (vx * vx + vy * vy);
      const dke = ke1 - ke0;
      if (dke >= 0) this.energyIn += dke;
      else this.energyOut += -dke;
    }
  }
}

// Velocity-rescale thermostat — simplest energy-conserving-per-step method
// for equilibration. Do NOT use during a measurement window where you want
// natural energy exchange.
//
// IMPORTANT: pass `indices` for any scenario that has tethered wall atoms
// (or a compressor blade making some atoms cold). Without indices the
// rescale averages over all atoms — wall atoms starting with v=0 pull the
// measured T down, and the correction factor over-scales the gas atoms.
export function rescaleToTemperature(
  sim: Simulation,
  targetT: number,
  indices?: readonly number[]
): void {
  const velX = sim.velX;
  const velY = sim.velY;
  let ke = 0;
  let count = 0;
  if (indices) {
    for (const i of indices) {
      ke += velX[i]! * velX[i]! + velY[i]! * velY[i]!;
      count++;
    }
  } else {
    count = sim.n;
    for (let i = 0; i < count; i++) {
      ke += velX[i]! * velX[i]! + velY[i]! * velY[i]!;
    }
  }
  if (count === 0) return;
  const measuredT = ke / (2 * count);
  if (measuredT <= 0) return;
  const s = Math.sqrt(targetT / measuredT);
  if (indices) {
    for (const i of indices) {
      velX[i] = velX[i]! * s;
      velY[i] = velY[i]! * s;
    }
  } else {
    for (let i = 0; i < count; i++) {
      velX[i] = velX[i]! * s;
      velY[i] = velY[i]! * s;
    }
  }
}

export interface AddAtomOptions {
  kind?: AtomKind;
  homeX?: number;
  homeY?: number;
  tetherK?: number;
}

export class Simulation {
  readonly config: SimulationConfig;
  posX: Float64Array;
  posY: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  accX: Float64Array;
  accY: Float64Array;
  kind: Int8Array;
  homeX: Float64Array;
  homeY: Float64Array;
  tetherK: Float64Array;
  n = 0;
  step = 0;
  time = 0;
  thermostats: ThermostatGroup[] = [];
  movingSegments: MovingSegment[] = [];
  private workScratch = { vx: 0, vy: 0 };
  private rng: Rng | null = null;
  private cells: CellList;
  private rCut2: number;
  private uShift: number;
  private lastPE = 0;
  private barrierAcc: BarrierAccumulator = { fx: 0, fy: 0, u: 0 };

  constructor(config: SimulationConfig) {
    this.config = config;
    const cap = config.capacity;
    this.posX = new Float64Array(cap);
    this.posY = new Float64Array(cap);
    this.velX = new Float64Array(cap);
    this.velY = new Float64Array(cap);
    this.accX = new Float64Array(cap);
    this.accY = new Float64Array(cap);
    this.kind = new Int8Array(cap);
    this.homeX = new Float64Array(cap);
    this.homeY = new Float64Array(cap);
    this.tetherK = new Float64Array(cap);
    const rc = effectiveCutoff(config.potential);
    this.rCut2 = rc * rc;
    this.uShift = shiftEnergy(config.potential);
    this.cells = new CellList(config.domain, rc, cap);
  }

  setRng(rng: Rng): void {
    this.rng = rng;
  }

  addAtom(x: number, y: number, vx: number, vy: number, opts?: AddAtomOptions): number {
    if (this.n >= this.config.capacity) throw new Error("capacity exceeded");
    const i = this.n++;
    this.posX[i] = x;
    this.posY[i] = y;
    this.velX[i] = vx;
    this.velY[i] = vy;
    this.accX[i] = 0;
    this.accY[i] = 0;
    this.kind[i] = opts?.kind ?? 0;
    this.homeX[i] = opts?.homeX ?? 0;
    this.homeY[i] = opts?.homeY ?? 0;
    this.tetherK[i] = opts?.tetherK ?? 0;
    return i;
  }

  clear(): void {
    this.n = 0;
    this.step = 0;
    this.time = 0;
    this.lastPE = 0;
    this.thermostats = [];
  }

  // velocity Verlet (kick-drift-kick) + Langevin thermostat step after kick.
  // Tethered atoms follow the same Verlet loop but their pinning force is
  // added by computeForces() so they can't drift off their lattice sites.
  advance(steps = 1): void {
    const dt = this.config.dt;
    for (let s = 0; s < steps; s++) {
      const halfDt = 0.5 * dt;
      const posX = this.posX;
      const posY = this.posY;
      const velX = this.velX;
      const velY = this.velY;
      const accX = this.accX;
      const accY = this.accY;
      const n = this.n;
      for (let i = 0; i < n; i++) {
        const vx = velX[i]! + halfDt * accX[i]!;
        const vy = velY[i]! + halfDt * accY[i]!;
        velX[i] = vx;
        velY[i] = vy;
        posX[i] = posX[i]! + vx * dt;
        posY[i] = posY[i]! + vy * dt;
      }
      // Advance moving segments so they're at t+dt before force evaluation.
      for (const m of this.movingSegments) m.advance(dt);
      this.computeForces();
      for (let i = 0; i < n; i++) {
        velX[i] = velX[i]! + halfDt * accX[i]!;
        velY[i] = velY[i]! + halfDt * accY[i]!;
      }
      // Langevin — applied after velocity is complete. Fluctuation-dissipation
      // guarantees the thermostatted atoms' velocity distribution converges to
      // Maxwell-Boltzmann at their target T over time. Energy bookkeeping is
      // maintained by the ThermostatGroup itself.
      if (this.thermostats.length > 0) {
        if (!this.rng) throw new Error("thermostats present but rng not set — call setRng()");
        for (const t of this.thermostats) t.apply(this, dt, this.rng);
      }
      this.step++;
      this.time += dt;
    }
  }

  private computeForces(): void {
    const accX = this.accX;
    const accY = this.accY;
    const posX = this.posX;
    const posY = this.posY;
    const kind = this.kind;
    const tetherK = this.tetherK;
    const homeX = this.homeX;
    const homeY = this.homeY;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      accX[i] = 0;
      accY[i] = 0;
    }
    let pe = 0;
    const p = this.config.potential;
    this.cells.build(posX, posY, n);
    const rCut2 = this.rCut2;
    const uShift = this.uShift;
    // Pair forces — apply to ALL kinds (wall atoms interact with refrigerant
    // via the same LJ pair force, which is how thermal conduction happens).
    this.cells.forEachPair((i, j) => {
      const rx = posX[i]! - posX[j]!;
      const ry = posY[i]! - posY[j]!;
      const r2 = rx * rx + ry * ry;
      if (r2 >= rCut2 || r2 === 0) return;
      const { u, k } = pairForce(r2, p, uShift, rCut2);
      accX[i] = accX[i]! + k * rx;
      accY[i] = accY[i]! + k * ry;
      accX[j] = accX[j]! - k * rx;
      accY[j] = accY[j]! - k * ry;
      pe += u;
    });
    // Line-segment barriers — skip tethered atoms (kind===1). This is the
    // "coincident barrier + excluded wall atoms" trick that makes an
    // atom-based wall thermally conductive but leak-proof.
    const segs = this.config.segments;
    if (segs.length > 0) {
      const acc = this.barrierAcc;
      for (let i = 0; i < n; i++) {
        if (kind[i]! !== 0) continue;
        accumulateBarrierForce(posX[i]!, posY[i]!, segs, acc);
        accX[i] = accX[i]! + acc.fx;
        accY[i] = accY[i]! + acc.fy;
        pe += acc.u;
      }
    }
    // Moving segments (compressor blades). These do work on the gas — the
    // rate is F_on_atom · v_blade at each contact, accumulated into
    // MovingSegment.workInput. See notes in movingSegment.ts.
    for (const m of this.movingSegments) {
      pe += m.applyForce(this, this.config.dt, this.workScratch);
    }
    // Tether springs — F = -k(r - home), U = ½ k (r - home)².
    for (let i = 0; i < n; i++) {
      const k = tetherK[i]!;
      if (k === 0) continue;
      const dx = posX[i]! - homeX[i]!;
      const dy = posY[i]! - homeY[i]!;
      accX[i] = accX[i]! - k * dx;
      accY[i] = accY[i]! - k * dy;
      pe += 0.5 * k * (dx * dx + dy * dy);
    }
    this.lastPE = pe;
  }

  diagnostics(): Diagnostics {
    let ke = 0;
    let px = 0;
    let py = 0;
    const velX = this.velX;
    const velY = this.velY;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const vx = velX[i]!;
      const vy = velY[i]!;
      ke += 0.5 * (vx * vx + vy * vy);
      px += vx;
      py += vy;
    }
    const dof = 2 * this.n;
    const temperature = dof > 0 ? (2 * ke) / dof : 0;
    const pe = this.lastPE;
    return {
      step: this.step,
      time: this.time,
      kineticEnergy: ke,
      potentialEnergy: pe,
      totalEnergy: ke + pe,
      temperature,
      momentumX: px,
      momentumY: py,
    };
  }

  // Sum kinetic energy over a specified atom-index set. Used to measure the
  // temperature of individual regions (hot side vs cold side vs refrigerant).
  temperatureOf(indices: readonly number[]): number {
    if (indices.length === 0) return 0;
    let ke = 0;
    for (const i of indices) {
      ke += this.velX[i]! * this.velX[i]! + this.velY[i]! * this.velY[i]!;
    }
    return ke / (2 * indices.length);
  }

  primeForces(): void {
    this.computeForces();
  }

  setSegments(segments: LineSegment[]): void {
    (this.config as { segments: LineSegment[] }).segments = segments;
    this.primeForces();
  }
}
