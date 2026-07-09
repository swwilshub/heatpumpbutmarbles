import { describe, it, expect } from "vitest";
import { Simulation, ThermostatGroup } from "../src/sim/simulation";
import { seedLattice } from "../src/sim/init";
import { Rng } from "../src/sim/rng";
import type { LineSegment } from "../src/sim/types";

// Langevin drives velocities toward Maxwell-Boltzmann at the target T,
// regardless of starting T. This is the fluctuation-dissipation guarantee.
// We also check that ThermostatGroup's energyIn / energyOut accounting is
// consistent with the KE actually delivered to the atoms.

function box(x0: number, y0: number, x1: number, y1: number): LineSegment[] {
  return [
    { ax: x0, ay: y0, bx: x1, by: y0, epsilon: 1, sigma: 1 },
    { ax: x1, ay: y0, bx: x1, by: y1, epsilon: 1, sigma: 1 },
    { ax: x1, ay: y1, bx: x0, by: y1, epsilon: 1, sigma: 1 },
    { ax: x0, ay: y1, bx: x0, by: y0, epsilon: 1, sigma: 1 },
  ];
}

describe("Langevin thermostat", () => {
  it("cold system heated toward target T; hot system cooled toward target T", () => {
    const heatUp = runToTarget(0.3, 1.0);
    expect(Math.abs(heatUp - 1.0)).toBeLessThan(0.1);
    const coolDown = runToTarget(3.0, 1.0);
    expect(Math.abs(coolDown - 1.0)).toBeLessThan(0.1);
  });
  it("energy bookkeeping: net (in - out) matches ΔKE of thermostatted atoms + work dissipated to pair potential", () => {
    const { netFromThermostat, dKE, dPE } = runBookkeeping();
    // Net energy the thermostat says it added should equal the total change
    // in the system's mechanical energy. Fluctuation-scale tolerance.
    const drift = Math.abs(netFromThermostat - (dKE + dPE));
    expect(drift).toBeLessThan(0.05 * Math.max(1, Math.abs(dKE + dPE)));
  });
});

function runToTarget(startT: number, targetT: number): number {
  const sim = new Simulation({
    domain: { xMin: 0, yMin: 0, xMax: 15, yMax: 15 },
    potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
    segments: box(1, 1, 14, 14),
    dt: 0.004,
    capacity: 400,
  });
  sim.setRng(new Rng(999));
  const n = seedLattice(sim, { xMin: 2, yMin: 2, xMax: 13, yMax: 13 }, 1.3, startT, new Rng(7));
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  sim.thermostats.push(new ThermostatGroup(idx, targetT, 1.0));
  sim.primeForces();
  sim.advance(15000);
  // Average measured T over the last 2000 steps to beat fluctuation noise.
  let acc = 0;
  const samples = 40;
  for (let k = 0; k < samples; k++) {
    sim.advance(50);
    acc += sim.temperatureOf(idx);
  }
  return acc / samples;
}

function runBookkeeping() {
  const sim = new Simulation({
    domain: { xMin: 0, yMin: 0, xMax: 15, yMax: 15 },
    potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
    segments: box(1, 1, 14, 14),
    dt: 0.004,
    capacity: 400,
  });
  sim.setRng(new Rng(1234));
  const n = seedLattice(sim, { xMin: 2, yMin: 2, xMax: 13, yMax: 13 }, 1.3, 0.5, new Rng(5));
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const t = new ThermostatGroup(idx, 1.5, 0.5);
  sim.thermostats.push(t);
  sim.primeForces();
  const dInit = sim.diagnostics();
  sim.advance(8000);
  const dFinal = sim.diagnostics();
  return {
    netFromThermostat: t.energyIn - t.energyOut,
    dKE: dFinal.kineticEnergy - dInit.kineticEnergy,
    dPE: dFinal.potentialEnergy - dInit.potentialEnergy,
  };
}
