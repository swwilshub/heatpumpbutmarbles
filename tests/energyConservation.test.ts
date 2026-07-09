import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/simulation";
import { seedLattice } from "../src/sim/init";
import { Rng } from "../src/sim/rng";
import type { LineSegment } from "../src/sim/types";

// A box built from four line segments confining an LJ gas at moderate density
// and temperature. Integrator is symplectic velocity-Verlet with dt=0.002, so
// energy drift should be well under 0.1% over the run — the spec's floor.

function boxSegments(xMin: number, yMin: number, xMax: number, yMax: number): LineSegment[] {
  const wallEps = 1;
  const wallSigma = 1;
  return [
    { ax: xMin, ay: yMin, bx: xMax, by: yMin, epsilon: wallEps, sigma: wallSigma },
    { ax: xMax, ay: yMin, bx: xMax, by: yMax, epsilon: wallEps, sigma: wallSigma },
    { ax: xMax, ay: yMax, bx: xMin, by: yMax, epsilon: wallEps, sigma: wallSigma },
    { ax: xMin, ay: yMax, bx: xMin, by: yMin, epsilon: wallEps, sigma: wallSigma },
  ];
}

describe("energy conservation", () => {
  it("velocity Verlet with LJ + line-segment walls drifts under 0.1% over 20k steps", () => {
    const domain = { xMin: 0, yMin: 0, xMax: 30, yMax: 30 };
    const sim = new Simulation({
      domain,
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: boxSegments(0, 0, 30, 30),
      dt: 0.002,
      capacity: 2000,
    });
    const rng = new Rng(42);
    const n = seedLattice(sim, { xMin: 2, yMin: 2, xMax: 28, yMax: 28 }, 1.15, 1.0, rng);
    expect(n).toBeGreaterThan(300);
    sim.primeForces();
    const d0 = sim.diagnostics();
    // burn-in — the shifted-truncated potential has a tiny impulse crossing
    // rCut which shows up as O(1e-4) per-step noise; a burn-in isolates
    // the *drift* (systematic accumulation) from that stationary noise.
    sim.advance(2000);
    const dRef = sim.diagnostics();
    sim.advance(20000);
    const dEnd = sim.diagnostics();
    const scale = Math.abs(dRef.totalEnergy);
    const drift = Math.abs(dEnd.totalEnergy - dRef.totalEnergy) / scale;
    // Also basic sanity: energy is finite, PE is not NaN, T > 0.
    expect(Number.isFinite(dEnd.totalEnergy)).toBe(true);
    expect(dEnd.temperature).toBeGreaterThan(0);
    expect(drift).toBeLessThan(1e-3);
    // And starting E is reasonable (KE close to T·N in 2D)
    expect(d0.kineticEnergy).toBeGreaterThan(0);
  });
});
