import type { Simulation } from "./simulation";
import { WCA_CUTOFF_FACTOR } from "./potential";

// A rigid line segment that follows a prescribed motion. Applies the same
// closest-point WCA repulsion as a static barrier. Tracks work done on the
// gas by integrating F_on_atom · v_contact · dt over every atom-blade
// contact per step — this is the compressor's "W" for the COP calculation.
//
// Only translation is supported for now (vax=vbx, vay=vby is a pure
// translation). Rotation would replace v_contact with v_center + ω × r; we
// leave the plumbing in place so a subclass can override velocityAt().

export class MovingSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  vax: number;
  vay: number;
  vbx: number;
  vby: number;
  epsilon: number;
  sigma: number;
  workInput = 0;

  constructor(init: {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    vax: number;
    vay: number;
    vbx: number;
    vby: number;
    epsilon?: number;
    sigma?: number;
  }) {
    this.ax = init.ax;
    this.ay = init.ay;
    this.bx = init.bx;
    this.by = init.by;
    this.vax = init.vax;
    this.vay = init.vay;
    this.vbx = init.vbx;
    this.vby = init.vby;
    this.epsilon = init.epsilon ?? 1;
    this.sigma = init.sigma ?? 1;
  }

  advance(dt: number): void {
    this.ax += this.vax * dt;
    this.ay += this.vay * dt;
    this.bx += this.vbx * dt;
    this.by += this.vby * dt;
  }

  // Interpolated velocity at the closest point on the segment (parametric t).
  private velocityAt(t: number, out: { vx: number; vy: number }): void {
    out.vx = this.vax + t * (this.vbx - this.vax);
    out.vy = this.vay + t * (this.vby - this.vay);
  }

  applyForce(sim: Simulation, dt: number, work: { vx: number; vy: number }): number {
    const dx = this.bx - this.ax;
    const dy = this.by - this.ay;
    const seg2 = dx * dx + dy * dy;
    const rCut = WCA_CUTOFF_FACTOR * this.sigma;
    const rCut2 = rCut * rCut;
    const sigma2 = this.sigma * this.sigma;
    const eps = this.epsilon;
    let dW = 0;
    let dPE = 0;
    const posX = sim.posX;
    const posY = sim.posY;
    const accX = sim.accX;
    const accY = sim.accY;
    const kind = sim.kind;
    const n = sim.n;
    for (let i = 0; i < n; i++) {
      if (kind[i]! !== 0) continue; // tethered atoms excluded from blade too
      const px = posX[i]!;
      const py = posY[i]!;
      let t = 0;
      if (seg2 > 0) {
        t = ((px - this.ax) * dx + (py - this.ay) * dy) / seg2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }
      const cx = this.ax + t * dx;
      const cy = this.ay + t * dy;
      const rx = px - cx;
      const ry = py - cy;
      const r2 = rx * rx + ry * ry;
      if (r2 >= rCut2 || r2 === 0) continue;
      const sr2 = sigma2 / r2;
      const sr6 = sr2 * sr2 * sr2;
      const sr12 = sr6 * sr6;
      const u = 4 * eps * (sr12 - sr6) + eps;
      const k = (24 * eps * (2 * sr12 - sr6)) / r2;
      const fx = k * rx;
      const fy = k * ry;
      accX[i] = accX[i]! + fx;
      accY[i] = accY[i]! + fy;
      dPE += u;
      this.velocityAt(t, work);
      dW += (fx * work.vx + fy * work.vy) * dt;
    }
    this.workInput += dW;
    return dPE;
  }
}
