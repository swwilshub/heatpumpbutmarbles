import type { Simulation } from "../sim/simulation";
import { paletteSamples, speedColor } from "./palette";

// 2D canvas rendering. Instanced-quad WebGL2 is the M5 upgrade — plain
// canvas gets us through M1–M4 at 2k atoms comfortably.

export interface RegionOverlay {
  // Label + rectangular bounding box in world coordinates. Renderer draws the
  // label at the top-left of the box with a small tint over the region so
  // users can see which part of the sim it names.
  label: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  // Optional runtime-computed value shown after the label (e.g. "T=1.24").
  value?: () => string;
  // Tint colour rgba.
  tint?: string;
}

export interface RenderOptions {
  // Fixed reference used to normalise atom KE → colour. 1.0 maps to the
  // top of the palette. Should be roughly the highest T the scenario is
  // expected to visit — the palette clamps beyond that.
  temperatureScale: number;
  atomRadius: number;
  regions?: readonly RegionOverlay[];
  // Draw a horizontal colour-bar legend at the bottom of the canvas.
  drawLegend?: boolean;
}

export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private legendSamples = paletteSamples(64);

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

    // Reserve bottom strip for the legend if requested.
    const legendH = opts.drawLegend ? 42 : 0;
    const stageH = height - legendH;

    // world → screen: fit domain into (width, stageH) with 1:1 aspect.
    const dom = sim.config.domain;
    const worldW = dom.xMax - dom.xMin;
    const worldH = dom.yMax - dom.yMin;
    const scale = Math.min(width / worldW, stageH / worldH);
    const offsetX = (width - worldW * scale) / 2 - dom.xMin * scale;
    const offsetY = (stageH - worldH * scale) / 2 - dom.yMin * scale;
    const sx = (x: number) => x * scale + offsetX;
    const sy = (y: number) => stageH - (y * scale + offsetY);

    // Region tints (drawn behind atoms so labels overlay cleanly).
    if (opts.regions) {
      for (const r of opts.regions) {
        if (r.tint) {
          ctx.fillStyle = r.tint;
          const x0 = sx(r.xMin);
          const x1 = sx(r.xMax);
          const y0 = sy(r.yMax);
          const y1 = sy(r.yMin);
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
      }
    }

    // Static segments (walls)
    ctx.strokeStyle = "#3a4459";
    ctx.lineWidth = Math.max(1, 0.15 * scale);
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const s of sim.config.segments) {
      ctx.moveTo(sx(s.ax), sy(s.ay));
      ctx.lineTo(sx(s.bx), sy(s.by));
    }
    ctx.stroke();

    // Moving segments (compressor blades)
    if (sim.movingSegments.length > 0) {
      ctx.strokeStyle = "#f0a070";
      ctx.lineWidth = Math.max(2, 0.22 * scale);
      ctx.beginPath();
      for (const m of sim.movingSegments) {
        ctx.moveTo(sx(m.ax), sy(m.ay));
        ctx.lineTo(sx(m.bx), sy(m.by));
      }
      ctx.stroke();
    }

    // Atoms — colour by v² / (2 · temperatureScale). tScale sets what "1.0"
    // means; using a fixed value keeps colours COMPARABLE across regions
    // and time, which is the whole point of the ramp.
    const r = opts.atomRadius * scale;
    const norm = 1 / Math.max(1e-6, 2 * opts.temperatureScale);
    const posX = sim.posX;
    const posY = sim.posY;
    const velX = sim.velX;
    const velY = sim.velY;
    const kind = sim.kind;
    for (let i = 0; i < sim.n; i++) {
      const vx = velX[i]!;
      const vy = velY[i]!;
      const t = (vx * vx + vy * vy) * norm;
      const px = sx(posX[i]!);
      const py = sy(posY[i]!);
      ctx.fillStyle = speedColor(t);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      // Ring around tethered (wall) atoms so they're identifiable as
      // "walls" independent of their temperature colour.
      if (kind[i] === 1) {
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = Math.max(1, 0.06 * scale);
        ctx.stroke();
      }
    }

    // Region labels (drawn on top of atoms so they're legible even in a
    // dense chamber). Value pulled every frame so T tiles stay live.
    if (opts.regions) {
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textBaseline = "top";
      for (const r of opts.regions) {
        const x0 = sx(r.xMin);
        const y0 = sy(r.yMax);
        const text = r.value ? `${r.label}: ${r.value()}` : r.label;
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = "rgba(11,13,18,0.7)";
        ctx.fillRect(x0 + 3, y0 + 3, w, 18);
        ctx.fillStyle = "#e6e8ec";
        ctx.fillText(text, x0 + 8, y0 + 6);
      }
    }

    // Legend
    if (opts.drawLegend) {
      this.drawLegend(ctx, width, height - legendH, legendH, opts.temperatureScale);
    }
  }

  private drawLegend(
    ctx: CanvasRenderingContext2D,
    w: number,
    y: number,
    h: number,
    tempScale: number
  ): void {
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, y, w, h);
    const barX = 60;
    const barY = y + 10;
    const barW = w - 90;
    const barH = 12;
    const nSamples = this.legendSamples.length;
    for (let i = 0; i < nSamples; i++) {
      ctx.fillStyle = this.legendSamples[i]!;
      const x0 = barX + (i / nSamples) * barW;
      const x1 = barX + ((i + 1) / nSamples) * barW;
      ctx.fillRect(x0, barY, x1 - x0 + 1, barH);
    }
    ctx.strokeStyle = "#2b3040";
    ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
    ctx.fillStyle = "#e6e8ec";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("T*", 20, barY + 1);
    ctx.textAlign = "left";
    ctx.fillText("cold", barX, barY + barH + 4);
    ctx.textAlign = "center";
    ctx.fillText(`${tempScale.toFixed(1)}`, barX + barW / 2, barY + barH + 4);
    ctx.textAlign = "right";
    ctx.fillText(`≥ ${(tempScale * 2).toFixed(1)}`, barX + barW, barY + barH + 4);
    ctx.textAlign = "left";
  }
}
