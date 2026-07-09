import { Simulation, ThermostatGroup, rescaleToTemperature } from "../sim/simulation";
import { seedLattice } from "../sim/init";
import { Rng } from "../sim/rng";
import { addHeatExchanger } from "../sim/heatExchanger";
import { MovingSegment } from "../sim/movingSegment";
import type { LineSegment, PotentialParams } from "../sim/types";

// Scenarios are declarative presets: a builder returns a fresh Simulation,
// and an optional `tick(sim, step)` hook lets the scenario schedule events
// (segment swaps, thermostat toggles) at particular simulation steps.
// Runtime state that shouldn't outlive a rebuild lives inside the closure
// returned by build().

export interface Readout {
  label: string;
  value: () => string;
}

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  build: () => {
    sim: Simulation;
    tick: (step: number) => void;
    readouts?: Readout[];
  };
}

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

function confined(potential: PotentialParams, T: number): Scenario["build"] {
  return () => {
    const sim = new Simulation({
      domain: { xMin: 0, yMin: 0, xMax: 30, yMax: 22 },
      potential,
      segments: box(1, 1, 29, 21),
      dt: 0.005,
      capacity: 2000,
    });
    seedLattice(sim, { xMin: 3, yMin: 3, xMax: 27, yMax: 19 }, 1.2, T, new Rng(2024));
    sim.primeForces();
    let equilibrateUntil = 400;
    return {
      sim,
      tick: (step: number) => {
        if (step < equilibrateUntil && step % 50 === 0 && step > 0) {
          rescaleToTemperature(sim, T);
        }
      },
    };
  };
}

function freeExpansion(
  potential: PotentialParams,
  T: number,
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
      T,
      new Rng(4242)
    );
    sim.primeForces();
    let released = false;
    return {
      sim,
      tick: (step: number) => {
        if (!released) {
          if (step % 50 === 0 && step > 0) rescaleToTemperature(sim, T);
          if (step >= releaseAtStep) {
            sim.setSegments(box(0, 0, largeSize, largeSize));
            released = true;
          }
        }
      },
    };
  };
}

// Assembles a compressor + hot exchanger + hot reservoir into a demo that
// shows all M3 components together. Not a closed refrigeration loop —
// that's the M4 work — but demonstrates real work input, real heat
// absorption by a thermostatted reservoir, and the expected T rise.
function compressorHotExchanger(): Scenario["build"] {
  return () => {
    const T_HOT = 0.6; // Reservoir temperature (target for exchanger's atoms)
    const T_GAS = 1.0;
    // Chamber: outer walls + moving piston on the right.
    const chamber: LineSegment[] = [
      { ax: 0, ay: 0, bx: 30, by: 0, epsilon: 1, sigma: 1 },
      { ax: 30, ay: 0, bx: 30, by: 20, epsilon: 1, sigma: 1 },
      { ax: 30, ay: 20, bx: 0, by: 20, epsilon: 1, sigma: 1 },
      { ax: 0, ay: 20, bx: 0, by: 0, epsilon: 1, sigma: 1 },
    ];
    const sim = new Simulation({
      domain: { xMin: -1, yMin: -1, xMax: 31, yMax: 21 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: chamber,
      dt: 0.004,
      capacity: 800,
    });
    sim.setRng(new Rng(7));
    // Refrigerant fills the left ~2/3 of the chamber so the piston has room.
    seedLattice(
      sim,
      { xMin: 1.5, yMin: 1.5, xMax: 18, yMax: 12 },
      1.3,
      T_GAS,
      new Rng(11)
    );
    // Heat-exchanger wall spanning the top of the chamber, replacing the top
    // static wall. Two layers of tethered atoms below y=20.
    const hx = addHeatExchanger(sim, {
      ax: 3,
      ay: 15,
      bx: 27,
      by: 15,
      spacing: 1.15,
      layers: 2,
      layerOffset: 1.0,
      tetherK: 40,
      sigma: 1,
      epsilon: 1,
    });
    chamber.push(hx.barrier);
    // Langevin thermostat on the wall atoms — this is the "hot" reservoir.
    // Actually here the reservoir is COLDER than the gas — so heat FLOWS into
    // the reservoir. That's what a condenser does: dump heat to the outside.
    const thermostat = new ThermostatGroup(hx.atomIndices, T_HOT, 0.5);
    sim.thermostats.push(thermostat);
    // Piston on the right side, initially stationary — kicks in at step 500.
    const piston = new MovingSegment({
      ax: 25,
      ay: 1,
      bx: 25,
      by: 14,
      vax: 0, vay: 0, vbx: 0, vby: 0,
      epsilon: 1, sigma: 1,
    });
    sim.movingSegments.push(piston);
    sim.primeForces();
    // Equilibrate briefly with velocity rescale on the gas.
    const gasIdx: number[] = [];
    for (let i = 0; i < sim.n; i++) {
      if (sim.kind[i] === 0) gasIdx.push(i);
    }
    let started = false;
    let cycleStartStep = 0;
    return {
      sim,
      tick: (step: number) => {
        if (step < 300 && step % 50 === 0 && step > 0) {
          rescaleToTemperature(sim, T_GAS);
        }
        if (!started && step >= 300) {
          started = true;
          cycleStartStep = step;
          // Start slow compression stroke.
          piston.vax = -0.03;
          piston.vbx = -0.03;
          piston.workInput = 0;
          thermostat.energyIn = 0;
          thermostat.energyOut = 0;
        }
        // Reverse piston when it approaches the middle of the chamber
        if (started && piston.ax < 12 && piston.vax < 0) {
          piston.vax = 0.03;
          piston.vbx = 0.03;
        }
        if (started && piston.ax > 25 && piston.vax > 0) {
          piston.vax = -0.03;
          piston.vbx = -0.03;
        }
        void cycleStartStep;
      },
      readouts: [
        {
          label: "T gas",
          value: () => sim.temperatureOf(gasIdx).toFixed(3),
        },
        {
          label: "T wall",
          value: () => sim.temperatureOf(hx.atomIndices).toFixed(3),
        },
        {
          label: "W (compressor)",
          value: () => piston.workInput.toFixed(2),
        },
        {
          label: "Q_hot (to reservoir)",
          value: () => (thermostat.energyOut - thermostat.energyIn).toFixed(2),
        },
      ],
    };
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "confined_lj",
    name: "confined LJ gas",
    blurb: "A Lennard-Jones gas in a box, thermostatted to T*=1.0 for 400 steps then left alone. Baseline for the other experiments.",
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
    blurb: "A piston reciprocates inside a chamber whose top wall is a heat-exchanger connected to a cold reservoir. On the compression stroke, gas heats and dumps heat into the reservoir (Q_hot rises); on the return stroke, gas cools. This is one side of a real heat pump — the condenser.",
    build: compressorHotExchanger(),
  },
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}
