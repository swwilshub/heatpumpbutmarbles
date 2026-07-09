import type { Domain } from "./types";

// Uniform-cell spatial hash. Cell size >= interaction cutoff so each atom
// only needs to check its own cell plus the 8 neighbouring cells. Rebuilt
// every force pass — O(N) with a small constant. Cells hold indices only;
// positions live in the SoA Float64Arrays owned by the simulation.

export class CellList {
  readonly nx: number;
  readonly ny: number;
  readonly cellSize: number;
  readonly domain: Domain;
  // head[cellIndex] = first atom in cell (-1 if none)
  private head: Int32Array;
  // next[atomIndex] = next atom in the same cell (-1 if last)
  private next: Int32Array;

  constructor(domain: Domain, cellSize: number, capacity: number) {
    this.domain = domain;
    this.cellSize = cellSize;
    this.nx = Math.max(1, Math.floor((domain.xMax - domain.xMin) / cellSize));
    this.ny = Math.max(1, Math.floor((domain.yMax - domain.yMin) / cellSize));
    this.head = new Int32Array(this.nx * this.ny);
    this.next = new Int32Array(capacity);
  }

  ensureCapacity(capacity: number): void {
    if (this.next.length < capacity) {
      this.next = new Int32Array(capacity);
    }
  }

  private cellOf(x: number, y: number): number {
    let ix = Math.floor((x - this.domain.xMin) / this.cellSize);
    let iy = Math.floor((y - this.domain.yMin) / this.cellSize);
    if (ix < 0) ix = 0;
    else if (ix >= this.nx) ix = this.nx - 1;
    if (iy < 0) iy = 0;
    else if (iy >= this.ny) iy = this.ny - 1;
    return iy * this.nx + ix;
  }

  build(posX: Float64Array, posY: Float64Array, n: number): void {
    this.ensureCapacity(n);
    this.head.fill(-1);
    for (let i = 0; i < n; i++) {
      const cx = posX[i]!;
      const cy = posY[i]!;
      const c = this.cellOf(cx, cy);
      this.next[i] = this.head[c]!;
      this.head[c] = i;
    }
  }

  // Call cb(i, j) once per unique pair with i < j whose cells are adjacent.
  // Filtering by actual distance is left to the caller.
  forEachPair(cb: (i: number, j: number) => void): void {
    const { nx, ny } = this;
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        const cell = cy * nx + cx;
        // Half-neighbour set (Newton's third law): self + 4 of the 8 neighbours
        // (right, down-left, down, down-right). Ensures each pair once.
        const neighbours: number[] = [cell];
        if (cx + 1 < nx) neighbours.push(cy * nx + (cx + 1));
        if (cy + 1 < ny) {
          if (cx > 0) neighbours.push((cy + 1) * nx + (cx - 1));
          neighbours.push((cy + 1) * nx + cx);
          if (cx + 1 < nx) neighbours.push((cy + 1) * nx + (cx + 1));
        }
        for (let i = this.head[cell]!; i !== -1; i = this.next[i]!) {
          for (const nc of neighbours) {
            for (let j = this.head[nc]!; j !== -1; j = this.next[j]!) {
              if (nc === cell) {
                if (j >= i) continue; // ensure i > j, count once
                cb(j, i);
              } else {
                cb(i, j);
              }
            }
          }
        }
      }
    }
  }
}
