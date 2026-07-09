import type { Simulation } from "./simulation";
import type { LineSegment } from "./types";

// A heat-exchanger wall = a coincident line barrier + a column of tethered
// atoms next to it. Refrigerant atoms cannot cross (the line barrier), but
// kinetic energy transfers across via pair collisions between refrigerant
// atoms and wall atoms — the same way real solids conduct heat via phonons.
//
// The line barrier excludes tethered atoms (Simulation.computeForces skips
// barriers for kind===1), so wall atoms sit at their lattice sites without
// being pushed off by the coincident barrier they belong to.

export interface HeatExchangerSpec {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  spacing: number; // atom-to-atom spacing along the wall
  layers: number; // typically 2 — one layer either side of the barrier
  layerOffset: number; // perpendicular distance between layers
  tetherK: number;
  sigma: number; // for the barrier
  epsilon: number; // for the barrier
}

export interface HeatExchangerHandle {
  barrier: LineSegment;
  atomIndices: number[];
}

export function addHeatExchanger(
  sim: Simulation,
  spec: HeatExchangerSpec
): HeatExchangerHandle {
  const dx = spec.bx - spec.ax;
  const dy = spec.by - spec.ay;
  const len = Math.hypot(dx, dy);
  const tx = dx / len;
  const ty = dy / len;
  const nx = -ty; // unit normal (rotate 90° left)
  const ny = tx;
  const indices: number[] = [];
  const nAtoms = Math.max(2, Math.floor(len / spec.spacing));
  // Layers are placed with matching along-wall positions (no stagger) — a
  // stagger of half-spacing creates cross-layer near-neighbours at
  // sqrt((s/2)² + off²), which for reasonable defaults falls inside the LJ
  // repulsive wall and blows the wall apart. Keeping layers aligned makes
  // cross-layer nearest-neighbour distance = layerOffset, which is easy to
  // set near r_min = 2^(1/6)σ for a stable crystal.
  for (let layer = 0; layer < spec.layers; layer++) {
    const perp = (layer - (spec.layers - 1) / 2) * spec.layerOffset;
    for (let k = 0; k < nAtoms; k++) {
      const t = (k + 0.5) / nAtoms;
      const alongX = spec.ax + tx * t * len;
      const alongY = spec.ay + ty * t * len;
      const hx = alongX + nx * perp;
      const hy = alongY + ny * perp;
      const i = sim.addAtom(hx, hy, 0, 0, {
        kind: 1,
        homeX: hx,
        homeY: hy,
        tetherK: spec.tetherK,
      });
      indices.push(i);
    }
  }
  const barrier: LineSegment = {
    ax: spec.ax,
    ay: spec.ay,
    bx: spec.bx,
    by: spec.by,
    epsilon: spec.epsilon,
    sigma: spec.sigma,
  };
  return { barrier, atomIndices: indices };
}
