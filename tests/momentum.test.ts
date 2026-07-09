import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/simulation";

// With no barriers, pair forces obey Newton's third law, so total linear
// momentum is exactly conserved by the pair loop. Any drift comes from
// floating-point round-off in the Verlet updates.

describe("momentum conservation (no barriers)", () => {
  it("net momentum stays ~zero for an isolated LJ cluster", () => {
    const sim = new Simulation({
      domain: { xMin: -100, yMin: -100, xMax: 100, yMax: 100 },
      potential: { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      segments: [],
      dt: 0.002,
      capacity: 32,
    });
    // Symmetric pair fired at each other along x.
    sim.addAtom(-1.5, 0, 0.4, 0.1);
    sim.addAtom(1.5, 0, -0.4, -0.1);
    // A third off to the side with velocity, non-symmetric to break trivial symmetry.
    sim.addAtom(0, 3, 0.2, -0.05);
    sim.primeForces();
    const d0 = sim.diagnostics();
    sim.advance(50000);
    const d1 = sim.diagnostics();
    expect(Math.abs(d1.momentumX - d0.momentumX)).toBeLessThan(1e-8);
    expect(Math.abs(d1.momentumY - d0.momentumY)).toBeLessThan(1e-8);
  });
});
