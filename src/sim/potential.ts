import type { PotentialParams } from "./types";

// Truncated-and-shifted Lennard-Jones (or WCA when kind==="wca").
//
// U_LJ(r) = 4ε[(σ/r)^12 - (σ/r)^6]
// F_i = -dU/dr * (r_ij / r)
// For efficiency we return (magnitude_over_r) so caller does F = k * r_vec.
//
// For WCA we cutoff at 2^(1/6)σ (LJ minimum) and shift so U(r_c)=0.
// For LJ we truncate at rCut (user-supplied, e.g. 2.5σ) and shift so U(r_c)=0.

export const WCA_CUTOFF_FACTOR = Math.pow(2, 1 / 6);

export function effectiveCutoff(p: PotentialParams): number {
  return p.kind === "wca" ? WCA_CUTOFF_FACTOR * p.sigma : p.rCut;
}

export function shiftEnergy(p: PotentialParams): number {
  const rc = effectiveCutoff(p);
  const sr2 = (p.sigma * p.sigma) / (rc * rc);
  const sr6 = sr2 * sr2 * sr2;
  const sr12 = sr6 * sr6;
  return 4 * p.epsilon * (sr12 - sr6);
}

// Returns { u, k } where k = |F| / r  (so F_vec_on_i = k * (r_i - r_j)).
// r2 is |r_ij|^2, precomputed by caller.
export function pairForce(
  r2: number,
  p: PotentialParams,
  uShift: number,
  rCut2: number
): { u: number; k: number } {
  if (r2 >= rCut2) return { u: 0, k: 0 };
  const sigma2 = p.sigma * p.sigma;
  const sr2 = sigma2 / r2;
  const sr6 = sr2 * sr2 * sr2;
  const sr12 = sr6 * sr6;
  const u = 4 * p.epsilon * (sr12 - sr6) - uShift;
  // dU/dr = -24ε/r * (2 sr12 - sr6)
  // F_on_i = -dU/dr * r_hat = (24ε/r) (2 sr12 - sr6) * (r_ij / r)
  //        = (24ε / r^2) (2 sr12 - sr6) * r_ij
  const k = (24 * p.epsilon * (2 * sr12 - sr6)) / r2;
  return { u, k };
}
