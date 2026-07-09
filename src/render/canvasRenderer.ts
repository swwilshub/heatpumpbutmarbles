import type { Simulation } from "../sim/simulation";
import { speedColor } from "./palette";

// 2D canvas rendering. Instanced-quad WebGL2 is the M5 upgrade — plain
// canvas gets us through M1–M4 at 2k atoms comfortably.

export interface RenderOptions {
  temperatureScale: number; // used to normalise speed → colour
  atomRadius: number; // in world units (sigma)
}

export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.width = canvas.width;
    this.height = canvas.height;
  }

  resize(w: number, h: number): void {
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
  }

  draw(sim: Simulation, opts: RenderOptions): void {
    const { ctx, width, height } = this;
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, width, height);

    // world → screen: fit domain into canvas with 1:1 aspect ratio.
    const dom = sim.config.domain;
    const worldW = dom.xMax - dom.xMin;
    const worldH = dom.yMax - dom.yMin;
    const scale = Math.min(width / worldW, height / worldH);
    const offsetX = (width - worldW * scale) / 2 - dom.xMin * scale;
    const offsetY = (height - worldH * scale) / 2 - dom.yMin * scale;
    const sx = (x: number) => x * scale + offsetX;
    // Flip Y so +y is up on screen (world is bottom-origin like a physics diagram)
    const sy = (y: number) => height - (y * scale + offsetY);

    // Segments
    ctx.strokeStyle = "#3a4459";
    ctx.lineWidth = Math.max(1, 0.15 * scale);
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const s of sim.config.segments) {
      ctx.moveTo(sx(s.ax), sy(s.ay));
      ctx.lineTo(sx(s.bx), sy(s.by));
    }
    ctx.stroke();

    // Atoms. Colour by v^2 / (2 * T_scale) — matches speed distribution at scale.
    const r = opts.atomRadius * scale;
    const norm = 1 / Math.max(1e-6, 4 * opts.temperatureScale);
    const posX = sim.posX;
    const posY = sim.posY;
    const velX = sim.velX;
    const velY = sim.velY;
    for (let i = 0; i < sim.n; i++) {
      const vx = velX[i]!;
      const vy = velY[i]!;
      const t = (vx * vx + vy * vy) * norm;
      ctx.fillStyle = speedColor(t);
      ctx.beginPath();
      ctx.arc(sx(posX[i]!), sy(posY[i]!), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
