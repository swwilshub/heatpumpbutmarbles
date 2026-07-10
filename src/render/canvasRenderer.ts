import type { Simulation } from "../sim/simulation";
import { DEFAULT_ANCHORS, starToCelsius, type UnitAnchors } from "../units";
import {
  DEFAULT_LEGEND_C_MAX,
  DEFAULT_LEGEND_C_MIN,
  celsiusRgba,
  paletteSamplesCelsius,
} from "./palette";

// Small badge for schematic labels — dark rounded rect + coloured text.
function drawTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  colour: string
): void {
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = "rgba(11,13,18,0.82)";
  ctx.fillRect(cx - w / 2, cy - 8, w, 16);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - w / 2 + 0.5, cy - 8 + 0.5, w - 1, 15);
  ctx.fillStyle = colour;
  ctx.fillText(text, cx, cy);
  ctx.textAlign = "left";
}

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
  // Dynamic temperature-driven tint: value fn returns a reduced T*, the
  // renderer maps it through the °C anchors + the palette to a live
  // rgba background. This is how you get "condenser glows red when hot,
  // evaporator glows blue when cold" as a real per-population signal.
  tintByT?: () => number;
  tintByTAlpha?: number;
}

// Schematic annotations drawn on the canvas so users can see which parts
// they're tuning. Each is a small drawing anchored at a world coordinate.
//   - "compressor": arrow + text at position; caller anchors near the piston
//   - "coil"      : label + underline at position; caller anchors near wall atoms
//   - "fan"       : four arrows pointing INTO the coil, size ∝ strength().
//                   Fan strength = 0 → tiny arrows (natural convection).
//                   Fan strength ≥ 4 → big bold arrows (forced-air max).
//   - "label"     : plain text at position.
export type PartSchematic =
  | { kind: "compressor"; x: number; y: number; label: string }
  | { kind: "coil"; x: number; y: number; label: string }
  | { kind: "fan"; x: number; y: number; strength: () => number; label?: string }
  | { kind: "label"; x: number; y: number; label: string }
  // Pipe: an arrow between (x1,y1) and (x2,y2). Optional label placed at the
  // midpoint. Used to schematically connect exploded sub-chambers (compressor
  // → condenser → valve → evaporator → compressor) so the whole thing reads
  // as a heat-pump diagram even though the sub-chambers are physically
  // isolated. Line + arrowhead + label; no physics.
  | { kind: "pipe"; x1: number; y1: number; x2: number; y2: number; label?: string; colour?: string };

export interface RenderOptions {
  atomRadius: number;
  anchors?: UnitAnchors;
  regions?: readonly RegionOverlay[];
  parts?: readonly PartSchematic[];
  drawLegend?: boolean;
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

    const legendH = opts.drawLegend ? 56 : 0;
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
        let tint = r.tint;
        if (r.tintByT) {
          const c = starToCelsius(r.tintByT(), anchors);
          tint = celsiusRgba(c, r.tintByTAlpha ?? 0.28);
        }
        if (tint) {
          ctx.fillStyle = tint;
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
      ctx.lineWidth = Math.max(2, 0.22 * scale);
      for (const m of sim.movingSegments) {
        // Active segments draw bold orange; inactive ("return stroke") draw
        // faint dashed so the user can see the pump cycle without confusion.
        if (m.active) {
          ctx.strokeStyle = "#f0a070";
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = "rgba(240,160,112,0.20)";
          ctx.setLineDash([4, 3]);
        }
        ctx.beginPath();
        ctx.moveTo(sx(m.ax), sy(m.ay));
        ctx.lineTo(sx(m.bx), sy(m.by));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Atoms rendered as UNIFORM marbles. A single atom doesn't have a
    // "temperature" — it has a velocity, which the viewer already sees as
    // motion on screen. Per-atom colouring was a category error. Temperature
    // is a population property, and that lives on the region backgrounds
    // now (tintByT). Wall atoms get a subtle ring to distinguish them from
    // the free refrigerant.
    const r = opts.atomRadius * scale;
    const posX = sim.posX;
    const posY = sim.posY;
    const kind = sim.kind;
    ctx.fillStyle = "#e6e8ec";
    for (let i = 0; i < sim.n; i++) {
      ctx.beginPath();
      ctx.arc(sx(posX[i]!), sy(posY[i]!), r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Second pass for wall-atom rings so the fill loop stays cache-friendly
    // and we don't spam strokeStyle changes.
    ctx.strokeStyle = "rgba(180,200,220,0.55)";
    ctx.lineWidth = Math.max(1, 0.08 * scale);
    for (let i = 0; i < sim.n; i++) {
      if (kind[i] !== 1) continue;
      ctx.beginPath();
      ctx.arc(sx(posX[i]!), sy(posY[i]!), r, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (opts.regions) {
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textBaseline = "top";
      for (const r of opts.regions) {
        if (!r.label && !r.value) continue; // tint-only regions render no label
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

    if (opts.parts) {
      this.drawParts(ctx, opts.parts, sx, sy, scale);
    }

    if (opts.drawLegend) {
      const cMin = opts.cMin ?? DEFAULT_LEGEND_C_MIN;
      const cMax = opts.cMax ?? DEFAULT_LEGEND_C_MAX;
      this.drawCelsiusLegend(ctx, width, height - legendH, legendH, cMin, cMax);
    }
  }

  private drawParts(
    ctx: CanvasRenderingContext2D,
    parts: readonly PartSchematic[],
    sx: (x: number) => number,
    sy: (y: number) => number,
    scale: number
  ): void {
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const p of parts) {
      // Pipe has no single anchor point, handle before the shared prelude.
      // Rendered as a SOLID bold line + fat arrowhead + optional label —
      // needs to read cleanly as "gas flows THIS WAY, from part A to part B",
      // not as decorative dashes the eye ignores.
      if (p.kind === "pipe") {
        const x1 = sx(p.x1);
        const y1 = sy(p.y1);
        const x2 = sx(p.x2);
        const y2 = sy(p.y2);
        const col = p.colour ?? "#7a8393";
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 1) continue;
        const ux = dx / len;
        const uy = dy / len;
        // Halo behind the line so it stands off the atom canvas.
        ctx.strokeStyle = "rgba(11,13,18,0.85)";
        ctx.lineWidth = 8;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2 - ux * 6, y2 - uy * 6);
        ctx.stroke();
        // Solid coloured shaft on top.
        ctx.strokeStyle = col;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2 - ux * 6, y2 - uy * 6);
        ctx.stroke();
        // Fat filled arrowhead.
        ctx.fillStyle = col;
        const head = 14;
        const w = 9;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - ux * head + -uy * w, y2 - uy * head + ux * w);
        ctx.lineTo(x2 - ux * head - -uy * w, y2 - uy * head - ux * w);
        ctx.closePath();
        ctx.fill();
        if (p.label) drawTag(ctx, p.label, (x1 + x2) / 2, (y1 + y2) / 2, col);
        continue;
      }
      const px = sx(p.x);
      const py = sy(p.y);
      switch (p.kind) {
        case "compressor": {
          // A downward-pointing arrow next to the piston + label.
          ctx.strokeStyle = "#f0a070";
          ctx.fillStyle = "#f0a070";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(px, py - 14);
          ctx.lineTo(px, py + 8);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(px - 5, py + 3);
          ctx.lineTo(px, py + 8);
          ctx.lineTo(px + 5, py + 3);
          ctx.fill();
          drawTag(ctx, p.label, px, py - 22, "#f0a070");
          break;
        }
        case "coil": {
          drawTag(ctx, p.label, px, py, "#9dd6f0");
          break;
        }
        case "fan": {
          // Four short arrows pointing toward (px, py). Arrow length + line
          // width scale with `strength()` so a fan cranked to 5 is visibly
          // bigger than a fan cranked to 0.1.
          const s = Math.max(0, Math.min(6, p.strength()));
          const armMax = Math.max(6, 12 + s * 4); // pixels
          const arm = armMax * 0.9;
          const stroke = 1 + s * 0.4;
          const alpha = 0.35 + Math.min(0.6, s * 0.15);
          ctx.strokeStyle = `rgba(220,180,90,${alpha.toFixed(2)})`;
          ctx.fillStyle = `rgba(220,180,90,${alpha.toFixed(2)})`;
          ctx.lineWidth = stroke;
          for (let a = 0; a < 4; a++) {
            const theta = (a * Math.PI) / 2 + Math.PI / 4;
            const dx = Math.cos(theta);
            const dy = Math.sin(theta);
            const x0 = px + dx * (arm + 4);
            const y0 = py + dy * (arm + 4);
            const x1 = px + dx * 6;
            const y1 = py + dy * 6;
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
            // Arrowhead
            const head = 4 + s * 0.5;
            const perpX = -dy;
            const perpY = dx;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x1 + dx * head + perpX * head * 0.5,
                       y1 + dy * head + perpY * head * 0.5);
            ctx.lineTo(x1 + dx * head - perpX * head * 0.5,
                       y1 + dy * head - perpY * head * 0.5);
            ctx.closePath();
            ctx.fill();
          }
          if (p.label) drawTag(ctx, p.label, px, py + armMax + 12, "#dcb45a");
          break;
        }
        case "label":
          drawTag(ctx, p.label, px, py, "#c7cdd6");
          break;
      }
    }
    // Suppress unused-var warning on `scale` — retained for future icon sizing.
    void scale;
  }

  private drawCelsiusLegend(
    ctx: CanvasRenderingContext2D,
    w: number,
    y: number,
    h: number,
    cMin: number,
    cMax: number
  ): void {
    // Legend now maps REGION temperature (mean over many marbles) to a
    // background colour. Marbles themselves are uniform white and carry
    // "heat" through their motion (velocity), which the eye already reads.
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, y, w, h);
    const samples = paletteSamplesCelsius(96, cMin, cMax);
    const barX = 8;
    const barY = y + 14;
    const barW = w - 30;
    const barH = 12;
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "#8b93a1";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("region temperature (mean of many marbles)", barX, y + 2);
    ctx.textAlign = "left";
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillStyle = "#c7cdd6";
    // Colour bar
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
