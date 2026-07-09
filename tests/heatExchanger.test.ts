import { describe, it, expect } from "vitest";
import { Simulation, rescaleToTemperature } from "../src/sim/simulation";
import { seedLattice } from "../src/sim/init";
import { Rng } from "../src/sim/rng";
import { addHeatExchanger } from "../src/sim/heatExchanger";
import type { LineSegment } from "../src/sim/types";

// Two chambers, hot on the left (T=2) and cold on the right (T=0.5), share
// a vertical partition. In one config the partition is a plain line barrier
// (thermally insulating). In the other, it's an atom-based heat-exchanger
// wall (line barrier + tethered atoms overlapping it, which conducts).
// Assertion: the exchanger config drives ΔT toward zero; the plain barrier
// preserves the initial ΔT.

function box(x0: number, y0: number, x1: number, y1: number): LineSegment[] {
  return [
    { ax: x0, ay: y0, bx: x1, by: y0, epsilon: 1, sigma: 1 },
    { ax: x1, ay: y0, bx: x1, by: y1, epsilon: 1, sigma: 1 },
    { ax: x1, ay: y1, bx: x0, by: y1, epsilon: 1, sigma: 1 },
    { ax: x0, ay: y1, bx: x0, by: y0, epsilon: 1, sigma: 1 },
  ];
}

function twoChambers(useExchanger: boolean) {
  const HOT_T = 2.0;
  const COLD_T = 0.5;
  const midX = 12;
  const segments: LineSegment[] = [
    ...box(0, 0, 24, 12),
  ];
  const sim = new Simulation({
    domain: { xMin: -1, yMin: -1, xMax: 25, yMax: 13 },
    potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
    segments,
    dt: 0.004,
    capacity: 800,
  });
  const rngHot = new Rng(1);
  const rngCold = new Rng(2);
  // NB: no atoms placed within σ of the future partition so the initial
  // config doesn't overlap the wall barrier or its tethered atoms.
  const nHot = seedLattice(
    sim,
    { xMin: 1, yMin: 1, xMax: midX - 1.5, yMax: 11 },
    1.2,
    HOT_T,
    rngHot
  );
  const nCold = seedLattice(
    sim,
    { xMin: midX + 1.5, yMin: 1, xMax: 23, yMax: 11 },
    1.2,
    COLD_T,
    rngCold
  );
  const hotIdx: number[] = [];
  const coldIdx: number[] = [];
  for (let i = 0; i < nHot; i++) hotIdx.push(i);
  for (let i = nHot; i < nHot + nCold; i++) coldIdx.push(i);
  if (useExchanger) {
    const h = addHeatExchanger(sim, {
      ax: midX,
      ay: 1,
      bx: midX,
      by: 11,
      spacing: 1.15,
      layers: 2,
      layerOffset: 1.15,
      tetherK: 40,
      sigma: 1,
      epsilon: 1,
    });
    segments.push(h.barrier);
  } else {
    segments.push({ ax: midX, ay: 1, bx: midX, by: 11, epsilon: 1, sigma: 1 });
  }
  sim.primeForces();
  // Brief equilibration inside each chamber, thermostat locked to initial T.
  // Rescale each chamber independently so wall atoms don't drag them together.
  for (let k = 0; k < 30; k++) {
    sim.advance(50);
    // Rescale each region's velocities to hold its target T.
    rescaleGroup(sim, hotIdx, HOT_T);
    rescaleGroup(sim, coldIdx, COLD_T);
  }
  // Measurement: T of each chamber over next N steps.
  const measure = () => ({
    hot: sim.temperatureOf(hotIdx),
    cold: sim.temperatureOf(coldIdx),
  });
  const t0 = measure();
  // Free evolution, no thermostat — the exchanger's atoms carry heat across.
  sim.advance(30000);
  const t1 = measure();
  return { before: t0, after: t1, sim };
}

function rescaleGroup(sim: Simulation, idx: number[], target: number) {
  let ke = 0;
  for (const i of idx) ke += sim.velX[i]! ** 2 + sim.velY[i]! ** 2;
  const T = ke / (2 * idx.length);
  if (T <= 0) return;
  const s = Math.sqrt(target / T);
  for (const i of idx) {
    sim.velX[i] = sim.velX[i]! * s;
    sim.velY[i] = sim.velY[i]! * s;
  }
}

describe("heat-exchanger wall", () => {
  it("PLAIN line barrier: ΔT is preserved (thermally insulating)", () => {
    const r = twoChambers(false);
    const dT0 = r.before.hot - r.before.cold;
    const dT1 = r.after.hot - r.after.cold;
    // Some numerical noise ok, but at least 70% of ΔT survives.
    expect(dT1 / dT0).toBeGreaterThan(0.7);
  });
  it("EXCHANGER wall: ΔT collapses toward zero", () => {
    const r = twoChambers(true);
    const dT0 = r.before.hot - r.before.cold;
    const dT1 = r.after.hot - r.after.cold;
    // Signal check: ΔT must drop to below half its initial value.
    expect(dT1 / dT0).toBeLessThan(0.5);
    // And both sides moved toward each other, not just cold warming while hot ran away.
    expect(r.after.hot).toBeLessThan(r.before.hot);
    expect(r.after.cold).toBeGreaterThan(r.before.cold);
  });
});
