import { Simulation, ThermostatGroup, rescaleToTemperature } from "../sim/simulation";
import { seedLattice } from "../sim/init";
import { Rng } from "../sim/rng";
import { addHeatExchanger } from "../sim/heatExchanger";
import { MovingSegment } from "../sim/movingSegment";
import type { LineSegment, PotentialParams } from "../sim/types";
import type { RegionOverlay as RendererRegion } from "../render/canvasRenderer";
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
    // Unit anchors — defaults to DEFAULT_ANCHORS.
    unitAnchors?: UnitAnchors;
    // Optional palette range in °C for the legend.
    cMin?: number;
    cMax?: number;
    // Live sliders in the panel.
    sliders?: ScenarioSlider[];
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
        {
          label: "reservoir (outside)",
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
      cMin: -30,
      cMax: 120,
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
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}
