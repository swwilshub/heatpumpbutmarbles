import { Simulation, rescaleToTemperature } from "../sim/simulation";
import { seedLattice } from "../sim/init";
import { Rng } from "../sim/rng";
import type { LineSegment, PotentialParams } from "../sim/types";

// Scenarios are declarative presets: a builder returns a fresh Simulation,
// and an optional `tick(sim, step)` hook lets the scenario schedule events
// (segment swaps, thermostat toggles) at particular simulation steps.
// Runtime state that shouldn't outlive a rebuild lives inside the closure
// returned by build().

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  build: () => { sim: Simulation; tick: (step: number) => void };
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
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}
