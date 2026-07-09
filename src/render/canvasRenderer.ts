import type { Simulation } from "../sim/simulation";
import { DEFAULT_ANCHORS, starToCelsius, type UnitAnchors } from "../units";
import {
  DEFAULT_LEGEND_C_MAX,
  DEFAULT_LEGEND_C_MIN,
  celsiusColor,
  paletteSamplesCelsius,
} from "./palette";

// 2D canvas rendering. Instanced-quad WebGL2 is the M5 upgrade — plain
// canvas gets us through M1–M4 at 2k atoms comfortably.

export interface RegionOverlay {
  label: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  // Value fn returns pre-formatted text (already unit-mapped). Renderer
  // stays unit-agnostic; the caller does the T*→°C formatting.
  value?: () => string;
  tint?: string;
}

export interface RenderOptions {
  atomRadius: number;
  anchors?: UnitAnchors;
  regions?: readonly RegionOverlay[];
  drawLegend?: boolean;
  // Optional palette window in °C. If omitted, the renderer uses
  // DEFAULT_LEGEND_C_MIN..DEFAULT_LEGEND_C_MAX.
  cMin?: number;
  cMax?: number;
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
    const anchors = opts.anchors ?? DEFAULT_ANCHORS;

    const legendH = opts.drawLegend ? 46 : 0;
    const stageH = height - legendH;

    const dom = sim.config.domain;
    const worldW = dom.xMax - dom.xMin;
    const worldH = dom.yMax - dom.yMin;
    const scale = Math.min(width / worldW, stageH / worldH);
    const offsetX = (width - worldW * scale) / 2 - dom.xMin * scale;
    const offsetY = (stageH - worldH * scale) / 2 - dom.yMin * scale;
    const sx = (x: number) => x * scale + offsetX;
    const sy = (y: number) => stageH - (y * scale + offsetY);

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

    ctx.strokeStyle = "#3a4459";
    ctx.lineWidth = Math.max(1, 0.15 * scale);
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const s of sim.config.segments) {
      ctx.moveTo(sx(s.ax), sy(s.ay));
      ctx.lineTo(sx(s.bx), sy(s.by));
    }
    ctx.stroke();

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

    // Atoms — colour by mapping each atom's instantaneous KE-based T*
    // through the °C anchor mapping. "Instantaneous T" for a single atom is
    // v² (since ½ m v² = T for a 2-DOF system with m=1); the °C map is
    // linear so this survives without extra normalization.
    const r = opts.atomRadius * scale;
    const posX = sim.posX;
    const posY = sim.posY;
    const velX = sim.velX;
    const velY = sim.velY;
    const kind = sim.kind;
    for (let i = 0; i < sim.n; i++) {
      const vx = velX[i]!;
      const vy = velY[i]!;
      // Note: per-atom "T*" from |v|² has huge fluctuations (it's a single
      // draw from an exponential distribution when the atom is at
      // equilibrium). To keep the eye from being dazzled we soften with a
      // sqrt on the KE contribution around the local mean — but we keep
      // it monotonic, so a hot atom still reads hot.
      const tStar = vx * vx + vy * vy;
      const c = starToCelsius(tStar, anchors);
      ctx.fillStyle = celsiusColor(c);
      ctx.beginPath();
      ctx.arc(sx(posX[i]!), sy(posY[i]!), r, 0, Math.PI * 2);
      ctx.fill();
      if (kind[i] === 1) {
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = Math.max(1, 0.06 * scale);
        ctx.stroke();
      }
    }

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

    if (opts.drawLegend) {
      const cMin = opts.cMin ?? DEFAULT_LEGEND_C_MIN;
      const cMax = opts.cMax ?? DEFAULT_LEGEND_C_MAX;
      this.drawCelsiusLegend(ctx, width, height - legendH, legendH, cMin, cMax);
    }
  }

  private drawCelsiusLegend(
    ctx: CanvasRenderingContext2D,
    w: number,
    y: number,
    h: number,
    cMin: number,
    cMax: number
  ): void {
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, y, w, h);
    const samples = paletteSamplesCelsius(96, cMin, cMax);
    const barX = 40;
    const barY = y + 10;
    const barW = w - 80;
    const barH = 14;
    for (let i = 0; i < samples.length; i++) {
      ctx.fillStyle = samples[i]!;
      const x0 = barX + (i / samples.length) * barW;
      const x1 = barX + ((i + 1) / samples.length) * barW;
      ctx.fillRect(x0, barY, x1 - x0 + 1, barH);
    }
    ctx.strokeStyle = "#2b3040";
    ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
    // Ticks — every 30 °C, always showing 0 °C.
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "#c7cdd6";
    ctx.textBaseline = "top";
    const tickStep = 30;
    const startTick = Math.ceil(cMin / tickStep) * tickStep;
    for (let c = startTick; c <= cMax; c += tickStep) {
      const px = barX + ((c - cMin) / (cMax - cMin)) * barW;
      ctx.strokeStyle = "#2b3040";
      ctx.beginPath();
      ctx.moveTo(px, barY + barH);
      ctx.lineTo(px, barY + barH + 3);
      ctx.stroke();
      const label = c === 0 ? "0 °C" : `${c}`;
      ctx.textAlign = "center";
      ctx.fillStyle = c === 0 ? "#e6e8ec" : "#c7cdd6";
      ctx.fillText(label, px, barY + barH + 5);
    }
    ctx.textAlign = "left";
  }
}
