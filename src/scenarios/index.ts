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
}

// Helper constructors so scenario code stays readable.
export const T = (fn: () => number): ReadoutValue => ({ kind: "temperature", value: fn });
export const R = (fn: () => string): ReadoutValue => ({ kind: "raw", value: fn });

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
    parts?: PartSchematic[];
  };
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
        // Tint only — label lives as a "label" schematic below so it doesn't
        // collide with the "coil" label at the top of the same strip.
        {
          label: "",
          xMin: -3, yMin: 0, xMax: 0, yMax: CH_H,
          tint: "rgba(210,80,90,0.10)",
        },
        {
          label: "refrigerant",
          xMin: 2, yMin: 0.5, xMax: PISTON_RIGHT, yMax: CH_H - 0.5,
          v: T(() => sim.temperatureOf(gasIdx)),
        },
      ],
      readouts: [
        {
          label: "coil surface T",
          v: T(() => sim.temperatureOf(cond.atomIndices)),
        },
        {
          label: "reservoir target",
          v: T(() => cToT(state.reservoirC)),
        },
        {
          label: "electricity used (W)",
          v: R(() => (started ? piston.workInput.toFixed(1) : "—")),
        },
        {
          label: "heat moved (Q)",
          v: R(() =>
            started ? (condTherm.energyOut - condTherm.energyIn).toFixed(1) : "—"
          ),
        },
        {
          label: "COP (heat / electricity)",
          v: R(() => {
            if (!started || piston.workInput <= 0) return "—";
            return (
              (condTherm.energyOut - condTherm.energyIn) / piston.workInput
            ).toFixed(2);
          }),
        },
        {
          label: "atoms (charge)",
          v: R(() => String(gasIdx.length)),
        },
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

// Full-heat-pump scenario, laid out as an EXPLODED SCHEMATIC: four
// physically-isolated sub-chambers arranged as a heat-pump diagram, with
// schematic pipe arrows between them.
//
//   +--------+  discharge   +---------+
//   | comp   |─────────────▶| cond    |
//   |        |              |         |
//   +--------+              +---------+
//        ▲                        │ liquid
//        │ suction                ▼
//   +--------+              +---------+
//   | evap   |◀─────────────| valve   |
//   |        |              |         |
//   +--------+              +---------+
//
// Each sub-chamber has real physics for that stage of the cycle:
//   - compressor: piston reciprocates → real work input W = ∫F·v dt
//   - condenser: gas + heat-exchanger wall + Langevin thermostat at hot T
//     → Q_hot = cumulative heat drained to the reservoir
//   - valve: two zones divided by a wall with a narrow gap → gas passes
//     through the gap and equilibrates the density gradient. Emergent
//     Joule–Thomson-like effect on the low-P side.
//   - evaporator: gas + heat-exchanger wall + Langevin thermostat at cold T
//     → Q_cold = heat absorbed from the reservoir
// The four sub-chambers don't share atoms — a closed-loop with atoms
// circulating between them is a bigger geometry problem. The pipes are
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
      pistonSpeed: 0.4,
      condFan: 1.5,
      evapFan: 1.5,
      hotResC: 45,
      coldResC: -5,
    };
    // Domain covers all four sub-chambers plus reservoir tint strips and
    // pipe drawing space.
    const sim = new Simulation({
      domain: { xMin: -3, yMin: -3, xMax: 63, yMax: 37 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: [],
      dt: 0.004,
      capacity: 1500,
    });
    sim.setRng(new Rng(21));

    const segs: LineSegment[] = [];
    const addWalls = (x0: number, y0: number, x1: number, y1: number) => {
      segs.push({ ax: x0, ay: y0, bx: x1, by: y0, epsilon: 1, sigma: 1 });
      segs.push({ ax: x1, ay: y0, bx: x1, by: y1, epsilon: 1, sigma: 1 });
      segs.push({ ax: x1, ay: y1, bx: x0, by: y1, epsilon: 1, sigma: 1 });
      segs.push({ ax: x0, ay: y1, bx: x0, by: y0, epsilon: 1, sigma: 1 });
    };
    const addWallsExceptOne = (
      x0: number, y0: number, x1: number, y1: number,
      skip: "left" | "right" | "top" | "bottom"
    ) => {
      if (skip !== "bottom") segs.push({ ax: x0, ay: y0, bx: x1, by: y0, epsilon: 1, sigma: 1 });
      if (skip !== "right") segs.push({ ax: x1, ay: y0, bx: x1, by: y1, epsilon: 1, sigma: 1 });
      if (skip !== "top") segs.push({ ax: x1, ay: y1, bx: x0, by: y1, epsilon: 1, sigma: 1 });
      if (skip !== "left") segs.push({ ax: x0, ay: y1, bx: x0, by: y0, epsilon: 1, sigma: 1 });
    };

    // Sub-chamber bounds
    const compX0 = 2, compY0 = 20, compX1 = 24, compY1 = 32;
    const condX0 = 36, condY0 = 20, condX1 = 58, condY1 = 32;
    const valveX0 = 36, valveY0 = 2, valveX1 = 58, valveY1 = 14;
    const evapX0 = 2, evapY0 = 2, evapX1 = 24, evapY1 = 14;

    // === Compressor chamber: piston reciprocating ==========================
    addWalls(compX0, compY0, compX1, compY1);
    const compGasIdx: number[] = [];
    const compFirst = sim.n;
    seedLattice(sim, {
      xMin: compX0 + 1.5, yMin: compY0 + 1,
      xMax: compX0 + 14, yMax: compY1 - 1,
    }, 1.25, 1.0, new Rng(101));
    for (let i = compFirst; i < sim.n; i++) compGasIdx.push(i);
    const piston = new MovingSegment({
      ax: compX1 - 4, ay: compY0, bx: compX1 - 4, by: compY1,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1.2,
    });
    sim.movingSegments.push(piston);
    const PISTON_LEFT = compX0 + 7;
    const PISTON_RIGHT = compX1 - 4;

    // === Condenser chamber: hot exchanger + hot reservoir on the right =====
    addWallsExceptOne(condX0, condY0, condX1, condY1, "right");
    const condGasIdx: number[] = [];
    const condFirst = sim.n;
    seedLattice(sim, {
      xMin: condX0 + 1, yMin: condY0 + 1,
      xMax: condX1 - 2, yMax: condY1 - 1,
    }, 1.25, 1.0, new Rng(202));
    for (let i = condFirst; i < sim.n; i++) condGasIdx.push(i);
    const condHx = addHeatExchanger(sim, {
      ax: condX1, ay: condY0 + 0.5, bx: condX1, by: condY1 - 0.5,
      spacing: 1.15, layers: 2, layerOffset: 1.0,
      tetherK: 40, sigma: 1, epsilon: 1,
    });
    segs.push(condHx.barrier);
    const condTherm = new ThermostatGroup(condHx.atomIndices, cToT(state.hotResC), state.condFan);
    sim.thermostats.push(condTherm);

    // === Valve chamber: two zones divided by a narrow-gap wall =============
    addWalls(valveX0, valveY0, valveX1, valveY1);
    // Internal wall dividing valve into left (high-P) and right (low-P) zones,
    // with a narrow gap in the middle for atoms to slowly leak through.
    const valveMidX = (valveX0 + valveX1) / 2;
    const gapCentre = (valveY0 + valveY1) / 2;
    const gapHalf = 1.0;
    segs.push({
      ax: valveMidX, ay: valveY0 + 0.5, bx: valveMidX, by: gapCentre - gapHalf,
      epsilon: 1, sigma: 1,
    });
    segs.push({
      ax: valveMidX, ay: gapCentre + gapHalf, bx: valveMidX, by: valveY1 - 0.5,
      epsilon: 1, sigma: 1,
    });
    const valveHighIdx: number[] = [];
    const valveLowIdx: number[] = [];
    // High-pressure side (left) — dense fill.
    const valveHighFirst = sim.n;
    seedLattice(sim, {
      xMin: valveX0 + 1, yMin: valveY0 + 1,
      xMax: valveMidX - 1, yMax: valveY1 - 1,
    }, 1.05, 1.0, new Rng(303));
    for (let i = valveHighFirst; i < sim.n; i++) valveHighIdx.push(i);
    // Low-pressure side (right) — sparse fill.
    const valveLowFirst = sim.n;
    seedLattice(sim, {
      xMin: valveMidX + 1, yMin: valveY0 + 1,
      xMax: valveX1 - 1, yMax: valveY1 - 1,
    }, 1.8, 1.0, new Rng(304));
    for (let i = valveLowFirst; i < sim.n; i++) valveLowIdx.push(i);

    // === Evaporator chamber: cold exchanger + cold reservoir on the left ===
    addWallsExceptOne(evapX0, evapY0, evapX1, evapY1, "left");
    const evapGasIdx: number[] = [];
    const evapFirst = sim.n;
    seedLattice(sim, {
      xMin: evapX0 + 2, yMin: evapY0 + 1,
      xMax: evapX1 - 1, yMax: evapY1 - 1,
    }, 1.4, 1.0, new Rng(404));
    for (let i = evapFirst; i < sim.n; i++) evapGasIdx.push(i);
    const evapHx = addHeatExchanger(sim, {
      ax: evapX0, ay: evapY0 + 0.5, bx: evapX0, by: evapY1 - 0.5,
      spacing: 1.15, layers: 2, layerOffset: 1.0,
      tetherK: 40, sigma: 1, epsilon: 1,
    });
    segs.push(evapHx.barrier);
    const evapTherm = new ThermostatGroup(evapHx.atomIndices, cToT(state.coldResC), state.evapFan);
    sim.thermostats.push(evapTherm);

    sim.setSegments(segs);
    sim.primeForces();

    // === Tick control =====================================================
    let started = false;
    const tick = (step: number) => {
      if (step < 200 && step % 25 === 0 && step > 0) {
        rescaleToTemperature(sim, 1.0, compGasIdx);
        rescaleToTemperature(sim, 1.0, condGasIdx);
        rescaleToTemperature(sim, 1.0, evapGasIdx);
      }
      if (!started && step >= 200) {
        started = true;
        piston.vax = -state.pistonSpeed;
        piston.vbx = -state.pistonSpeed;
        piston.workInput = 0;
        condTherm.energyIn = 0; condTherm.energyOut = 0;
        evapTherm.energyIn = 0; evapTherm.energyOut = 0;
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
      cMin: -30,
      cMax: 120,
      regions: [
        // Reservoir tints — hot on the right of the condenser, cold on the
        // left of the evaporator. Labels below as schematics.
        {
          label: "",
          xMin: condX1, yMin: condY0, xMax: 61, yMax: condY1,
          tint: "rgba(210,80,90,0.14)",
        },
        {
          label: "",
          xMin: -2, yMin: evapY0, xMax: evapX0, yMax: evapY1,
          tint: "rgba(70,130,180,0.16)",
        },
        // Temperature-value regions per sub-chamber gas
        {
          label: "gas",
          xMin: compX0 + 1, yMin: compY0 + 1,
          xMax: compX0 + 5, yMax: compY0 + 3,
          v: T(() => sim.temperatureOf(compGasIdx)),
        },
        {
          label: "gas",
          xMin: condX0 + 1, yMin: condY0 + 1,
          xMax: condX0 + 5, yMax: condY0 + 3,
          v: T(() => sim.temperatureOf(condGasIdx)),
        },
        {
          label: "gas",
          xMin: evapX0 + 1, yMin: evapY0 + 1,
          xMax: evapX0 + 5, yMax: evapY0 + 3,
          v: T(() => sim.temperatureOf(evapGasIdx)),
        },
      ],
      readouts: [
        {
          label: "condenser coil T",
          v: T(() => sim.temperatureOf(condHx.atomIndices)),
        },
        {
          label: "evaporator coil T",
          v: T(() => sim.temperatureOf(evapHx.atomIndices)),
        },
        {
          label: "compressor work",
          v: R(() => (started ? piston.workInput.toFixed(1) : "—")),
        },
        // In an EXPLODED schematic the sub-chambers are isolated so these Q
        // numbers reflect each thermostat's local heat exchange, not the
        // coupled Q_hot/Q_cold of a closed refrigeration loop. Labelled
        // accordingly so users don't try to compute COP off them.
        {
          label: "condenser Q (local)",
          v: R(() =>
            started ? (condTherm.energyOut - condTherm.energyIn).toFixed(1) : "—"
          ),
        },
        {
          label: "evaporator Q (local)",
          v: R(() =>
            started ? (evapTherm.energyIn - evapTherm.energyOut).toFixed(1) : "—"
          ),
        },
        {
          label: "valve density — high side",
          v: R(() => (valveHighIdx.length / ((valveMidX - valveX0 - 1) * (valveY1 - valveY0 - 2))).toFixed(2)),
        },
        {
          label: "valve density — low side",
          v: R(() => (valveLowIdx.length / ((valveX1 - valveMidX - 1) * (valveY1 - valveY0 - 2))).toFixed(2)),
        },
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
        // Sub-chamber labels
        { kind: "label", x: compX0 + 11, y: compY1 + 1.2, label: "compressor" },
        { kind: "label", x: condX0 + 11, y: condY1 + 1.2, label: "condenser" },
        { kind: "label", x: valveX0 + 11, y: valveY0 - 1.2, label: "expansion valve" },
        { kind: "label", x: evapX0 + 11, y: evapY0 - 1.2, label: "evaporator" },
        // Coil labels
        { kind: "coil", x: condX1 - 1, y: condY1 - 0.6, label: "coil" },
        { kind: "coil", x: evapX0 + 1, y: evapY1 - 0.6, label: "coil" },
        // Reservoir labels & fans
        { kind: "label", x: 60, y: condY0 + 0.8, label: "indoor" },
        { kind: "label", x: -1, y: evapY0 + 0.8, label: "outdoor" },
        {
          kind: "fan",
          x: 60, y: (condY0 + condY1) / 2,
          strength: () => state.condFan,
          label: "fan",
        },
        {
          kind: "fan",
          x: -1, y: (evapY0 + evapY1) / 2,
          strength: () => state.evapFan,
          label: "fan",
        },
        // Compressor arrow anchored above the piston travel range
        {
          kind: "compressor",
          x: (PISTON_LEFT + PISTON_RIGHT) / 2,
          y: compY1 + 0.4,
          label: "piston",
        },
        // Schematic pipes between sub-chambers. These are visual only —
        // atoms don't actually flow through them. The colour hints at the
        // refrigerant state at that stage (hot vapour, hot liquid, cold
        // mix, cold vapour).
        {
          kind: "pipe",
          x1: compX1 + 0.5, y1: (compY0 + compY1) / 2 + 2,
          x2: condX0 - 0.5, y2: (condY0 + condY1) / 2 + 2,
          label: "discharge (hot vapour)",
          colour: "#e07a5f",
        },
        {
          kind: "pipe",
          x1: (condX0 + condX1) / 2 + 3, y1: condY0 - 0.5,
          x2: (valveX0 + valveX1) / 2 + 3, y2: valveY1 + 0.5,
          label: "liquid",
          colour: "#c47f5f",
        },
        {
          kind: "pipe",
          x1: valveX0 - 0.5, y1: (valveY0 + valveY1) / 2 - 2,
          x2: evapX1 + 0.5, y2: (evapY0 + evapY1) / 2 - 2,
          label: "expansion (cold mix)",
          colour: "#7091b8",
        },
        {
          kind: "pipe",
          x1: (evapX0 + evapX1) / 2 - 3, y1: evapY1 + 0.5,
          x2: (compX0 + compX1) / 2 - 3, y2: compY0 - 0.5,
          label: "suction (cool vapour)",
          colour: "#5f8fb8",
        },
      ],
    };
  };
}

export const SCENARIOS: Scenario[] = [
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
    name: "full heat pump — schematic layout",
    blurb: "All four heat-pump stages laid out as a diagram — compressor, condenser, expansion valve, evaporator — each a separate chamber with its own real physics. Dashed arrows show the schematic flow (hot vapour → liquid → cold mix → cool vapour → back). Coloured by temperature: watch the condenser gas glow yellow against a hot indoor coil, the evaporator gas sit deep blue against a cold outdoor coil, and the valve maintain a density gradient across its narrow gap. The sub-chambers are physically isolated (atoms don't circulate) so each part shows its own local behaviour without geometry compromises.",
    build: fullHeatPump(),
  },
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}
