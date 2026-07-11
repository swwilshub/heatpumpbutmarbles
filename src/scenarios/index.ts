import { Simulation, ThermostatGroup, rescaleToTemperature } from "../sim/simulation";
import { seedLattice } from "../sim/init";
import { Rng } from "../sim/rng";
import { addHeatExchanger } from "../sim/heatExchanger";
import { MovingSegment } from "../sim/movingSegment";
import type { LineSegment, PotentialParams } from "../sim/types";
import type {
  RegionOverlay as RendererRegion,
  PartSchematic,
} from "../render/canvasRenderer";
import type { UnitAnchors } from "../units";
import { DEFAULT_ANCHORS } from "../units";

// A "temperature" value returns a T* number the UI formats using the
// scenario's unit anchors + the current UnitMode (°C default, °F, or T*).
// A "raw" value returns a pre-formatted string (energy, count, position…).
export type ReadoutValue =
  | { kind: "temperature"; value: () => number }
  | { kind: "raw"; value: () => string };

export interface Readout {
  label: string;
  v: ReadoutValue;
}
export interface Region {
  label: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  v?: ReadoutValue;
  tint?: string;
  tintByT?: () => number;
  tintByTAlpha?: number;
}

// Helper constructors so scenario code stays readable.
export const T = (fn: () => number): ReadoutValue => ({ kind: "temperature", value: fn });
export const R = (fn: () => string): ReadoutValue => ({ kind: "raw", value: fn });

// Push-button action exposed by a scenario — a discrete "do this now"
// operation, distinct from continuous sliders. Used for the HVAC-style
// charge / vacuum buttons in the phases demo.
export interface ScenarioAction {
  id: string;
  label: string;
  onClick: () => void;
}

// Live sliders exposed by a scenario. The UI renders them as range inputs
// and pipes changes back through `onChange`. This is the "assemble a heat
// pump by dialling in the parts" experience — full drag-and-drop is on the
// roadmap; parameter tuning is the immediate 80% of the value.
export interface ScenarioSlider {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  // Optional friendly formatting for the displayed value.
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

// One line of the T-history plot in the sidebar. Value fn returns a T* the
// UI converts to °C using the scenario's anchors.
export interface ScenarioSeries {
  name: string;
  colour: string;
  value: () => number;
}

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  build: () => {
    sim: Simulation;
    tick: (step: number) => void;
    readouts?: Readout[];
    regions?: Region[];
    unitAnchors?: UnitAnchors;
    cMin?: number;
    cMax?: number;
    sliders?: ScenarioSlider[];
    actions?: ScenarioAction[];
    parts?: PartSchematic[];
    series?: ScenarioSeries[];
    // Extended explainer HTML shown at the bottom of the scenario panel.
    // Used by pedagogical demos (phases, HVAC charge) to walk the user
    // through what to try.
    explainer?: string;
  };
}

// Region-mean T from smoothed v² over atoms currently inside a bounding box.
// smoothedV2 tames the exponential fluctuation you get from raw v², so the
// tint doesn't strobe. Wall atoms (kind=1) are excluded — the box is about
// the *gas* in the region, not the coil.
export function meanTInBox(
  sim: Simulation,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number
): number {
  let sum = 0;
  let count = 0;
  const posX = sim.posX;
  const posY = sim.posY;
  const sv2 = sim.smoothedV2;
  const kind = sim.kind;
  const n = sim.n;
  for (let i = 0; i < n; i++) {
    if (kind[i] !== 0) continue;
    const x = posX[i]!;
    const y = posY[i]!;
    if (x < xMin || x > xMax || y < yMin || y > yMax) continue;
    sum += sv2[i]!;
    count++;
  }
  return count > 0 ? sum / (2 * count) : 0;
}

// Renderer wants its own Region shape (with a `value: () => string`). We
// bridge on the main-loop side by capturing the current UnitMode.
export function regionToRenderer(
  r: Region,
  fmt: (t: number) => string
): RendererRegion {
  return {
    label: r.label,
    xMin: r.xMin,
    yMin: r.yMin,
    xMax: r.xMax,
    yMax: r.yMax,
    tint: r.tint,
    tintByT: r.tintByT,
    tintByTAlpha: r.tintByTAlpha,
    value: r.v
      ? r.v.kind === "temperature"
        ? () => fmt(r.v!.value() as number)
        : () => r.v!.value() as string
      : undefined,
  };
}

// Silence unused-import — DEFAULT_ANCHORS is re-exported for scenario code.
export { DEFAULT_ANCHORS };

function box(x0: number, y0: number, x1: number, y1: number, sigma = 1): LineSegment[] {
  return [
    { ax: x0, ay: y0, bx: x1, by: y0, epsilon: 1, sigma },
    { ax: x1, ay: y0, bx: x1, by: y1, epsilon: 1, sigma },
    { ax: x1, ay: y1, bx: x0, by: y1, epsilon: 1, sigma },
    { ax: x0, ay: y1, bx: x0, by: y0, epsilon: 1, sigma },
  ];
}

const DEFAULT_POT_LJ: PotentialParams = { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 };
const DEFAULT_POT_WCA: PotentialParams = { kind: "wca", epsilon: 1, sigma: 1, rCut: 2.5 };

function confined(potential: PotentialParams, targetT: number): Scenario["build"] {
  return () => {
    const sim = new Simulation({
      domain: { xMin: 0, yMin: 0, xMax: 30, yMax: 22 },
      potential,
      segments: box(1, 1, 29, 21),
      dt: 0.005,
      capacity: 2000,
    });
    seedLattice(sim, { xMin: 3, yMin: 3, xMax: 27, yMax: 19 }, 1.2, targetT, new Rng(2024));
    sim.primeForces();
    return {
      sim,
      tick: (step: number) => {
        if (step < 400 && step % 50 === 0 && step > 0) rescaleToTemperature(sim, targetT);
      },
      regions: [
        {
          label: "gas",
          xMin: 3,
          yMin: 3,
          xMax: 27,
          yMax: 19,
          v: T(() => sim.diagnostics().temperature),
        },
      ],
    };
  };
}

function freeExpansion(
  potential: PotentialParams,
  targetT: number,
  smallSize: number,
  largeSize: number,
  spacing: number,
  releaseAtStep: number
): Scenario["build"] {
  return () => {
    const domain = {
      xMin: -1,
      yMin: -1,
      xMax: largeSize + 1,
      yMax: largeSize + 1,
    };
    const sim = new Simulation({
      domain,
      potential,
      segments: box(0, 0, smallSize, smallSize),
      dt: 0.004,
      capacity: 2000,
    });
    seedLattice(
      sim,
      { xMin: 0.5, yMin: 0.5, xMax: smallSize - 0.5, yMax: smallSize - 0.5 },
      spacing,
      targetT,
      new Rng(4242)
    );
    sim.primeForces();
    let released = false;
    return {
      sim,
      tick: (step: number) => {
        if (!released) {
          if (step % 50 === 0 && step > 0) rescaleToTemperature(sim, targetT);
          if (step >= releaseAtStep) {
            sim.setSegments(box(0, 0, largeSize, largeSize));
            released = true;
          }
        }
      },
      regions: [
        {
          label: "gas",
          xMin: 0,
          yMin: 0,
          xMax: largeSize,
          yMax: largeSize,
          v: T(() => sim.diagnostics().temperature),
        },
      ],
    };
  };
}

// Assembles a compressor + hot exchanger + hot reservoir into a demo that
// shows all M3 components together. Not a closed refrigeration loop —
// that's the M4 work — but demonstrates real work input, real heat
// absorption by a thermostatted reservoir, and the expected T rise on
// compression.
function compressorHotExchanger(): Scenario["build"] {
  return () => {
    const T_RESERVOIR = 0.5;
    const T_GAS = 1.2;
    // Chamber: LEFT wall replaced by a vertical heat-exchanger. Piston is a
    // full-height vertical segment on the right that reciprocates left/right.
    // Full-height piston avoids the gap-around-the-piston leak that a shorter
    // piston has, and putting the exchanger on the left keeps the piston's
    // travel path clear of the tethered wall atoms.
    const CH_W = 28;
    const CH_H = 12;
    const chamber: LineSegment[] = [
      { ax: 0, ay: 0, bx: CH_W, by: 0, epsilon: 1, sigma: 1 },     // bottom
      { ax: CH_W, ay: 0, bx: CH_W, by: CH_H, epsilon: 1, sigma: 1 }, // right
      { ax: CH_W, ay: CH_H, bx: 0, by: CH_H, epsilon: 1, sigma: 1 }, // top
      // no left wall — the exchanger's barrier takes its place
    ];
    const sim = new Simulation({
      domain: { xMin: -3, yMin: -1, xMax: CH_W + 1, yMax: CH_H + 1 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: chamber,
      dt: 0.004,
      capacity: 800,
    });
    sim.setRng(new Rng(7));
    seedLattice(sim, { xMin: 2, yMin: 1, xMax: 22, yMax: CH_H - 1 }, 1.25, T_GAS, new Rng(11));
    const gasIdx: number[] = [];
    for (let i = 0; i < sim.n; i++) gasIdx.push(i);
    // Heat exchanger — vertical line at x=0, layers at x=0.5 (inside, exposed
    // to gas) and x=-0.5 (outside, in the "reservoir" tint area).
    const hx = addHeatExchanger(sim, {
      ax: 0,
      ay: 0.5,
      bx: 0,
      by: CH_H - 0.5,
      spacing: 1.15,
      layers: 2,
      layerOffset: 1.0,
      tetherK: 40,
      sigma: 1,
      epsilon: 1,
    });
    chamber.push(hx.barrier);
    const thermostat = new ThermostatGroup(hx.atomIndices, T_RESERVOIR, 0.8);
    sim.thermostats.push(thermostat);
    // Full-height piston — a vertical segment spanning the whole chamber
    // interior. σ = 1.2 (a bit thicker than default) so no atom can squeeze
    // past between the endpoint and the top/bottom walls.
    const PISTON_SPEED = 0.6;
    const PISTON_LEFT = 10;
    const PISTON_RIGHT = 24;
    const piston = new MovingSegment({
      ax: PISTON_RIGHT, ay: 0, bx: PISTON_RIGHT, by: CH_H,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1.2,
    });
    sim.movingSegments.push(piston);
    sim.primeForces();
    let started = false;
    return {
      sim,
      tick: (step: number) => {
        if (step < 200 && step % 25 === 0 && step > 0) {
          rescaleToTemperature(sim, T_GAS, gasIdx);
        }
        if (!started && step >= 200) {
          started = true;
          piston.vax = -PISTON_SPEED;
          piston.vbx = -PISTON_SPEED;
          piston.workInput = 0;
          thermostat.energyIn = 0;
          thermostat.energyOut = 0;
        }
        if (started) {
          if (piston.ax < PISTON_LEFT && piston.vax < 0) {
            piston.vax = PISTON_SPEED;
            piston.vbx = PISTON_SPEED;
          } else if (piston.ax > PISTON_RIGHT && piston.vax > 0) {
            piston.vax = -PISTON_SPEED;
            piston.vbx = -PISTON_SPEED;
          }
        }
      },
      regions: [
        {
          label: "reservoir",
          xMin: -3,
          yMin: 0,
          xMax: 0,
          yMax: CH_H,
          tint: "rgba(70,130,180,0.10)",
        },
        {
          label: "gas",
          xMin: 3,
          yMin: 0.5,
          xMax: PISTON_RIGHT,
          yMax: CH_H - 0.5,
          v: T(() => sim.temperatureOf(gasIdx)),
        },
      ],
      readouts: [
        {
          label: "reservoir target",
          v: T(() => T_RESERVOIR),
        },
        {
          label: "wall (measured)",
          v: T(() => sim.temperatureOf(hx.atomIndices)),
        },
        {
          label: "W (piston work in)",
          v: R(() => (started ? piston.workInput.toFixed(2) : "—")),
        },
        {
          label: "Q_hot (heat to reservoir)",
          v: R(() =>
            started ? (thermostat.energyOut - thermostat.energyIn).toFixed(2) : "—"
          ),
        },
        {
          label: "COP (Q_hot / W)",
          v: R(() => {
            if (!started || piston.workInput <= 0) return "—";
            return (
              (thermostat.energyOut - thermostat.energyIn) / piston.workInput
            ).toFixed(2);
          }),
        },
        {
          label: "piston x",
          v: R(() => piston.ax.toFixed(1)),
        },
      ],
    };
  };
}

// A single-box gas / liquid / crystal demo. Refrigerant atoms alone in a
// closed box, thermostatted to a user-selectable temperature via a
// Langevin coupling applied every step to the free atoms.
//
// Drop T past the LJ freezing point (T* ≈ 0.4 in 2D at reasonable density)
// and you get a real triangular lattice out of the physics — atoms find
// their equilibrium spacing at r_min = 2^(1/6)σ and lock into a crystal.
// Raise T past the boiling point and the same atoms spread out into a gas.
// Between those, liquid: dense but disordered, atoms sliding past each
// other.
//
// Pressure is measured from the virial equation: P = (N T + Σ r·F / d) / V.
// The interaction term is what makes the LJ pressure differ from the ideal
// gas — at low T with attractive well active, pressure DROPS below N T / V
// because atoms are pulling each other in.
//
// HVAC-style charge/vacuum: two action buttons let you add or remove
// marbles in chunks, mimicking a technician charging refrigerant into an
// evacuated system.
function phases(): Scenario["build"] {
  return () => {
    // Custom anchors — the phase transitions we're demoing land at very
    // different reduced temperatures than the heat-pump loops (T* < 0.5 is
    // solid, T* > 1.5 is gas), so anchor the °C scale so those points fall
    // in a range users find intuitive.
    const anchors: UnitAnchors = {
      t1_star: 0.3, t1_celsius: -80,
      t2_star: 2.0, t2_celsius: 200,
    };
    const cToT = (c: number) => {
      const m = (anchors.t2_star - anchors.t1_star) / (anchors.t2_celsius - anchors.t1_celsius);
      return anchors.t1_star + m * (c - anchors.t1_celsius);
    };
    const state = {
      targetC: 60, // °C
      targetN: 240, // how many marbles the user wants in the box
    };
    const BOX = 22;
    const sim = new Simulation({
      domain: { xMin: -1, yMin: -1, xMax: BOX + 1, yMax: BOX + 1 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: box(0, 0, BOX, BOX),
      dt: 0.004,
      capacity: 600,
    });
    const rng = new Rng(2601);
    sim.setRng(rng);
    // Initial seed: fill the box at a moderate density.
    seedLattice(sim, { xMin: 1, yMin: 1, xMax: BOX - 1, yMax: BOX - 1 }, 1.25, cToT(state.targetC), rng);
    sim.primeForces();

    // Langevin coupling applied inside tick() so it stays live even as the
    // atom count changes. Standard OU update on each free atom's velocity.
    const gamma = 1.2;
    const chargeRng = new Rng(9911);
    const tryPlaceAtom = (targetT: number): boolean => {
      // Try up to 30 random positions to place a new atom without dropping
      // it inside another atom's WCA cutoff. If we can't find a spot the
      // box is essentially full and the "charge" button silently no-ops.
      const posX = sim.posX;
      const posY = sim.posY;
      const kind = sim.kind;
      const rCutSq = 1.1 * 1.1; // slightly beyond WCA cutoff (1.122σ)
      for (let attempt = 0; attempt < 30; attempt++) {
        const x = 1 + chargeRng.next() * (BOX - 2);
        const y = 1 + chargeRng.next() * (BOX - 2);
        let ok = true;
        for (let i = 0; i < sim.n; i++) {
          if (kind[i] !== 0) continue;
          const dx = posX[i]! - x;
          const dy = posY[i]! - y;
          if (dx * dx + dy * dy < rCutSq) {
            ok = false;
            break;
          }
        }
        if (ok) {
          const sigma = Math.sqrt(Math.max(0.05, targetT));
          const vx = sigma * chargeRng.gauss();
          const vy = sigma * chargeRng.gauss();
          sim.addAtom(x, y, vx, vy);
          return true;
        }
      }
      return false;
    };

    const tick = (step: number) => {
      // Langevin every step over the current gas atoms.
      const dt = sim.config.dt;
      const targetT = cToT(state.targetC);
      const c1 = Math.exp(-gamma * dt);
      const c2 = Math.sqrt(Math.max(0, targetT) * (1 - c1 * c1));
      const velX = sim.velX;
      const velY = sim.velY;
      const kind = sim.kind;
      for (let i = 0; i < sim.n; i++) {
        if (kind[i] !== 0) continue;
        velX[i] = c1 * velX[i]! + c2 * rng.gauss();
        velY[i] = c1 * velY[i]! + c2 * rng.gauss();
      }
      // Gently move actual N toward targetN — one atom per ~10 steps so the
      // slider feels continuous rather than juddery.
      if (step % 6 === 0) {
        if (sim.n < state.targetN) {
          tryPlaceAtom(targetT);
        } else if (sim.n > state.targetN) {
          sim.popAtom();
        }
      }
    };

    // Box area — used both for the on-screen density readout and for the
    // pressure denominator (we don't want the reservoir strips diluting it).
    const boxArea = BOX * BOX;

    return {
      sim,
      tick,
      unitAnchors: anchors,
      cMin: -80,
      cMax: 200,
      regions: [
        {
          label: "",
          xMin: 0, yMin: 0, xMax: BOX, yMax: BOX,
          tintByT: () => {
            // Region tint uses the RUNNING measured T so the box glows
            // colder/hotter as it responds to the slider, not just showing
            // the setpoint.
            const d = sim.diagnostics();
            return d.temperature;
          },
          tintByTAlpha: 0.30,
        },
      ],
      readouts: [
        {
          label: "setpoint",
          v: T(() => cToT(state.targetC)),
        },
        {
          label: "measured T",
          v: T(() => sim.diagnostics().temperature),
        },
        {
          label: "pressure",
          v: R(() => sim.pressure(boxArea).toFixed(3)),
        },
        {
          label: "density (marbles / area)",
          v: R(() => (sim.n / boxArea).toFixed(3)),
        },
        {
          label: "marbles",
          v: R(() => String(sim.n)),
        },
      ],
      series: [
        { name: "T (measured)", colour: "#e07a5f", value: () => sim.diagnostics().temperature },
        { name: "T (setpoint)", colour: "rgba(224,122,95,0.35)", value: () => cToT(state.targetC) },
      ],
      sliders: [
        {
          id: "temperature",
          label: "temperature",
          min: -80, max: 200, step: 1, initial: state.targetC,
          format: (v) => `${v.toFixed(0)} °C`,
          onChange: (v) => { state.targetC = v; },
        },
        {
          id: "charge",
          label: "charge (marbles in the box)",
          min: 0, max: 400, step: 5, initial: state.targetN,
          format: (v) => `${v.toFixed(0)} marbles`,
          onChange: (v) => { state.targetN = v; },
        },
      ],
      actions: [
        {
          id: "charge_20",
          label: "＋ charge 20",
          onClick: () => {
            state.targetN = Math.min(400, state.targetN + 20);
          },
        },
        {
          id: "vacuum",
          label: "− vacuum (all)",
          onClick: () => {
            state.targetN = 0;
          },
        },
        {
          id: "reseed",
          label: "🌡 reseed at setpoint",
          onClick: () => {
            // Rescale velocities of all free atoms to the setpoint — useful
            // when the user wants an instant temperature change without
            // waiting for the Langevin to settle.
            const t = cToT(state.targetC);
            const sigma = Math.sqrt(Math.max(0.05, t));
            const kind = sim.kind;
            for (let i = 0; i < sim.n; i++) {
              if (kind[i] !== 0) continue;
              sim.velX[i] = sigma * rng.gauss();
              sim.velY[i] = sigma * rng.gauss();
            }
          },
        },
      ],
      explainer: [
        "<p><strong>What to try:</strong></p>",
        "<ul style='margin:4px 0 0 0;padding-left:18px'>",
        "<li>Drop the temperature to <strong>−60 °C</strong> and watch the marbles cluster then settle into a triangular crystal — that's the Lennard-Jones potential's equilibrium spacing snapping into place.</li>",
        "<li>Raise it to <strong>+150 °C</strong> and the same marbles spread out into a gas. Around <strong>0–30 °C</strong> you'll get a liquid — dense but disordered, sliding past itself.</li>",
        "<li>Watch the <strong>pressure</strong> reading: below room-temp it can go negative (attractive LJ well pulling atoms in beats the kinetic term). That's what says \"liquid, not gas\".</li>",
        "<li><strong>Vacuum</strong> the box down and pressure drops to nearly zero. <strong>Charge</strong> more marbles in and pressure climbs — the same principles an HVAC technician uses to check a refrigerant charge with a manifold gauge.</li>",
        "</ul>",
      ].join(""),
    };
  };
}

// Sandbox — the "builder mode" MVP. A reciprocating piston shuttles gas
// between a hot exchanger (condenser side, top) and a cold exchanger
// (evaporator side, bottom). Live sliders let the user tune the parts a
// full drag-and-drop builder would let them drop in:
//   - compressor speed
//   - outdoor & indoor fan strength (Langevin γ on each exchanger)
//   - hot & cold reservoir setpoints in °C
//   - refrigerant charge (triggers soft-restart to re-seed atoms)
//   - insulation on/off (extra insulating barrier around the pipes)
function sandbox(): Scenario["build"] {
  return () => {
    // Sandbox: a single-chamber CONDENSER-side heat pump. The refrigerant
    // is compressed against a heat-exchanger wall on the left, whose
    // Langevin-thermostatted wall atoms represent the outside coil giving
    // heat to a reservoir (the "outdoors" for a room-cooling AC, or the
    // "indoors" for a heating heat pump — depends how you interpret it,
    // but the physics is one-sided).
    //
    // Live sliders expose:
    //   - compressor speed
    //   - fan strength (Langevin γ on the exchanger)
    //   - reservoir target T
    //   - refrigerant charge (soft-restart on change)
    //
    // A full closed refrigeration loop (both condenser AND evaporator, in
    // series, with atoms circulating) is future work — a two-exchanger
    // reciprocating design keeps colliding the piston with the wall atoms.
    // The trade-off here is honesty: one side, but real dynamics, real
    // work accounting, and real heat flow.
    const CH_W = 28;
    const CH_H = 12;
    const state = {
      pistonSpeed: 0.5,
      fanStrength: 1.5,
      reservoirC: 25, // condenser side default: room-temp indoors
      charge: 130,
    };
    const chamber: LineSegment[] = [
      { ax: 0, ay: 0, bx: CH_W, by: 0, epsilon: 1, sigma: 1 },
      { ax: CH_W, ay: 0, bx: CH_W, by: CH_H, epsilon: 1, sigma: 1 },
      { ax: CH_W, ay: CH_H, bx: 0, by: CH_H, epsilon: 1, sigma: 1 },
    ];
    const sim = new Simulation({
      domain: { xMin: -3, yMin: -1, xMax: CH_W + 1, yMax: CH_H + 1 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: chamber,
      dt: 0.004,
      capacity: 800,
    });
    sim.setRng(new Rng(31));
    // Density from charge count. Simple heuristic — try to fit ~charge atoms
    // in the seed region by adjusting spacing.
    const seedRegion = { xMin: 2, yMin: 1, xMax: 22, yMax: CH_H - 1 };
    const area = (seedRegion.xMax - seedRegion.xMin) * (seedRegion.yMax - seedRegion.yMin);
    const spacing = Math.max(1.05, Math.min(1.6, Math.sqrt(area / state.charge)));
    seedLattice(sim, seedRegion, spacing, 1.0, new Rng(97));
    const gasIdx: number[] = [];
    for (let i = 0; i < sim.n; i++) gasIdx.push(i);
    // Condenser exchanger — vertical wall replacing the left side.
    const cond = addHeatExchanger(sim, {
      ax: 0, ay: 0.5, bx: 0, by: CH_H - 0.5,
      spacing: 1.15, layers: 2, layerOffset: 1.0,
      tetherK: 40, sigma: 1, epsilon: 1,
    });
    chamber.push(cond.barrier);
    const anchors: UnitAnchors = { ...DEFAULT_ANCHORS };
    const cToT = (c: number) => {
      const m = (anchors.t2_star - anchors.t1_star) / (anchors.t2_celsius - anchors.t1_celsius);
      return anchors.t1_star + m * (c - anchors.t1_celsius);
    };
    const condTherm = new ThermostatGroup(cond.atomIndices, cToT(state.reservoirC), state.fanStrength);
    sim.thermostats.push(condTherm);
    // Piston — full-height vertical segment on the right.
    const piston = new MovingSegment({
      ax: CH_W - 4, ay: 0, bx: CH_W - 4, by: CH_H,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1.2,
    });
    sim.movingSegments.push(piston);
    sim.primeForces();
    const PISTON_LEFT = 8;
    const PISTON_RIGHT = CH_W - 4;
    let started = false;
    const tick = (step: number) => {
      if (step < 200 && step % 25 === 0 && step > 0) {
        rescaleToTemperature(sim, 1.0, gasIdx);
      }
      if (!started && step >= 200) {
        started = true;
        piston.vax = -state.pistonSpeed;
        piston.vbx = -state.pistonSpeed;
        piston.workInput = 0;
        condTherm.energyIn = 0; condTherm.energyOut = 0;
      }
      if (started) {
        if (piston.ax < PISTON_LEFT && piston.vax < 0) {
          piston.vax = state.pistonSpeed; piston.vbx = state.pistonSpeed;
        } else if (piston.ax > PISTON_RIGHT && piston.vax > 0) {
          piston.vax = -state.pistonSpeed; piston.vbx = -state.pistonSpeed;
        }
      }
    };
    return {
      sim,
      tick,
      unitAnchors: anchors,
      regions: [
        // Reservoir strip — dynamic tint tracks the coil's actual temperature.
        {
          label: "",
          xMin: -3, yMin: 0, xMax: 0, yMax: CH_H,
          tintByT: () => sim.temperatureOf(cond.atomIndices),
          tintByTAlpha: 0.32,
        },
        // Chamber background — dynamic tint from mean gas T.
        {
          label: "",
          xMin: 0, yMin: 0, xMax: PISTON_RIGHT, yMax: CH_H,
          tintByT: () => sim.temperatureOf(gasIdx),
        },
        {
          label: "refrigerant",
          xMin: 2, yMin: 0.5, xMax: PISTON_RIGHT, yMax: CH_H - 0.5,
          v: T(() => sim.temperatureOf(gasIdx)),
        },
      ],
      readouts: [
        {
          label: "coil temperature",
          v: T(() => sim.temperatureOf(cond.atomIndices)),
        },
        {
          label: "gas temperature",
          v: T(() => sim.temperatureOf(gasIdx)),
        },
        {
          label: "electricity used",
          v: R(() => (started ? piston.workInput.toFixed(1) : "—")),
        },
        {
          label: "heat delivered",
          v: R(() =>
            started ? (condTherm.energyOut - condTherm.energyIn).toFixed(1) : "—"
          ),
        },
        {
          label: "efficiency (COP)",
          v: R(() => {
            if (!started || piston.workInput <= 0) return "—";
            return (
              (condTherm.energyOut - condTherm.energyIn) / piston.workInput
            ).toFixed(2);
          }),
        },
      ],
      series: [
        { name: "coil", colour: "#e07a5f", value: () => sim.temperatureOf(cond.atomIndices) },
        { name: "gas", colour: "#f0c060", value: () => sim.temperatureOf(gasIdx) },
        { name: "setpoint", colour: "#7091b8", value: () => cToT(state.reservoirC) },
      ],
      sliders: [
        {
          id: "pistonSpeed",
          label: "compressor speed",
          min: 0.0, max: 1.2, step: 0.05, initial: state.pistonSpeed,
          format: (v) => v.toFixed(2),
          onChange: (v) => {
            const sign = piston.vax === 0 ? -1 : Math.sign(piston.vax);
            state.pistonSpeed = v;
            piston.vax = sign * v;
            piston.vbx = sign * v;
          },
        },
        {
          id: "fan",
          label: "fan strength (γ)",
          min: 0.05, max: 5.0, step: 0.05, initial: state.fanStrength,
          format: (v) =>
            v < 0.15 ? `${v.toFixed(2)}  (off)` : v > 3.5 ? `${v.toFixed(2)}  (max)` : v.toFixed(2),
          onChange: (v) => {
            state.fanStrength = v;
            condTherm.gamma = v;
          },
        },
        {
          id: "reservoirC",
          label: "reservoir T (°C)",
          min: -30, max: 60, step: 1, initial: state.reservoirC,
          format: (v) => `${v.toFixed(0)} °C`,
          onChange: (v) => {
            state.reservoirC = v;
            condTherm.targetT = cToT(v);
          },
        },
      ],
      parts: [
        { kind: "coil", x: 2, y: CH_H - 0.6, label: "coil" },
        // Reservoir label — placed at the bottom of the tint strip so it
        // doesn't collide with the coil label at the top.
        { kind: "label", x: -1.5, y: 0.8, label: "reservoir" },
        // Fan indicator sits in the reservoir tint strip. Arrows scale with
        // γ so cranking the fan to zero visibly shrinks them.
        {
          kind: "fan",
          x: -1.8,
          y: CH_H / 2,
          strength: () => state.fanStrength,
          label: "fan",
        },
        // Compressor label + arrow above the middle of the piston's travel
        // range, pointing DOWN into the chamber toward the orange segment.
        {
          kind: "compressor",
          x: (PISTON_LEFT + PISTON_RIGHT) / 2,
          y: CH_H + 0.6,
          label: "compressor",
        },
      ],
      cMin: -30,
      cMax: 120,
    };
  };
}

// Full-heat-pump scenario, now with REAL connected chambers and REAL
// exterior reservoir atoms.
//
//   [comp]───discharge───▶[cond]═════ indoor "air marbles" (Langevin)
//     ▲                     │
//     │ suction             │ liquid
//     │                     ▼
//   [evap]◀══expansion══[valve]    ← 1σ throttle (Joule-Thomson)
//     ║ outdoor "air marbles" (Langevin)
//
// Each chamber is connected to its neighbours by NARROW physical pipe
// corridors (line-segment walls forming 2σ channels) so atoms actually
// flow between them. The compressor piston pushes gas out through the
// discharge pipe; pressure gradients drive circulation the rest of the way
// around. The expansion pipe is narrower (~1σ) — that IS the throttle.
//
// The indoor / outdoor reservoirs are populated with actual air-marble
// atoms (LJ, kind=0) held at their setpoint by a Langevin thermostat.
// They collide with the tethered coil-wall atoms — heat transfers by
// real collisions, not a mathematical thermostat on the wall itself.
// When the fan is turned down (γ ↓) the boundary layer of air-marbles
// against the coil stagnates and can't dump heat quickly — same failure
// mode as a real coil losing airflow.
//
// schematic (dashed arrows drawn on the canvas) so users read the whole
// canvas as a diagram, and the local physics inside each box is honest.
function fullHeatPump(): Scenario["build"] {
  return () => {
    const anchors: UnitAnchors = { ...DEFAULT_ANCHORS };
    const cToT = (c: number) => {
      const m = (anchors.t2_star - anchors.t1_star) / (anchors.t2_celsius - anchors.t1_celsius);
      return anchors.t1_star + m * (c - anchors.t1_celsius);
    };
    const state = {
      // Piston speed matters for whether compression reads as adiabatic
      // (gas heats) or isothermal (gas doesn't). Long slow strokes were
      // nearly isothermal → no heat pumping. 0.6 is a compromise: fast
      // enough that the gas visibly heats on the push stroke, slow enough
      // that a cycle takes a few seconds of wall clock at 8× dilation
      // (users can watch it).
      pistonSpeed: 0.6,
      condFan: 2.0,
      evapFan: 2.0,
      hotResC: 40,
      coldResC: -5,
    };
    // Domain covers all four sub-chambers plus reservoir tint strips and
    // pipe drawing space.
    const sim = new Simulation({
      domain: { xMin: -6, yMin: -4, xMax: 66, yMax: 38 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: [],
      dt: 0.004,
      capacity: 2000,
    });
    sim.setRng(new Rng(21));

    const segs: LineSegment[] = [];
    const w = (ax: number, ay: number, bx: number, by: number) =>
      segs.push({ ax, ay, bx, by, epsilon: 1, sigma: 1 });

    // Chamber bounds (4-quadrant layout)
    //   Comp (top-left)   Cond (top-right)
    //   Evap (bot-left)   Valve (bot-right)
    // Flow: comp → discharge (right) → cond → liquid (down) → valve
    //     → expansion (left) → evap → suction (up) → comp
    const compX0 = 2, compY0 = 20, compX1 = 24, compY1 = 32;
    const condX0 = 36, condY0 = 20, condX1 = 58, condY1 = 32;
    const valveX0 = 36, valveY0 = 2, valveX1 = 58, valveY1 = 14;
    const evapX0 = 2, evapY0 = 2, evapX1 = 24, evapY1 = 14;
    // Pipe corridor centres/widths.
    // Note on width: an atom in a 2σ pipe centre is 1.0σ from each wall,
    // which is INSIDE the WCA cutoff (1.122σ). Both walls repel it
    // simultaneously and it can't flow. Bumping the "wide" pipes to 3σ
    // gives atoms a 1.5σ clearance at the centre — outside the cutoff,
    // no wall repulsion, free flow. Expansion stays narrower as the
    // throttle but at 2.5σ (1.25σ clearance) it's just past the cutoff,
    // so gas passes but with the extra collisions that give the JT drop.
    const dischargeY = 26, dischargeHW = 1.5;     // 3σ wide horizontal pipe
    const liquidX = 47, liquidHW = 1.5;            // 3σ wide vertical pipe
    const suctionX = 13, suctionHW = 1.5;          // 3σ wide vertical pipe
    const expansionY = 8, expansionHW = 1.25;      // 2.5σ NARROW pipe — the Joule-Thomson throttle

    // === Compressor chamber walls ==========================================
    // Full box except the right wall has a gap for the discharge pipe, and
    // the bottom wall has a gap for the suction pipe.
    w(compX0, compY0, suctionX - suctionHW, compY0);        // bottom (left of suction gap)
    w(suctionX + suctionHW, compY0, compX1, compY0);        // bottom (right of suction gap)
    w(compX1, compY0, compX1, dischargeY - dischargeHW);    // right (below discharge gap)
    w(compX1, dischargeY + dischargeHW, compX1, compY1);    // right (above discharge gap)
    w(compX1, compY1, compX0, compY1);                       // top
    w(compX0, compY1, compX0, compY0);                       // left

    // === Condenser chamber walls ===========================================
    // Left has discharge gap; bottom has liquid gap; right is heat exchanger.
    w(condX0, condY0, liquidX - liquidHW, condY0);           // bottom (left of liquid gap)
    w(liquidX + liquidHW, condY0, condX1, condY0);           // bottom (right of liquid gap)
    // right wall replaced by exchanger
    w(condX1, condY1, condX0, condY1);                       // top
    w(condX0, condY1, condX0, dischargeY + dischargeHW);     // left (above discharge gap)
    w(condX0, dischargeY - dischargeHW, condX0, condY0);     // left (below discharge gap)

    // === Valve chamber walls ===============================================
    // Top has liquid gap; left has NARROW expansion gap.
    w(valveX0, valveY0, valveX1, valveY0);                    // bottom
    w(valveX1, valveY0, valveX1, valveY1);                    // right
    w(valveX1, valveY1, liquidX + liquidHW, valveY1);         // top (right of liquid gap)
    w(liquidX - liquidHW, valveY1, valveX0, valveY1);         // top (left of liquid gap)
    w(valveX0, valveY1, valveX0, expansionY + expansionHW);   // left (above expansion gap)
    w(valveX0, expansionY - expansionHW, valveX0, valveY0);   // left (below expansion gap)

    // === Evaporator chamber walls ==========================================
    // Top has suction gap; right has NARROW expansion gap; left is exchanger.
    w(evapX1, evapY0, evapX0, evapY0);                         // bottom
    w(evapX1, expansionY - expansionHW, evapX1, evapY0);       // right (below expansion gap)
    w(evapX1, evapY1, evapX1, expansionY + expansionHW);       // right (above expansion gap)
    w(suctionX + suctionHW, evapY1, evapX1, evapY1);           // top (right of suction gap)
    w(evapX0, evapY1, suctionX - suctionHW, evapY1);           // top (left of suction gap)
    // left wall replaced by exchanger

    // === Pipe corridor walls (physical narrow channels) ====================
    // Discharge pipe (comp → cond, horizontal, 2σ)
    w(compX1, dischargeY + dischargeHW, condX0, dischargeY + dischargeHW);  // top
    w(compX1, dischargeY - dischargeHW, condX0, dischargeY - dischargeHW);  // bottom
    // Liquid pipe (cond → valve, vertical, 2σ)
    w(liquidX - liquidHW, condY0, liquidX - liquidHW, valveY1);             // left
    w(liquidX + liquidHW, condY0, liquidX + liquidHW, valveY1);             // right
    // Expansion pipe (valve → evap, horizontal, NARROW 1.2σ) — the Joule-Thomson throttle
    w(valveX0, expansionY + expansionHW, evapX1, expansionY + expansionHW); // top
    w(valveX0, expansionY - expansionHW, evapX1, expansionY - expansionHW); // bottom
    // Suction pipe (evap → comp, vertical, 2σ)
    w(suctionX - suctionHW, evapY1, suctionX - suctionHW, compY0);          // left
    w(suctionX + suctionHW, evapY1, suctionX + suctionHW, compY0);          // right

    // === Outer walls for the two exterior reservoirs =======================
    // Indoor reservoir (right of condenser)
    const indoorX0 = condX1, indoorX1 = 62;
    const indoorY0 = condY0, indoorY1 = condY1;
    w(indoorX1, indoorY0, indoorX1, indoorY1);                              // right outer
    w(indoorX1, indoorY0, indoorX0, indoorY0);                              // bottom outer
    w(indoorX0, indoorY1, indoorX1, indoorY1);                              // top outer
    // Outdoor reservoir (left of evaporator)
    const outdoorX0 = -4, outdoorX1 = evapX0;
    const outdoorY0 = evapY0, outdoorY1 = evapY1;
    w(outdoorX0, outdoorY0, outdoorX0, outdoorY1);                          // left outer
    w(outdoorX0, outdoorY0, outdoorX1, outdoorY0);                          // bottom outer
    w(outdoorX1, outdoorY1, outdoorX0, outdoorY1);                          // top outer

    // === Seed refrigerant (one connected system across all 4 chambers) =====
    // Denser seed on the "high-P" side (comp+cond+valve) than on the "low-P"
    // side (evap) so a pressure gradient is present from t=0 — the
    // compressor doesn't have to build it up from scratch.
    const refIdx: number[] = [];
    const addToRef = (start: number) => {
      for (let i = start; i < sim.n; i++) refIdx.push(i);
    };
    // Compressor chamber — seed the RIGHT side (in the piston's swept
    // zone), leaving the piston-startup region + suction gap contact
    // clear so nothing is inside a moving segment's cutoff at t=0.
    let first = sim.n;
    seedLattice(sim, {
      xMin: suctionX + suctionHW + 3, yMin: compY0 + 1,
      xMax: compX1 - 1, yMax: compY1 - 1,
    }, 1.35, 1.0, new Rng(101));
    addToRef(first);
    // Condenser chamber (moderately dense — post-compression)
    first = sim.n;
    seedLattice(sim, {
      xMin: condX0 + 1, yMin: condY0 + 1,
      xMax: condX1 - 2, yMax: condY1 - 1,
    }, 1.4, 1.0, new Rng(202));
    addToRef(first);
    // Valve chamber (moderately dense — high-P side)
    first = sim.n;
    seedLattice(sim, {
      xMin: valveX0 + 1, yMin: valveY0 + 1,
      xMax: valveX1 - 1, yMax: valveY1 - 1,
    }, 1.4, 1.0, new Rng(303));
    addToRef(first);
    // Evaporator chamber (sparse — post-expansion low-P)
    first = sim.n;
    seedLattice(sim, {
      xMin: evapX0 + 2, yMin: evapY0 + 1,
      xMax: evapX1 - 1, yMax: evapY1 - 1,
    }, 1.7, 1.0, new Rng(404));
    addToRef(first);

    // === Heat exchangers (tethered coil atoms) =============================
    const condHx = addHeatExchanger(sim, {
      ax: condX1, ay: condY0 + 0.5, bx: condX1, by: condY1 - 0.5,
      spacing: 1.15, layers: 2, layerOffset: 1.0,
      tetherK: 40, sigma: 1, epsilon: 1,
    });
    segs.push(condHx.barrier);
    const evapHx = addHeatExchanger(sim, {
      ax: evapX0, ay: evapY0 + 0.5, bx: evapX0, by: evapY1 - 0.5,
      spacing: 1.15, layers: 2, layerOffset: 1.0,
      tetherK: 40, sigma: 1, epsilon: 1,
    });
    segs.push(evapHx.barrier);

    // === Exterior reservoir atoms (indoor & outdoor "air marbles") =========
    // These are REAL free atoms in the reservoir regions, not just Langevin
    // on the coil wall. They collide with the coil-wall atoms and carry heat
    // in/out of the system by physical collisions. Langevin is applied ONLY
    // to these reservoir atoms — that's what the fan represents. Fan off →
    // Langevin γ ↓ → boundary layer against the coil can't be refreshed →
    // stagnation → same failure mode as a real coil losing airflow.
    const indoorIdx: number[] = [];
    first = sim.n;
    seedLattice(sim, {
      xMin: indoorX0 + 1.0, yMin: indoorY0 + 0.6,
      xMax: indoorX1 - 0.5, yMax: indoorY1 - 0.6,
    }, 1.4, 1.0, new Rng(505));
    for (let i = first; i < sim.n; i++) indoorIdx.push(i);
    const outdoorIdx: number[] = [];
    first = sim.n;
    seedLattice(sim, {
      xMin: outdoorX0 + 0.5, yMin: outdoorY0 + 0.6,
      xMax: outdoorX1 - 1.0, yMax: outdoorY1 - 0.6,
    }, 1.4, 1.0, new Rng(606));
    for (let i = first; i < sim.n; i++) outdoorIdx.push(i);
    const condTherm = new ThermostatGroup(indoorIdx, cToT(state.hotResC), state.condFan);
    const evapTherm = new ThermostatGroup(outdoorIdx, cToT(state.coldResC), state.evapFan);
    sim.thermostats.push(condTherm);
    sim.thermostats.push(evapTherm);

    // === Compressor piston + check valves ==================================
    // Piston sits inside the compressor chamber. On its ACTIVE rightward
    // stroke it drives gas out through the discharge pipe; on the ghost
    // return-stroke (active=false) it slides left through the chamber
    // without touching anything — atoms flow around it as if it weren't
    // there.
    //
    // Ghost return alone is not enough — it stops the piston from PUSHING
    // atoms back, but nothing stops atoms in the discharge pipe from
    // flowing back INTO the compressor chamber under a pressure gradient.
    // Real compressors have one-way check valves for exactly this reason.
    // We model them as zero-velocity MovingSegments toggled in phase with
    // the piston:
    //   push (piston →): discharge OPEN, suction CLOSED
    //   return (piston ←): discharge CLOSED, suction OPEN (fresh gas from evap)
    //
    // Positioning: PISTON_LEFT sits just RIGHT of the suction gap so the
    // piston never crosses the suction port during its normal stroke. When
    // the piston is at PISTON_LEFT and the suction valve is open (during
    // return), gas flows in through the port at x=13 and fills the space
    // to the LEFT of the piston, ready to be swept out through discharge
    // on the next push.
    // Return-stroke speed: 2.5× the push speed. 6× was so fast the pipes
    // didn't have time to admit any gas at all; 2× gives return-and-fill
    // time to actually happen.
    const PISTON_LEFT = suctionX + suctionHW + 1;
    const PISTON_RIGHT = compX1 - 3;
    const PISTON_RETURN_FACTOR = 2.5;
    const piston = new MovingSegment({
      ax: PISTON_LEFT, ay: compY0, bx: PISTON_LEFT, by: compY1,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1.2,
    });
    sim.movingSegments.push(piston);
    const dischargeValve = new MovingSegment({
      ax: compX1, ay: dischargeY - dischargeHW,
      bx: compX1, by: dischargeY + dischargeHW,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1,
    });
    dischargeValve.active = false; // open at start (push phase)
    sim.movingSegments.push(dischargeValve);
    const suctionValve = new MovingSegment({
      ax: suctionX - suctionHW, ay: compY0,
      bx: suctionX + suctionHW, by: compY0,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1,
    });
    suctionValve.active = true; // closed at start (push phase — no back-fill loop)
    sim.movingSegments.push(suctionValve);
    let pistonPhase: "push" | "return" = "push";

    sim.setSegments(segs);
    sim.primeForces();

    // === Tick control =====================================================
    let started = false;
    const tick = (step: number) => {
      if (step < 200 && step % 25 === 0 && step > 0) {
        rescaleToTemperature(sim, 1.0, refIdx);
        rescaleToTemperature(sim, 1.0, indoorIdx);
        rescaleToTemperature(sim, 1.0, outdoorIdx);
      }
      if (!started && step >= 200) {
        started = true;
        piston.active = true;
        piston.vax = state.pistonSpeed;
        piston.vbx = state.pistonSpeed;
        piston.workInput = 0;
        piston.workAbsolute = 0;
        // Initial valve state matches push phase.
        dischargeValve.active = false;
        suctionValve.clearContactZone(sim);
        suctionValve.active = true;
        condTherm.energyIn = 0; condTherm.energyOut = 0;
        evapTherm.energyIn = 0; evapTherm.energyOut = 0;
      }
      if (started) {
        // One-way pumping cycle. clearContactZone() prevents an r⁻¹³ spike
        // the moment we reactivate ANY segment atop atoms that have drifted
        // into its contact zone.
        if (pistonPhase === "push") {
          if (piston.ax >= PISTON_RIGHT) {
            pistonPhase = "return";
            piston.active = false;
            piston.vax = -state.pistonSpeed * PISTON_RETURN_FACTOR;
            piston.vbx = -state.pistonSpeed * PISTON_RETURN_FACTOR;
            // Close discharge (no back-flow from hot condenser side); open
            // suction (fresh cool gas from evaporator flows in).
            dischargeValve.clearContactZone(sim);
            dischargeValve.active = true;
            suctionValve.active = false;
          }
        } else {
          if (piston.ax <= PISTON_LEFT) {
            pistonPhase = "push";
            piston.clearContactZone(sim);
            piston.active = true;
            piston.vax = state.pistonSpeed;
            piston.vbx = state.pistonSpeed;
            // Open discharge (gas can leave); close suction (no back-fill
            // shortcut for gas we're about to compress).
            dischargeValve.active = false;
            suctionValve.clearContactZone(sim);
            suctionValve.active = true;
          }
        }
      }
    };

    return {
      sim,
      tick,
      unitAnchors: anchors,
      cMin: -30,
      cMax: 120,
      regions: [
        // Live temperature tints — each chamber's background colour tracks
        // the mean T of the marbles currently inside it. Warmer than the
        // reservoir setpoint → red-orange; colder → deep blue. This is the
        // real per-*population* temperature; individual marbles are all
        // neutral white with their motion carrying the "heat".
        {
          label: "",
          xMin: compX0, yMin: compY0, xMax: compX1, yMax: compY1,
          tintByT: () => meanTInBox(sim, compX0, compY0, compX1, compY1),
        },
        {
          label: "",
          xMin: condX0, yMin: condY0, xMax: condX1, yMax: condY1,
          tintByT: () => meanTInBox(sim, condX0, condY0, condX1, condY1),
        },
        {
          label: "",
          xMin: valveX0, yMin: valveY0, xMax: valveX1, yMax: valveY1,
          tintByT: () => meanTInBox(sim, valveX0, valveY0, valveX1, valveY1),
        },
        {
          label: "",
          xMin: evapX0, yMin: evapY0, xMax: evapX1, yMax: evapY1,
          tintByT: () => meanTInBox(sim, evapX0, evapY0, evapX1, evapY1),
        },
        // Exterior reservoirs
        {
          label: "",
          xMin: indoorX0, yMin: indoorY0, xMax: indoorX1, yMax: indoorY1,
          tintByT: () => meanTInBox(sim, indoorX0, indoorY0, indoorX1, indoorY1),
          tintByTAlpha: 0.32,
        },
        {
          label: "",
          xMin: outdoorX0, yMin: outdoorY0, xMax: outdoorX1, yMax: outdoorY1,
          tintByT: () => meanTInBox(sim, outdoorX0, outdoorY0, outdoorX1, outdoorY1),
          tintByTAlpha: 0.32,
        },
      ],
      readouts: [
        {
          label: "refrigerant T",
          v: T(() => sim.temperatureOf(refIdx)),
        },
        {
          label: "hot coil (indoors)",
          v: T(() => sim.temperatureOf(condHx.atomIndices)),
        },
        {
          label: "cold coil (outdoors)",
          v: T(() => sim.temperatureOf(evapHx.atomIndices)),
        },
        {
          label: "indoor air T",
          v: T(() => sim.temperatureOf(indoorIdx)),
        },
        {
          label: "outdoor air T",
          v: T(() => sim.temperatureOf(outdoorIdx)),
        },
        {
          label: "electricity used",
          v: R(() => (started ? piston.workAbsolute.toFixed(1) : "—")),
        },
        {
          label: "heat delivered indoors",
          v: R(() =>
            started ? (condTherm.energyOut - condTherm.energyIn).toFixed(1) : "—"
          ),
        },
        {
          label: "heat pulled from outdoors",
          v: R(() =>
            started ? (evapTherm.energyIn - evapTherm.energyOut).toFixed(1) : "—"
          ),
        },
        {
          label: "efficiency (COP)",
          v: R(() => {
            if (!started || piston.workAbsolute <= 0) return "—";
            const q = condTherm.energyOut - condTherm.energyIn;
            return (q / piston.workAbsolute).toFixed(2);
          }),
        },
      ],
      series: [
        { name: "refrigerant", colour: "#f0c060", value: () => sim.temperatureOf(refIdx) },
        { name: "hot coil", colour: "#e07a5f", value: () => sim.temperatureOf(condHx.atomIndices) },
        { name: "cold coil", colour: "#5f8fb8", value: () => sim.temperatureOf(evapHx.atomIndices) },
        { name: "indoor air", colour: "rgba(224,122,95,0.5)", value: () => sim.temperatureOf(indoorIdx) },
        { name: "outdoor air", colour: "rgba(95,143,184,0.5)", value: () => sim.temperatureOf(outdoorIdx) },
      ],
      sliders: [
        {
          id: "pistonSpeed",
          label: "compressor speed",
          min: 0.0, max: 1.2, step: 0.05, initial: state.pistonSpeed,
          format: (v) => v.toFixed(2),
          onChange: (v) => {
            const sign = piston.vax === 0 ? -1 : Math.sign(piston.vax);
            state.pistonSpeed = v;
            piston.vax = sign * v;
            piston.vbx = sign * v;
          },
        },
        {
          id: "condFan",
          label: "indoor fan (γ)",
          min: 0.05, max: 5.0, step: 0.05, initial: state.condFan,
          format: (v) => v.toFixed(2),
          onChange: (v) => { state.condFan = v; condTherm.gamma = v; },
        },
        {
          id: "evapFan",
          label: "outdoor fan (γ)",
          min: 0.05, max: 5.0, step: 0.05, initial: state.evapFan,
          format: (v) => v.toFixed(2),
          onChange: (v) => { state.evapFan = v; evapTherm.gamma = v; },
        },
        {
          id: "hotResC",
          label: "indoor T (°C)",
          min: 10, max: 60, step: 1, initial: state.hotResC,
          format: (v) => `${v.toFixed(0)} °C`,
          onChange: (v) => { state.hotResC = v; condTherm.targetT = cToT(v); },
        },
        {
          id: "coldResC",
          label: "outdoor T (°C)",
          min: -25, max: 25, step: 1, initial: state.coldResC,
          format: (v) => `${v.toFixed(0)} °C`,
          onChange: (v) => { state.coldResC = v; evapTherm.targetT = cToT(v); },
        },
      ],
      parts: [
        // Sub-chamber labels — pipes are physically visible as walls now, so
        // just tag each part with a name. No arrows overlay needed.
        { kind: "label", x: (compX0 + compX1) / 2, y: compY1 + 1.2, label: "compressor" },
        { kind: "label", x: (condX0 + condX1) / 2, y: condY1 + 1.2, label: "condenser" },
        { kind: "label", x: (valveX0 + valveX1) / 2, y: valveY0 - 1.2, label: "valve chamber" },
        { kind: "label", x: (evapX0 + evapX1) / 2, y: evapY0 - 1.2, label: "evaporator" },
        // Pipe stage labels — placed on the walls themselves
        { kind: "label", x: (compX1 + condX0) / 2, y: dischargeY + dischargeHW + 1.2, label: "discharge" },
        { kind: "label", x: liquidX + liquidHW + 2.8, y: (condY0 + valveY1) / 2, label: "liquid line" },
        { kind: "label", x: (evapX1 + valveX0) / 2, y: expansionY - expansionHW - 1.2, label: "expansion (throttle)" },
        { kind: "label", x: suctionX - suctionHW - 2.4, y: (evapY1 + compY0) / 2, label: "suction" },
        // Coil labels
        { kind: "coil", x: condX1 - 1, y: condY1 - 0.6, label: "coil" },
        { kind: "coil", x: evapX0 + 1, y: evapY1 - 0.6, label: "coil" },
        // Reservoir labels
        { kind: "label", x: (indoorX0 + indoorX1) / 2, y: indoorY1 + 1.2, label: "indoor air" },
        { kind: "label", x: (outdoorX0 + outdoorX1) / 2, y: outdoorY1 + 1.2, label: "outdoor air" },
        // Fans over the reservoirs (γ)
        {
          kind: "fan",
          x: (indoorX0 + indoorX1) / 2, y: (indoorY0 + indoorY1) / 2,
          strength: () => state.condFan,
        },
        {
          kind: "fan",
          x: (outdoorX0 + outdoorX1) / 2, y: (outdoorY0 + outdoorY1) / 2,
          strength: () => state.evapFan,
        },
        // Compressor arrow anchored above the piston travel range
        {
          kind: "compressor",
          x: (PISTON_LEFT + PISTON_RIGHT) / 2,
          y: compY1 + 0.4,
          label: "piston",
        },
      ],
    };
  };
}

// Real closed-loop heat pump — a single ring-shaped chamber with refrigerant
// atoms actually circulating. The compressor is a horizontal segment in the
// left leg of the loop that pumps upward on its active stroke, then phases
// out (active=false) and teleports back down for the return, then reactivates.
// This is functionally equivalent to a piston with intake/discharge check
// valves — the only mechanism for net one-way pumping without directional
// physics.
//
//         ┌── condenser wall (top, hot) ──┐
//         │                                │
//         │  →→→→→  gas flows right  →→→→→│
//         │                                │
//    left │  ↑                             │  right
//    leg  │  ↑ compressor pushes up        │  leg (down)
//         │  ↑                             │       │
//         │                                │       ▼ valve constriction
//         │                                │
//         │  ←←←←  gas returns left  ←←←←  │
//         │                                │
//         └── evaporator wall (bottom, cold) ┘
//
// Because the compressor maintains a pressure differential between the top
// and bottom of the left leg, gas circulates clockwise. Real gas/liquid
// behaviour emerges: refrigerant piles up at high density near the condenser
// (attractive LJ well causes visible condensation), thins out on the
// evaporator side. Tuning ANY slider cascades through the whole system.
function closedLoop(): Scenario["build"] {
  return () => {
    const anchors: UnitAnchors = { ...DEFAULT_ANCHORS };
    const cToT = (c: number) => {
      const m = (anchors.t2_star - anchors.t1_star) / (anchors.t2_celsius - anchors.t1_celsius);
      return anchors.t1_star + m * (c - anchors.t1_celsius);
    };
    // Outer rectangle bounds
    const OX = 50;
    const OY = 30;
    // Inner obstacle bounds (creates the ring hole)
    const IX0 = 12, IX1 = 38, IY0 = 10, IY1 = 20;

    const state = {
      pumpSpeed: 0.4,
      condFan: 1.5,
      evapFan: 1.5,
      hotResC: 45,
      coldResC: -5,
    };
    const sim = new Simulation({
      domain: { xMin: -3, yMin: -3, xMax: OX + 3, yMax: OY + 3 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: [],
      dt: 0.004,
      capacity: 800,
    });
    sim.setRng(new Rng(51));

    const segs: LineSegment[] = [];
    const wall = (ax: number, ay: number, bx: number, by: number) =>
      segs.push({ ax, ay, bx, by, epsilon: 1, sigma: 1 });

    // Outer boundary (with GAPS where the heat-exchanger walls go)
    // — bottom: split into left half, evaporator gap, right half
    // — top: same with condenser gap
    const CX0 = 15, CX1 = 35; // exchanger x span (middle 20 units)
    wall(0, 0, CX0, 0);         // bottom-left
    wall(CX1, 0, OX, 0);        // bottom-right
    wall(OX, 0, OX, OY);        // right
    wall(OX, OY, CX1, OY);      // top-right
    wall(CX0, OY, 0, OY);       // top-left
    wall(0, OY, 0, 0);          // left

    // Inner obstacle boundary
    wall(IX0, IY0, IX1, IY0);   // inner bottom
    wall(IX1, IY0, IX1, IY1);   // inner right
    wall(IX1, IY1, IX0, IY1);   // inner top
    wall(IX0, IY1, IX0, IY0);   // inner left

    // Valve — narrow constriction in the RIGHT leg. Two short vertical
    // pieces jutting from top and bottom outer walls at x = OX - 6, leaving
    // a 2σ gap in the middle of the right leg for atoms to squeeze through.
    // This is the "expansion valve" — density drops sharply as gas expands
    // from the high-P condenser side into the low-P evaporator side.
    const VX = OX - 6;
    const VGAP = 1.0;
    const VMID = (IY0 + IY1) / 2;
    wall(VX, IY1, VX, VMID + VGAP);
    wall(VX, VMID - VGAP, VX, IY0);

    // Condenser heat-exchanger — line along the top wall, from x=CX0 to CX1.
    // Wall atoms sit just BELOW y=OY. Reservoir tint above.
    const cond = addHeatExchanger(sim, {
      ax: CX0, ay: OY, bx: CX1, by: OY,
      spacing: 1.15, layers: 2, layerOffset: 1.0,
      tetherK: 40, sigma: 1, epsilon: 1,
    });
    segs.push(cond.barrier);
    const condTherm = new ThermostatGroup(cond.atomIndices, cToT(state.hotResC), state.condFan);
    sim.thermostats.push(condTherm);

    // Evaporator heat-exchanger — line along the bottom wall.
    const evap = addHeatExchanger(sim, {
      ax: CX0, ay: 0, bx: CX1, by: 0,
      spacing: 1.15, layers: 2, layerOffset: 1.0,
      tetherK: 40, sigma: 1, epsilon: 1,
    });
    segs.push(evap.barrier);
    const evapTherm = new ThermostatGroup(evap.atomIndices, cToT(state.coldResC), state.evapFan);
    sim.thermostats.push(evapTherm);

    // Compressor — horizontal segment spanning the full width of the LEFT
    // leg (from x=1 to x=IX0-0.5), inside the ring at some y between IY0
    // and IY1. It pumps ONE-WAY up: active=true while moving up, active=false
    // (invisible ghost) during the fast return stroke. Net effect is that
    // atoms in the left leg are shepherded upward every cycle, establishing
    // a pressure differential and driving clockwise circulation.
    const PUMP_LEFT = 1;
    const PUMP_RIGHT = IX0 - 0.5;
    const PUMP_BOTTOM = IY0 + 0.5;
    const PUMP_TOP = IY1 - 0.5;
    const pump = new MovingSegment({
      ax: PUMP_LEFT, ay: PUMP_BOTTOM,
      bx: PUMP_RIGHT, by: PUMP_BOTTOM,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1.2,
    });
    sim.movingSegments.push(pump);

    // Seed refrigerant EVERYWHERE around the ring (avoiding the inner
    // obstacle, the exchanger wall atom columns, and a small clearance zone
    // around the compressor's starting position so we don't overlap it).
    const seedRegions = [
      // Bottom leg (excluding exchanger x-band interior)
      { xMin: 2, yMin: 2.5, xMax: IX0 - 0.5, yMax: IY0 - 0.5 },
      { xMin: IX1 + 0.5, yMin: 2.5, xMax: VX - 0.5, yMax: IY0 - 0.5 },
      { xMin: VX + 0.5, yMin: 2.5, xMax: OX - 1, yMax: IY0 - 0.5 },
      // Top leg
      { xMin: 2, yMin: IY1 + 0.5, xMax: IX0 - 0.5, yMax: OY - 2.5 },
      { xMin: IX1 + 0.5, yMin: IY1 + 0.5, xMax: OX - 1, yMax: OY - 2.5 },
      // Right leg
      { xMin: IX1 + 0.5, yMin: IY0 + 0.5, xMax: VX - 0.5, yMax: IY1 - 0.5 },
      { xMin: VX + 0.5, yMin: IY0 + 0.5, xMax: OX - 1, yMax: IY1 - 0.5 },
      // Left leg — start above pump's initial position
      { xMin: 2, yMin: PUMP_BOTTOM + 1.5, xMax: IX0 - 0.5, yMax: IY1 - 0.5 },
    ];
    const gasIdx: number[] = [];
    for (const r of seedRegions) {
      const first = sim.n;
      seedLattice(sim, r, 1.35, 1.0, new Rng(Math.floor(r.xMin * 100 + r.yMin)));
      for (let i = first; i < sim.n; i++) gasIdx.push(i);
    }

    sim.setSegments(segs);
    sim.primeForces();

    const PUMP_STROKE_TIME = 40; // sim time units (= 10000 steps) — SLOW
    // Return stroke is fast: 5× the pump speed downward with active=false.
    // Empirically 5× gives a compact return without spooking the eye.
    const RETURN_FACTOR = 6;
    let phase: "pump" | "return" = "pump";
    let started = false;
    const tick = (step: number) => {
      if (step < 200 && step % 25 === 0 && step > 0) {
        rescaleToTemperature(sim, 1.0, gasIdx);
      }
      if (!started && step >= 200) {
        started = true;
        pump.active = true;
        pump.vay = state.pumpSpeed;
        pump.vby = state.pumpSpeed;
        pump.workInput = 0;
        pump.workAbsolute = 0;
        condTherm.energyIn = 0; condTherm.energyOut = 0;
        evapTherm.energyIn = 0; evapTherm.energyOut = 0;
      }
      if (!started) return;
      if (phase === "pump") {
        if (pump.ay >= PUMP_TOP) {
          phase = "return";
          pump.active = false;
          pump.vay = -state.pumpSpeed * RETURN_FACTOR;
          pump.vby = -state.pumpSpeed * RETURN_FACTOR;
        }
      } else {
        if (pump.ay <= PUMP_BOTTOM) {
          phase = "pump";
          // CRITICAL: before reactivating, displace any atoms that flowed
          // into the segment's contact zone during the ghost return stroke.
          // Without this, an r⁻¹³ WCA spike sends them to relativistic
          // velocities on the first reactivated frame and the sim explodes.
          pump.clearContactZone(sim);
          pump.active = true;
          pump.vay = state.pumpSpeed;
          pump.vby = state.pumpSpeed;
        }
      }
    };
    void PUMP_STROKE_TIME;

    return {
      sim,
      tick,
      unitAnchors: anchors,
      cMin: -30,
      cMax: 120,
      regions: [
        // Dynamic reservoir tints from the coil temperatures
        {
          label: "",
          xMin: CX0, yMin: OY, xMax: CX1, yMax: OY + 2.5,
          tintByT: () => sim.temperatureOf(cond.atomIndices),
          tintByTAlpha: 0.36,
        },
        {
          label: "",
          xMin: CX0, yMin: -2.5, xMax: CX1, yMax: 0,
          tintByT: () => sim.temperatureOf(evap.atomIndices),
          tintByTAlpha: 0.36,
        },
        // Ring channel tint from refrigerant mean T
        {
          label: "",
          xMin: 0, yMin: 0, xMax: OX, yMax: OY,
          tintByT: () => sim.temperatureOf(gasIdx),
          tintByTAlpha: 0.18,
        },
      ],
      readouts: [
        {
          label: "hot coil (indoors)",
          v: T(() => sim.temperatureOf(cond.atomIndices)),
        },
        {
          label: "cold coil (outdoors)",
          v: T(() => sim.temperatureOf(evap.atomIndices)),
        },
        {
          label: "electricity used",
          v: R(() => (started ? pump.workAbsolute.toFixed(1) : "—")),
        },
        {
          label: "heat delivered indoors",
          v: R(() =>
            started ? (condTherm.energyOut - condTherm.energyIn).toFixed(1) : "—"
          ),
        },
        {
          label: "heat pulled from outside",
          v: R(() =>
            started ? (evapTherm.energyIn - evapTherm.energyOut).toFixed(1) : "—"
          ),
        },
        {
          label: "efficiency (COP)",
          v: R(() => {
            if (!started || pump.workAbsolute <= 0) return "—";
            const q = condTherm.energyOut - condTherm.energyIn;
            return (q / pump.workAbsolute).toFixed(2);
          }),
        },
        {
          label: "compressor stroke",
          v: R(() => (started ? phase : "—")),
        },
      ],
      series: [
        { name: "hot coil", colour: "#e07a5f", value: () => sim.temperatureOf(cond.atomIndices) },
        { name: "cold coil", colour: "#5f8fb8", value: () => sim.temperatureOf(evap.atomIndices) },
        { name: "indoor set", colour: "rgba(224,122,95,0.4)", value: () => cToT(state.hotResC) },
        { name: "outdoor set", colour: "rgba(95,143,184,0.4)", value: () => cToT(state.coldResC) },
      ],
      sliders: [
        {
          id: "pumpSpeed",
          label: "compressor speed",
          min: 0.05, max: 1.2, step: 0.05, initial: state.pumpSpeed,
          format: (v) => v.toFixed(2),
          onChange: (v) => {
            state.pumpSpeed = v;
            const s = phase === "pump" ? 1 : -RETURN_FACTOR;
            pump.vay = s * v;
            pump.vby = s * v;
          },
        },
        {
          id: "condFan",
          label: "indoor fan (γ)",
          min: 0.05, max: 5.0, step: 0.05, initial: state.condFan,
          format: (v) => v.toFixed(2),
          onChange: (v) => { state.condFan = v; condTherm.gamma = v; },
        },
        {
          id: "evapFan",
          label: "outdoor fan (γ)",
          min: 0.05, max: 5.0, step: 0.05, initial: state.evapFan,
          format: (v) => v.toFixed(2),
          onChange: (v) => { state.evapFan = v; evapTherm.gamma = v; },
        },
        {
          id: "hotResC",
          label: "indoor T (°C)",
          min: 10, max: 60, step: 1, initial: state.hotResC,
          format: (v) => `${v.toFixed(0)} °C`,
          onChange: (v) => { state.hotResC = v; condTherm.targetT = cToT(v); },
        },
        {
          id: "coldResC",
          label: "outdoor T (°C)",
          min: -25, max: 25, step: 1, initial: state.coldResC,
          format: (v) => `${v.toFixed(0)} °C`,
          onChange: (v) => { state.coldResC = v; evapTherm.targetT = cToT(v); },
        },
      ],
      parts: [
        { kind: "coil", x: (CX0 + CX1) / 2, y: OY - 0.7, label: "condenser" },
        { kind: "coil", x: (CX0 + CX1) / 2, y: 0.7, label: "evaporator" },
        { kind: "label", x: (CX0 + CX1) / 2, y: OY + 1.5, label: "indoor" },
        { kind: "label", x: (CX0 + CX1) / 2, y: -1.5, label: "outdoor" },
        { kind: "compressor", x: (PUMP_LEFT + PUMP_RIGHT) / 2, y: IY1 + 2, label: "compressor" },
        { kind: "label", x: VX, y: IY0 - 1.2, label: "valve" },
        {
          kind: "fan",
          x: (CX0 + CX1) / 2, y: OY + 1.5,
          strength: () => state.condFan,
        },
        {
          kind: "fan",
          x: (CX0 + CX1) / 2, y: -1.5,
          strength: () => state.evapFan,
        },
      ],
    };
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "phases",
    name: "gas → liquid → crystal (single-box demo)",
    blurb: "The simplest possible molecular dynamics demo: marbles alone in a closed box, thermostatted to whatever temperature you set. Drop T past the freezing point and you get a real triangular crystal (emerges from the LJ potential — no scripting). Warm it to gas. Watch the pressure change too — negative pressure at low T is real (that's the attractive well pulling atoms in). The charge / vacuum buttons let you add or remove marbles the way an HVAC technician charges a system.",
    build: phases(),
  },
  {
    id: "confined_lj",
    name: "confined LJ gas",
    blurb: "A Lennard-Jones gas in a box, thermostatted to T*=1.0 for the first 400 steps then left alone. Baseline for the other experiments.",
    build: confined(DEFAULT_POT_LJ, 1.0),
  },
  {
    id: "confined_wca",
    name: "confined WCA gas",
    blurb: "Same setup but with the attractive well removed (WCA = purely repulsive). The gas won't condense at any density.",
    build: confined(DEFAULT_POT_WCA, 1.0),
  },
  {
    id: "expand_wca",
    name: "free expansion — repulsive (warms)",
    blurb: "WCA gas at high density. At step 500 the walls jump outward. The stored repulsive PE converts to KE — the gas WARMS.",
    build: freeExpansion(DEFAULT_POT_WCA, 1.0, 6, 12, 0.95, 500),
  },
  {
    id: "expand_lj",
    name: "free expansion — LJ (cools)",
    blurb: "LJ gas at moderate density, T=2.5. At step 500 the walls jump outward. Atoms have to climb out of the attractive well — the gas COOLS.",
    build: freeExpansion(DEFAULT_POT_LJ, 2.5, 8, 14, 1.35, 500),
  },
  {
    id: "components_demo",
    name: "components demo — piston + hot exchanger",
    blurb: "A piston reciprocates inside a chamber whose top wall is a heat-exchanger connected to a thermostatted reservoir. On the compression stroke, gas heats and dumps heat into the reservoir (Q_hot rises); on the return stroke gas cools. This is one side of a real heat pump — the condenser.",
    build: compressorHotExchanger(),
  },
  {
    id: "sandbox",
    name: "sandbox — a heat pump you can tune",
    blurb: "The condenser side of a heat pump: a reciprocating piston compresses refrigerant against a heat-exchanger coil, whose fan-cooled tethered atoms carry heat away to the reservoir. Live sliders let you tune the parts. Turn the fan almost off (γ → 0) and the coil surface climbs — that's what a real coil does when airflow drops. Drop the reservoir T and the coil follows. Kill the compressor (speed → 0) and the whole thing coasts to equilibrium. (Full two-coil closed loop with atoms circulating between condenser and evaporator is on the roadmap — geometry needs a proper compressor chamber, not one full-height piston.)",
    build: sandbox(),
  },
  {
    id: "full_heat_pump",
    name: "full heat pump — real connected loop",
    blurb: "All four heat-pump stages connected by real narrow pipes atoms actually flow through. Compressor's one-way active-stroke piston drives gas out the discharge line, around through the condenser (where it dumps heat to the indoor air marbles), down the liquid line, through the NARROW ~1σ expansion throat (real Joule-Thomson cooling), into the evaporator (absorbing heat from outdoor air marbles), and back via the suction line. Fans control Langevin coupling on the indoor and outdoor air marbles — turn a fan down and the air layer against its coil stagnates, exactly as a real coil starves when airflow drops.",
    build: fullHeatPump(),
  },
  {
    id: "closed_loop",
    name: "closed loop — real circulating heat pump (experimental)",
    blurb: "A single ring-shaped chamber with refrigerant ACTUALLY circulating. The compressor on the left pushes atoms upward on its active stroke (solid orange), phases out (dashed, translucent) for the fast return — same mechanism as a piston with intake/discharge check valves. Circulation is clockwise; density and temperature gradients emerge naturally around the loop. Experimental: at high pump speed or over long runs the compressor's reactivation shock can send a stray atom to high velocity, temporarily corrupting mean-T readings. Coil surface T and Q values remain sensible.",
    build: closedLoop(),
  },
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}
