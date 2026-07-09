import type { Diagnostics, Domain, LineSegment, PotentialParams } from "./types";
import { effectiveCutoff, pairForce, shiftEnergy } from "./potential";
import { CellList } from "./cellList";
import { accumulateBarrierForce, type BarrierAccumulator } from "./barriers";

// Reduced (LJ) units: masses = 1, ε and σ are the natural scales.
// Temperature is defined by <KE> = (d/2) N k_B T with d=2, k_B=1, so
//   T = <v^2>  (mean of v_i·v_i over atoms).

export interface SimulationConfig {
  domain: Domain;
  potential: PotentialParams;
  segments: LineSegment[];
  dt: number;
  capacity: number;
}

export class Simulation {
  readonly config: SimulationConfig;
  posX: Float64Array;
  posY: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  accX: Float64Array;
  accY: Float64Array;
  n = 0;
  step = 0;
  time = 0;
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
    const rc = effectiveCutoff(config.potential);
    this.rCut2 = rc * rc;
    this.uShift = shiftEnergy(config.potential);
    this.cells = new CellList(config.domain, rc, cap);
  }

  addAtom(x: number, y: number, vx: number, vy: number): void {
    if (this.n >= this.config.capacity) throw new Error("capacity exceeded");
    const i = this.n++;
    this.posX[i] = x;
    this.posY[i] = y;
    this.velX[i] = vx;
    this.velY[i] = vy;
    this.accX[i] = 0;
    this.accY[i] = 0;
  }

  clear(): void {
    this.n = 0;
    this.step = 0;
    this.time = 0;
    this.lastPE = 0;
  }

  // velocity Verlet (kick-drift-kick)
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
      this.computeForces();
      for (let i = 0; i < n; i++) {
        velX[i] = velX[i]! + halfDt * accX[i]!;
        velY[i] = velY[i]! + halfDt * accY[i]!;
      }
      this.step++;
      this.time += dt;
    }
  }

  // Compute a = F/m (m=1). Rebuilds cell list, runs pair loop, adds barriers.
  private computeForces(): void {
    const accX = this.accX;
    const accY = this.accY;
    const posX = this.posX;
    const posY = this.posY;
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
    const segs = this.config.segments;
    if (segs.length > 0) {
      const acc = this.barrierAcc;
      for (let i = 0; i < n; i++) {
        accumulateBarrierForce(posX[i]!, posY[i]!, segs, acc);
        accX[i] = accX[i]! + acc.fx;
        accY[i] = accY[i]! + acc.fy;
        pe += acc.u;
      }
    }
    this.lastPE = pe;
  }

  // Diagnostics — total KE, PE, T, momentum. PE is the value from the last
  // force pass (Verlet's F(x_new) call), consistent with the velocity that
  // advance() just wrote — energy check is meaningful at end of advance().
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

  // For test/init convenience: precompute forces so first diagnostics() call
  // has a valid PE, and Verlet's first drift uses the correct acceleration.
  primeForces(): void {
    this.computeForces();
  }
}
