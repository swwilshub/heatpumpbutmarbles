// A fixed-size rolling ring buffer of numbers, plus a small canvas plotter.
// Used in the sidebar to give users a "temperature over time" view — the
// static readouts jitter with normal thermal fluctuation, and a moving
// history is the honest way to show what's actually happening.

export class TimeSeries {
  private buf: Float64Array;
  private idx = 0;
  count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    if (!Number.isFinite(v)) return; // don't poison the buffer with NaN/±Inf
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  mean(): number {
    if (this.count === 0) return 0;
    let s = 0;
    const start = this.count < this.capacity ? 0 : this.idx;
    for (let i = 0; i < this.count; i++) {
      s += this.buf[(start + i) % this.capacity]!;
    }
    return s / this.count;
  }

  // Copy out values in chronological order (oldest first).
  copyOrdered(out: Float64Array): number {
    const n = this.count;
    const start = this.count < this.capacity ? 0 : this.idx;
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[(start + i) % this.capacity]!;
    }
    return n;
  }
}

export interface PlotSeriesSpec {
  name: string;
  colour: string;
  series: TimeSeries;
}

export function drawTimeSeriesPlot(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  specs: readonly PlotSeriesSpec[],
  opts: { yMin?: number; yMax?: number; padding?: number; yUnit?: string } = {}
): void {
  const pad = opts.padding ?? 4;
  // Background + border
  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#1e222b";
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  // Compute y range if not fixed
  let yMin = opts.yMin ?? Infinity;
  let yMax = opts.yMax ?? -Infinity;
  const tmp = new Float64Array(0);
  let anyData = false;
  const scratch = new Float64Array(Math.max(1, ...specs.map((s) => s.series.capacity)));
  for (const s of specs) {
    const n = s.series.copyOrdered(scratch);
    for (let i = 0; i < n; i++) {
      const v = scratch[i]!;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
      anyData = true;
    }
  }
  if (!anyData || yMin === yMax) {
    yMin = -10;
    yMax = 10;
  }
  // Clamp to a sensible operating envelope so a rare compressor spike (an
  // atom that momentarily went to 2000 °C) doesn't collapse the useful
  // range into a flat line. Users care about the -60..150 °C window a real
  // heat pump lives in; runaways clip off the top of the plot instead of
  // dominating it.
  if (opts.yMin === undefined) yMin = Math.max(-80, yMin);
  if (opts.yMax === undefined) yMax = Math.min(200, yMax);
  const range = yMax - yMin;
  yMin = Math.floor((yMin - range * 0.05) / 5) * 5;
  yMax = Math.ceil((yMax + range * 0.05) / 5) * 5;
  void tmp;

  const plotX = pad + 24;
  const plotY = pad;
  const plotW = w - plotX - pad;
  const plotH = h - 2 * pad;

  // Zero line if in range
  if (yMin < 0 && yMax > 0) {
    const zy = plotY + plotH - ((0 - yMin) / (yMax - yMin)) * plotH;
    ctx.strokeStyle = "rgba(180,200,220,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(plotX, zy);
    ctx.lineTo(plotX + plotW, zy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Series lines
  ctx.lineWidth = 1.6;
  for (const s of specs) {
    const n = s.series.copyOrdered(scratch);
    if (n < 2) continue;
    ctx.strokeStyle = s.colour;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = plotX + (i / (n - 1)) * plotW;
      const y = plotY + plotH - ((scratch[i]! - yMin) / (yMax - yMin)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = "#8b93a1";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const unit = opts.yUnit ?? "";
  ctx.fillText(`${yMax.toFixed(0)}${unit}`, 3, plotY);
  ctx.textBaseline = "bottom";
  ctx.fillText(`${yMin.toFixed(0)}${unit}`, 3, plotY + plotH);
}
