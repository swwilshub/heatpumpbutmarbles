import type { LineSegment } from "./types";
import { WCA_CUTOFF_FACTOR } from "./potential";

// Line-segment barrier force uses the vector from the *closest point on the
// segment* to the atom. This is essential for energy conservation at the
// endpoints — using the raw segment normal creates a discontinuity where the
// segment ends, letting atoms sneak in from the side with no force applied and
// come out kicked. See docs/notes-endpoint-forces.md.

// The barrier itself uses a WCA-style purely repulsive potential (piecewise
// LJ up to r = 2^(1/6) σ_wall, shifted so U(r_c) = 0). This keeps walls
// energy-conserving under integration and thermally passive.

export interface BarrierAccumulator {
  fx: number;
  fy: number;
  u: number;
}

export function accumulateBarrierForce(
  px: number,
  py: number,
  segments: readonly LineSegment[],
  out: BarrierAccumulator
): void {
  out.fx = 0;
  out.fy = 0;
  out.u = 0;
  for (const s of segments) {
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const seg2 = dx * dx + dy * dy;
    let t = 0;
    if (seg2 > 0) {
      t = ((px - s.ax) * dx + (py - s.ay) * dy) / seg2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const cx = s.ax + t * dx;
    const cy = s.ay + t * dy;
    const rx = px - cx;
    const ry = py - cy;
    const r2 = rx * rx + ry * ry;
    const rCut = WCA_CUTOFF_FACTOR * s.sigma;
    const rCut2 = rCut * rCut;
    if (r2 >= rCut2 || r2 === 0) continue;
    const sigma2 = s.sigma * s.sigma;
    const sr2 = sigma2 / r2;
    const sr6 = sr2 * sr2 * sr2;
    const sr12 = sr6 * sr6;
    // Shift so U(rCut)=0. At rCut: sr2 = 2^(-1/3), sr6 = 1/2, sr12 = 1/4
    // U_LJ(rCut) = 4ε(1/4 - 1/2) = -ε, so shift = -ε and U_wca = U_LJ + ε.
    const u = 4 * s.epsilon * (sr12 - sr6) + s.epsilon;
    const k = (24 * s.epsilon * (2 * sr12 - sr6)) / r2;
    out.fx += k * rx;
    out.fy += k * ry;
    out.u += u;
  }
}
