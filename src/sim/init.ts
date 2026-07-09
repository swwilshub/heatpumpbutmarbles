import { Rng } from "./rng";
import { Simulation } from "./simulation";

// Seed atoms on a triangular lattice inside a rectangle, at a spacing that
// gives roughly (targetDensity) atoms per σ^2. Then sample Maxwell-Boltzmann
// velocities at temperature T (v ~ N(0, sqrt(T)) per component in 2D reduced
// units with m=1). Finally, remove COM velocity so momentum starts at zero.
export function seedLattice(
  sim: Simulation,
  region: { xMin: number; yMin: number; xMax: number; yMax: number },
  spacing: number,
  temperature: number,
  rng: Rng
): number {
  const rowHeight = spacing * Math.sqrt(3) / 2;
  let count = 0;
  let sumVx = 0;
  let sumVy = 0;
  let row = 0;
  for (let y = region.yMin + spacing; y < region.yMax - 0.5 * spacing; y += rowHeight) {
    const xOffset = row % 2 === 0 ? 0 : spacing / 2;
    for (
      let x = region.xMin + spacing + xOffset;
      x < region.xMax - 0.5 * spacing;
      x += spacing
    ) {
      const vx = Math.sqrt(temperature) * rng.gauss();
      const vy = Math.sqrt(temperature) * rng.gauss();
      sim.addAtom(x, y, vx, vy);
      sumVx += vx;
      sumVy += vy;
      count++;
    }
    row++;
  }
  if (count > 0) {
    const cx = sumVx / count;
    const cy = sumVy / count;
    const velX = sim.velX;
    const velY = sim.velY;
    for (let i = 0; i < count; i++) {
      velX[i] = velX[i]! - cx;
      velY[i] = velY[i]! - cy;
    }
    let ke = 0;
    for (let i = 0; i < count; i++) {
      ke += velX[i]! ** 2 + velY[i]! ** 2;
    }
    const measuredT = ke / (2 * count);
    if (measuredT > 0) {
      const scale = Math.sqrt(temperature / measuredT);
      for (let i = 0; i < count; i++) {
        velX[i] = velX[i]! * scale;
        velY[i] = velY[i]! * scale;
      }
    }
  }
  return count;
}
