import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/simulation";
import { MovingSegment } from "../src/sim/movingSegment";
import { seedLattice } from "../src/sim/init";
import { Rng } from "../src/sim/rng";
import type { LineSegment } from "../src/sim/types";

// A moving segment pushed into a gas does mechanical work on the gas. Total
// energy of the gas has no other source (no thermostat here), so:
//     ΔE_gas = W_blade  (± drift from Verlet at moving-boundary steps)
// The moving-boundary case is stricter than plain M1 energy conservation
// because the blade's contribution to PE changes as it moves, and only the
// work-integrated bookkeeping catches it.

describe("compressor blade — work accounting", () => {
  it("W_blade delivered to gas matches ΔE_gas to within a few percent", () => {
    // Fixed 3 walls + one moving wall on the right pushing left.
    const staticWalls: LineSegment[] = [
      { ax: 0, ay: 0, bx: 20, by: 0, epsilon: 1, sigma: 1 },
      { ax: 20, ay: 0, bx: 20, by: 20, epsilon: 1, sigma: 1 }, // right wall (will
      //   be behind the piston; keep it too so atoms can't tunnel out)
      { ax: 20, ay: 20, bx: 0, by: 20, epsilon: 1, sigma: 1 },
      { ax: 0, ay: 20, bx: 0, by: 0, epsilon: 1, sigma: 1 },
    ];
    const sim = new Simulation({
      domain: { xMin: -2, yMin: -2, xMax: 22, yMax: 22 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: staticWalls,
      dt: 0.003,
      capacity: 800,
    });
    seedLattice(sim, { xMin: 2, yMin: 2, xMax: 12, yMax: 18 }, 1.2, 1.0, new Rng(9));
    // The piston: a vertical segment starting at x=14, moving left at v=0.05.
    const piston = new MovingSegment({
      ax: 14, ay: 0, bx: 14, by: 20,
      vax: -0.05, vay: 0, vbx: -0.05, vby: 0,
      epsilon: 1, sigma: 1,
    });
    sim.movingSegments.push(piston);
    sim.primeForces();
    // Let the system settle for a moment with the piston stationary. We do
    // this by running 500 steps first with velocity zeroed, then set piston
    // velocity to its target for the compression stroke.
    piston.vax = 0; piston.vbx = 0;
    sim.advance(500);
    const eBefore = sim.diagnostics().totalEnergy;
    piston.workInput = 0;
    piston.vax = -0.05; piston.vbx = -0.05;
    // Compress for a run.
    sim.advance(10000);
    // Freeze the piston, let system settle briefly to consistent state.
    piston.vax = 0; piston.vbx = 0;
    sim.advance(500);
    const eAfter = sim.diagnostics().totalEnergy;
    const dE = eAfter - eBefore;
    const w = piston.workInput;
    // Sanity: both should be positive (compression injects energy).
    expect(w).toBeGreaterThan(0);
    expect(dE).toBeGreaterThan(0);
    // Consistency: W and ΔE should agree to within ~5% (Verlet drift + wall PE
    // shift as the piston moved past static wall's cutoff zone).
    const rel = Math.abs(w - dE) / Math.max(1, Math.abs(dE));
    expect(rel).toBeLessThan(0.08);
  });
});
