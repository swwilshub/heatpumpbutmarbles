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
    parts?: PartSchematic[];
    series?: ScenarioSeries[];
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
      xMin: valveX0 + 2, yMin: valveY0 + 1,
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

    // Valve driver piston — a vertical segment on the far LEFT of the valve
    // chamber that slowly moves right, pushing high-P atoms through the gap.
    // Without this the density gradient just decays to equilibrium (there's
    // no upstream pressure source in an exploded schematic); with it the
    // valve stays actively pressurised, atoms squeeze through the throat,
    // and the density gradient persists as a real emergent property.
    const VALVE_PUSH_LEFT = valveX0 + 1;
    const VALVE_PUSH_RIGHT = valveMidX - 3;
    const valvePiston = new MovingSegment({
      ax: VALVE_PUSH_LEFT, ay: valveY0,
      bx: VALVE_PUSH_LEFT, by: valveY1,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1.2,
    });
    sim.movingSegments.push(valvePiston);
    const VALVE_PUSH_SPEED = 0.06;      // slow — pressure driver, not a hammer
    const VALVE_RETURN_FACTOR = 8;      // fast retract, invisible
    let valvePhase: "push" | "return" = "push";

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
        // Kick the valve piston into its push stroke too.
        valvePiston.active = true;
        valvePiston.vax = VALVE_PUSH_SPEED;
        valvePiston.vbx = VALVE_PUSH_SPEED;
      }
      if (started) {
        // Compressor bounce
        if (piston.ax < PISTON_LEFT && piston.vax < 0) {
          piston.vax = state.pistonSpeed; piston.vbx = state.pistonSpeed;
        } else if (piston.ax > PISTON_RIGHT && piston.vax > 0) {
          piston.vax = -state.pistonSpeed; piston.vbx = -state.pistonSpeed;
        }
        // Valve piston cycle — slow active push right, fast ghost return.
        // Keeps the high-side pressurised so gas keeps squeezing through
        // the throat instead of the whole chamber equilibrating.
        if (valvePhase === "push") {
          if (valvePiston.ax >= VALVE_PUSH_RIGHT) {
            valvePhase = "return";
            valvePiston.active = false;
            valvePiston.vax = -VALVE_PUSH_SPEED * VALVE_RETURN_FACTOR;
            valvePiston.vbx = -VALVE_PUSH_SPEED * VALVE_RETURN_FACTOR;
          }
        } else {
          if (valvePiston.ax <= VALVE_PUSH_LEFT) {
            valvePhase = "push";
            valvePiston.clearContactZone(sim);
            valvePiston.active = true;
            valvePiston.vax = VALVE_PUSH_SPEED;
            valvePiston.vbx = VALVE_PUSH_SPEED;
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
          label: "hot coil (indoors)",
          v: T(() => sim.temperatureOf(condHx.atomIndices)),
        },
        {
          label: "cold coil (outdoors)",
          v: T(() => sim.temperatureOf(evapHx.atomIndices)),
        },
        {
          label: "electricity used",
          v: R(() => (started ? piston.workInput.toFixed(1) : "—")),
        },
        // In an EXPLODED schematic the sub-chambers are isolated so these Q
        // numbers reflect each thermostat's local heat exchange, not the
        // coupled Q_hot/Q_cold of a closed refrigeration loop. Labelled
        // accordingly so users don't try to compute COP off them.
        {
          label: "heat exchanged, condenser",
          v: R(() =>
            started ? (condTherm.energyOut - condTherm.energyIn).toFixed(1) : "—"
          ),
        },
        {
          label: "heat exchanged, evaporator",
          v: R(() =>
            started ? (evapTherm.energyIn - evapTherm.energyOut).toFixed(1) : "—"
          ),
        },
        {
          label: "high-pressure density",
          v: R(() => (valveHighIdx.length / ((valveMidX - valveX0 - 1) * (valveY1 - valveY0 - 2))).toFixed(2)),
        },
        {
          label: "low-pressure density",
          v: R(() => (valveLowIdx.length / ((valveX1 - valveMidX - 1) * (valveY1 - valveY0 - 2))).toFixed(2)),
        },
      ],
      series: [
        { name: "compressor gas", colour: "#f0c060", value: () => sim.temperatureOf(compGasIdx) },
        { name: "hot coil", colour: "#e07a5f", value: () => sim.temperatureOf(condHx.atomIndices) },
        { name: "cold coil", colour: "#5f8fb8", value: () => sim.temperatureOf(evapHx.atomIndices) },
        { name: "evaporator gas", colour: "#7091b8", value: () => sim.temperatureOf(evapGasIdx) },
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
        // Reservoir tints — hot above the top, cold below the bottom
        {
          label: "",
          xMin: CX0, yMin: OY, xMax: CX1, yMax: OY + 2.5,
          tint: "rgba(210,80,90,0.14)",
        },
        {
          label: "",
          xMin: CX0, yMin: -2.5, xMax: CX1, yMax: 0,
          tint: "rgba(70,130,180,0.16)",
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
    blurb: "All four heat-pump stages laid out as a diagram — compressor, condenser, expansion valve, evaporator — each a separate chamber with its own real physics. Bold coloured arrows show the schematic flow (hot vapour → liquid → cold mix → cool vapour → back). Coloured by temperature: watch the condenser gas glow yellow against a hot indoor coil, the evaporator gas sit deep blue against a cold outdoor coil, and the valve — with its own upstream pressure piston pushing gas through the 2σ throat — maintain a real density gradient across the narrow gap. The sub-chambers are physically isolated (atoms don't circulate between them) so each part shows its own local behaviour without geometry compromises.",
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
