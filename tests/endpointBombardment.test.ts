import { describe, it, expect } from "vitest";
import { Simulation } from "../src/sim/simulation";
import type { LineSegment } from "../src/sim/types";

// Regression test for the endpoint-force pathology described in the brief.
//
// With a raw segment-normal formulation, an atom approaching a segment near
// (but past) an endpoint from the *side* experiences no force until it
// crosses the segment's infinite line — then it feels a normal kick. Coming
// out, it does so with more (or less) kinetic energy than it went in, and
// total energy is not conserved. Firing at endpoint tips is the pathological
// case.
//
// With the closest-point-on-segment formulation this test uses, the barrier
// force is radial around the endpoint (like a point atom), so energy is
// conserved to integrator precision on any trajectory.

function fireAtTip(startX: number, startY: number, vx: number, vy: number) {
  // Single horizontal segment ending at (0,0).
  const segments: LineSegment[] = [
    { ax: -5, ay: 0, bx: 0, by: 0, epsilon: 1, sigma: 1 },
  ];
  const sim = new Simulation({
    domain: { xMin: -10, yMin: -10, xMax: 10, yMax: 10 },
    potential: { kind: "wca", epsilon: 1, sigma: 1, rCut: 2.5 },
    segments,
    dt: 0.001,
    capacity: 4,
  });
  sim.addAtom(startX, startY, vx, vy);
  sim.primeForces();
  const e0 = sim.diagnostics().totalEnergy;
  sim.advance(6000);
  const e1 = sim.diagnostics().totalEnergy;
  return { e0, e1, drift: Math.abs(e1 - e0) / Math.max(1e-9, Math.abs(e0)) };
}

describe("endpoint bombardment", () => {
  // Atoms in these tests all start OUTSIDE the WCA cutoff (1.122σ) — starting
  // inside means the initial state includes PE from a steep gradient that no
  // integrator can resolve without an unrealistically small dt. The physical
  // property under test is energy conservation across the *transition* from
  // "closest point is on segment interior" to "closest point is the endpoint",
  // which is where a naive normal-vector barrier would leak energy.

  it("energy conserved for a grazing shot past the tip (0,0)", () => {
    // Falls straight down at x=0.8: closest point is on-segment while y>0,
    // becomes the tip after y crosses 0, transitions back to on-segment as
    // x-position hasn't changed. (Actually here x stays at 0.8 the whole
    // time so the closest point is always the tip — this shot isolates the
    // radial endpoint force from any transition.)
    const { drift } = fireAtTip(0.8, 1.5, 0, -2.5);
    expect(drift).toBeLessThan(1e-3);
  });
  it("energy conserved on a shot aimed at the tip endpoint from above-right", () => {
    const { drift } = fireAtTip(1.5, 1.5, -2, -2);
    expect(drift).toBeLessThan(1e-3);
  });
  it("energy conserved on a shot that crosses from segment-interior region to tip region", () => {
    // Starts above the segment interior (closest point on segment), moves
    // right and down toward the tip and beyond (closest point becomes tip).
    // This is the exact transition where naive-normal barriers fail.
    const { drift } = fireAtTip(-2, 1.5, 3, -1.2);
    expect(drift).toBeLessThan(1e-3);
  });
  it("energy conserved when swinging around the far endpoint", () => {
    const { drift } = fireAtTip(-6, 0.6, 4, -1);
    expect(drift).toBeLessThan(1e-3);
  });
});
