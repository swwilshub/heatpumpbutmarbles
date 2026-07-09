import { describe, it, expect } from "vitest";
import { Simulation, rescaleToTemperature } from "../src/sim/simulation";
import { seedLattice } from "../src/sim/init";
import { Rng } from "../src/sim/rng";
import type { LineSegment, PotentialParams } from "../src/sim/types";

// Thermodynamic validation. These are the M2 experiments from the brief and
// they double as story-mode presets. The physical claim under test:
//   Total energy is conserved; a "free expansion" (segment set swapped from
//   a small box to a large one) redistributes energy between KE and PE.
//   If the potential is purely repulsive (WCA), a dense gas has PE > 0 which
//   drops on expansion → KE rises → TEMPERATURE RISES.
//   If the potential has an attractive well (LJ) and initial density is
//   above ~well-density, atoms sit in the well with PE < 0. On expansion
//   pairs separate → PE rises toward 0 → KE falls → TEMPERATURE FALLS.

function box(x0: number, y0: number, x1: number, y1: number): LineSegment[] {
  return [
    { ax: x0, ay: y0, bx: x1, by: y0, epsilon: 1, sigma: 1 },
    { ax: x1, ay: y0, bx: x1, by: y1, epsilon: 1, sigma: 1 },
    { ax: x1, ay: y1, bx: x0, by: y1, epsilon: 1, sigma: 1 },
    { ax: x0, ay: y1, bx: x0, by: y0, epsilon: 1, sigma: 1 },
  ];
}

function runExpansion(
  potential: PotentialParams,
  initSize: number,
  finalSize: number,
  spacing: number,
  targetT: number,
  seed: number
) {
  const domain = { xMin: -1, yMin: -1, xMax: finalSize + 1, yMax: finalSize + 1 };
  const sim = new Simulation({
    domain,
    potential,
    segments: box(0, 0, initSize, initSize),
    dt: 0.003,
    capacity: 2000,
  });
  seedLattice(
    sim,
    { xMin: 0.5, yMin: 0.5, xMax: initSize - 0.5, yMax: initSize - 0.5 },
    spacing,
    targetT,
    new Rng(seed)
  );
  sim.primeForces();
  // Equilibrate in small box with velocity rescaling.
  for (let k = 0; k < 40; k++) {
    sim.advance(50);
    rescaleToTemperature(sim, targetT);
  }
  // Measurement window BEFORE expansion (thermostat off).
  let keBefore = 0;
  const beforeSteps = 20;
  for (let k = 0; k < beforeSteps; k++) {
    sim.advance(50);
    keBefore += sim.diagnostics().kineticEnergy;
  }
  keBefore /= beforeSteps;
  const eBefore = sim.diagnostics().totalEnergy;
  // Swap to large box; atoms free-expand.
  sim.setSegments(box(0, 0, finalSize, finalSize));
  // Let the transient settle. Distance ballistic-crossing takes ~ finalSize / v_thermal
  // steps. At T=1, v ~ 1; at T=2 v~1.4. Ten transit times is plenty.
  sim.advance(4000);
  // Measurement window AFTER equilibration.
  let keAfter = 0;
  const afterSteps = 40;
  for (let k = 0; k < afterSteps; k++) {
    sim.advance(50);
    keAfter += sim.diagnostics().kineticEnergy;
  }
  keAfter /= afterSteps;
  const eAfter = sim.diagnostics().totalEnergy;
  return { keBefore, keAfter, eBefore, eAfter, n: sim.n };
}

describe("free expansion — thermodynamic signature", () => {
  // Note on E-conservation: swapping the segment set is a *discontinuous
  // change in the external potential* — the wall PE of atoms sitting inside
  // the old walls' repulsive shell vanishes instantly. Total E is not
  // conserved across the swap by construction, only across the subsequent
  // dynamics. M1's energyConservation test covers the dynamic drift. Here
  // we only assert the sign of ΔKE, which is what makes these presets
  // pedagogically valuable.

  it("dense WCA gas WARMS on free expansion (PE drops → KE rises)", () => {
    // ρ ≈ 1.11: NN spacing inside WCA cutoff → significant repulsive PE.
    const r = runExpansion(
      { kind: "wca", epsilon: 1, sigma: 1, rCut: 2.5 },
      6,
      12,
      0.95,
      1.0,
      101
    );
    const delta = (r.keAfter - r.keBefore) / r.n;
    expect(delta).toBeGreaterThan(0.1);
  });

  it("moderate-density LJ gas COOLS on free expansion (PE rises toward 0 → KE falls)", () => {
    // Initial density ~0.55, T=2.5 chosen so total-E-per-atom > 0 (the gas
    // can actually expand rather than remain bound), but enough attractive
    // PE is stored that its release into KE-loss dominates when atoms
    // separate. Below-critical parameters cause partial condensation and
    // muddy the signal; well-above-critical loses the effect entirely.
    const r = runExpansion(
      { kind: "lj", epsilon: 1, sigma: 1, rCut: 2.5 },
      8,
      14,
      1.35,
      2.5,
      202
    );
    const delta = (r.keAfter - r.keBefore) / r.n;
    expect(delta).toBeLessThan(-0.1);
  });
});
