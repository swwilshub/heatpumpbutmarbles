// Canvas drawing of the heat pump model: the refrigerant loop with flowing
// "marbles", gauges and service tools on the left, the house on the right,
// and an energy bar across the top. Everything is laid out on a fixed
// 1200 × 720 virtual canvas and scaled to fit.

import { celsiusColor, celsiusRgba } from "../render/palette";
import * as R from "./r290";
import { type HeatPumpModel, HZ_MAX, P_HP_TRIP, P_LP_TRIP } from "./model";

export const VIEW_W = 1200;
export const VIEW_H = 720;

// --- Layout ---------------------------------------------------------------
const LX0 = 260; // left side of the loop (liquid line, expansion valve)
const LX1 = 620; // right side of the loop (compressor)
const LY0 = 200; // top (condenser)
const LY1 = 560; // bottom (evaporator)
const HX0 = 310; // heat exchangers span
const HX1 = 570;
const COMP = { x: LX1, y: 380, r: 40 };
const ACC_Y0 = 450;
const ACC_Y1 = 515;
const EEV = { x: LX0, y: 400 };
const SIGHT = { x: LX0, y: 285 };
const LEAK = { x: LX0, y: 335 };
const HI_PORT = { x: LX0, y: 245 };
const LO_PORT = { x: LX0, y: 480 };
const GAUGE_HI = { x: 105, y: 250 };
const GAUGE_LO = { x: 105, y: 470 };
const MANIFOLD = { x: 105, y: 394 };
const GAUGE_R = 52;
const FAN = { x: (HX0 + HX1) / 2, y: 650 };
const HOUSE = { x0: 830, x1: 1150, y0: 270, y1: 668, peak: 150 };
const FLOW_Y = 128;
const RETURN_Y = 104;
const PIPE_W = 14;

type Zone = "discharge" | "cond" | "liquid" | "lowMix" | "evap" | "suction" | "comp";

interface Seg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  len: number;
  s0: number;
  zone: Zone;
  f0: number; // fraction through the zone at the segment start
  f1: number;
}

interface Local {
  T: number;
  x: number; // vapour quality
}

function buildPath(): { segs: Seg[]; total: number } {
  const zones: [Zone, [number, number][]][] = [
    ["discharge", [[COMP.x, COMP.y - COMP.r], [LX1, LY0], [HX1, LY0]]],
    ["cond", [[HX1, LY0], [HX0, LY0]]],
    ["liquid", [[HX0, LY0], [LX0, LY0], [EEV.x, EEV.y]]],
    ["lowMix", [[EEV.x, EEV.y], [LX0, LY1], [HX0, LY1]]],
    ["evap", [[HX0, LY1], [HX1, LY1]]],
    ["suction", [[HX1, LY1], [LX1, LY1], [COMP.x, COMP.y + COMP.r]]],
    ["comp", [[COMP.x, COMP.y + COMP.r], [COMP.x, COMP.y - COMP.r]]],
  ];
  const segs: Seg[] = [];
  let s = 0;
  for (const [zone, pts] of zones) {
    let zoneLen = 0;
    for (let i = 0; i < pts.length - 1; i++) zoneLen += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[i + 1]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      segs.push({ x0, y0, x1, y1, len, s0: s, zone, f0: acc / zoneLen, f1: (acc + len) / zoneLen });
      acc += len;
      s += len;
    }
  }
  return { segs, total: s };
}

const PATH = buildPath();

function segAt(s: number): Seg {
  const segs = PATH.segs;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid]!.s0 <= s) lo = mid;
    else hi = mid - 1;
  }
  return segs[lo]!;
}

function pointAt(s: number): { x: number; y: number; nx: number; ny: number; seg: Seg; t: number } {
  const seg = segAt(s);
  const t = Math.min(1, Math.max(0, (s - seg.s0) / seg.len));
  const dx = (seg.x1 - seg.x0) / seg.len;
  const dy = (seg.y1 - seg.y0) / seg.len;
  return { x: seg.x0 + (seg.x1 - seg.x0) * t, y: seg.y0 + (seg.y1 - seg.y0) * t, nx: -dy, ny: dx, seg, t };
}

/** Refrigerant temperature and quality at a point on the loop. */
function localState(hp: HeatPumpModel, seg: Seg, t: number): Local {
  const s = hp.snap;
  const f = seg.f0 + (seg.f1 - seg.f0) * t;
  const Tc = s.hi.T;
  const Te = s.lo.T;
  const idle = !hp.running;
  switch (seg.zone) {
    case "discharge":
      return { T: idle ? s.hi.T : s.tDischarge, x: 1 };
    case "cond": {
      if (idle || s.hi.phase !== "twoPhase") return { T: s.hi.T, x: s.hi.phase === "liquid" ? 0 : Math.min(1, s.hi.x * 4) };
      const dsh = 0.12;
      if (f < dsh) return { T: s.tDischarge + (Tc - s.tDischarge) * (f / dsh), x: 1 };
      const end = 1 - s.psi;
      if (f < end) {
        const k = (f - dsh) / Math.max(1e-6, end - dsh);
        return { T: Tc, x: 1 - k * (1 - s.x3) };
      }
      const k = (f - end) / Math.max(1e-6, s.psi);
      return { T: Tc - k * s.subcooling, x: 0 };
    }
    case "liquid":
      return { T: idle ? s.hi.T : s.tLiquid, x: idle ? Math.min(1, s.hi.x * 4) : s.x3 };
    case "lowMix":
      return { T: Te, x: idle ? Math.min(1, s.lo.x * 4) : s.x4 };
    case "evap": {
      if (idle || s.lo.phase === "vapour") return { T: s.lo.T, x: s.lo.phase === "vapour" ? 1 : Math.min(1, s.lo.x * 4) };
      if (f < s.phi) return { T: Te, x: s.x4 + (1 - s.x4) * (f / Math.max(1e-6, s.phi)) };
      const k = (f - s.phi) / Math.max(1e-6, 1 - s.phi);
      return { T: Te + k * s.superheat, x: 1 };
    }
    case "suction":
      return { T: idle ? s.lo.T : s.tSuction, x: s.xSuction };
    case "comp":
      return { T: idle ? s.lo.T : s.tSuction + (s.tDischarge - s.tSuction) * f, x: 1 };
  }
}

/** On-screen density: liquid packs tight, vapour spreads out. */
function visualDensity(x: number): number {
  return 1 / (x / 0.12 + (1 - x));
}

interface Particle {
  s: number;
  off: number;
  u: number; // fixed random draw: vapour if u < local quality
  v: number; // own speed factor, so bunches spread out along the pipe
}

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export type TempFormatter = (c: number, digits?: number) => string;

/** A temperature difference (superheat, subcooling) in the display units. */
export function formatDelta(fmt: TempFormatter, k: number, digits = 1): string {
  const fahrenheit = fmt(0, 0).includes("F");
  const v = fahrenheit ? k * 1.8 : k;
  const shown = v.toFixed(digits);
  return `${Number(shown) === 0 ? (0).toFixed(digits) : shown} ${fahrenheit ? "°F" : "K"}`;
}

export class HeatPumpDiagram {
  private particles: Particle[] = [];
  private puffs: Puff[] = [];
  private fanAngle = 0;
  private compAngle = 0;
  private waterPhase = 0;
  private lastCharge = -1;
  private presetLoads = -1;
  private time = 0;
  private fmt: TempFormatter = (c) => `${c.toFixed(1)}°C`;

  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    hp: HeatPumpModel,
    wallDt: number,
    playing: boolean,
    fmt: TempFormatter
  ): void {
    const dt = playing ? Math.min(0.05, wallDt) : 0;
    this.time += dt;
    this.fmt = fmt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, width, height);
    const k = Math.min(width / VIEW_W, height / VIEW_H);
    ctx.setTransform(k, 0, 0, k, (width - VIEW_W * k) / 2, (height - VIEW_H * k) / 2);

    const heatPump = hp.source === "heatPump";
    this.drawBackdrop(ctx, hp, fmt);
    this.drawWaterPipes(ctx, hp, dt, fmt);
    this.drawHouse(ctx, hp, fmt);
    if (heatPump) {
      this.updateParticles(hp, dt);
      this.drawLoop(ctx, hp, dt, fmt);
      this.drawService(ctx, hp, fmt);
    } else {
      this.drawBoiler(ctx, hp, fmt);
    }
    this.drawEnergyBar(ctx, hp);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // --- Background & labels ------------------------------------------------

  private drawBackdrop(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, fmt: TempFormatter): void {
    // Outside (left) and inside (right) zones.
    ctx.fillStyle = celsiusRgba(hp.outdoorC, 0.1);
    ctx.fillRect(0, 70, 790, VIEW_H - 70);
    ctx.strokeStyle = "#1e222b";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(790, 70);
    ctx.lineTo(790, VIEW_H);
    ctx.stroke();
    label(ctx, "OUTSIDE", 16, 92, { size: 12, color: "#8b93a1", weight: 700, align: "left" });
    label(ctx, fmt(hp.outdoorC), 16, 110, { size: 18, color: celsiusColor(hp.outdoorC), weight: 700, align: "left" });
    label(ctx, "INSIDE", 806, 92, { size: 12, color: "#8b93a1", weight: 700, align: "left" });
    if (hp.source === "heatPump") {
      label(ctx, "Heat pump (outdoor unit)", (LX0 + LX1) / 2, 92, { size: 13, color: "#c7cdd6", weight: 700 });
    }
  }

  private drawEnergyBar(ctx: CanvasRenderingContext2D, hp: HeatPumpModel): void {
    const s = hp.snap;
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, VIEW_W, 68);
    ctx.strokeStyle = "#1e222b";
    ctx.beginPath();
    ctx.moveTo(0, 68.5);
    ctx.lineTo(VIEW_W, 68.5);
    ctx.stroke();
    const x0 = 250;
    // px per kW: as big as fits, leaving room for the text after the bar.
    const widest = hp.source === "heatPump"
      ? Math.max(hp.snap.elecTotal + Math.max(0, hp.snap.qEvap), hp.snap.qCond)
      : hp.snap.gasIn;
    const scale = Math.min(52, (hp.source === "heatPump" ? 440 : 380) / Math.max(1e-3, widest));
    const y = 12;
    const h = 28;
    if (hp.source === "heatPump") {
      const elec = hp.running ? s.elecTotal : 0;
      const outside = hp.running ? Math.max(0, s.qEvap) : 0;
      const heat = Math.max(0, s.qCond);
      label(ctx, "Where the heat comes from", 16, y + 6, { size: 12, color: "#8b93a1", align: "left" });
      label(ctx, "right now", 16, y + 22, { size: 12, color: "#8b93a1", align: "left" });
      const after = bar(ctx, x0, y, elec * scale, h, "#f2c94c", `${elec.toFixed(1)} kW electricity`);
      bar(ctx, x0 + elec * scale, y, outside * scale, h, "#5f9fd8", `+ ${outside.toFixed(1)} kW from outside air`, after + 10);
      const end = x0 + Math.max(elec + outside, heat) * scale;
      label(ctx, "=", end + 14, y + h / 2, { size: 18, color: "#c7cdd6", weight: 700 });
      label(ctx, `${heat.toFixed(1)} kW heat into the water`, end + 30, y + h / 2, {
        size: 14, color: "#f0a070", weight: 700, align: "left",
      });
      const cop = hp.running && elec > 0.05 ? heat / elec : 0;
      label(ctx, hp.running ? `COP ${cop.toFixed(1)}` : "COP —", VIEW_W - 16, y + 6, {
        size: 20, color: "#e6e8ec", weight: 800, align: "right",
      });
      label(ctx, hp.running ? `${cop.toFixed(1)} kW of heat per kW of electricity` : "compressor off", VIEW_W - 16, y + 28, {
        size: 11, color: "#8b93a1", align: "right",
      });
    } else {
      const gas = s.gasIn;
      const heat = s.qBoiler;
      label(ctx, "Where the heat comes from", 16, y + 6, { size: 12, color: "#8b93a1", align: "left" });
      label(ctx, "right now", 16, y + 22, { size: 12, color: "#8b93a1", align: "left" });
      bar(ctx, x0, y, heat * scale, h, "#e07a5f", `${gas.toFixed(1)} kW of gas burned`);
      bar(ctx, x0 + heat * scale, y, (gas - heat) * scale, h, "#555c6a", "");
      const end = x0 + gas * scale;
      label(ctx, `→ ${heat.toFixed(1)} kW heat into the water, ${(gas - heat).toFixed(1)} kW up the flue`, end + 12, y + h / 2, {
        size: 13, color: "#f0a070", weight: 700, align: "left",
      });
      const eff = gas > 0.05 ? (100 * heat) / gas : 0;
      label(ctx, gas > 0.05 ? `${eff.toFixed(0)}% efficient` : "boiler off", VIEW_W - 16, y + 6, {
        size: 20, color: "#e6e8ec", weight: 800, align: "right",
      });
      label(ctx, "a boiler can never beat 100%", VIEW_W - 16, y + 28, { size: 11, color: "#8b93a1", align: "right" });
    }
  }

  // --- Refrigerant loop ---------------------------------------------------

  private updateParticles(hp: HeatPumpModel, dt: number): void {
    const target = Math.round(Math.min(240, (hp.chargeKg * 1000) / 5));
    // A fresh preset starts the marbles in their steady-flow places.
    if (hp.presetLoads !== this.presetLoads) {
      this.presetLoads = hp.presetLoads;
      this.lastCharge = -1;
      this.puffs = [];
    }
    if (this.lastCharge < 0) {
      this.particles = [];
      for (let i = 0; i < target; i++) this.particles.push(this.spawn(hp));
    } else {
      // A small top-up visibly enters at the low-side service port; a full
      // weigh-in would just be one big clump, so spread that round the loop.
      const fromPort = target - this.particles.length <= 15;
      while (this.particles.length < target) {
        const p = this.spawn(hp);
        if (fromPort) p.s = PATH.segs.find((sg) => sg.zone === "lowMix")!.s0 + 60 + Math.random() * 30;
        this.particles.push(p);
      }
      while (this.particles.length > target) {
        const i = Math.floor(Math.random() * this.particles.length);
        const p = this.particles[i]!;
        const pt = pointAt(p.s);
        this.puffs.push({ x: pt.x, y: pt.y, vx: (Math.random() - 0.5) * 30, vy: -20 - Math.random() * 20, life: 1 });
        this.particles.splice(i, 1);
      }
    }
    this.lastCharge = hp.chargeKg;

    const flow = hp.running ? hp.snap.mdotComp / 0.016 : 0;
    for (const p of this.particles) {
      const pt = pointAt(p.s);
      const loc = localState(hp, pt.seg, pt.t);
      const speed = p.v * Math.min(170, (22 * flow) / visualDensity(loc.x));
      p.s = (p.s + speed * dt) % PATH.total;
      // Jiggle across the pipe: hotter refrigerant rattles about more.
      const jig = 2.2 * Math.sqrt(Math.max(0.2, (loc.T + 273) / 300)) * (loc.x > p.u ? 1.6 : 0.8);
      p.off = clamp(p.off + (Math.random() - 0.5) * jig * dt * 60, -PIPE_W / 2 + 2, PIPE_W / 2 - 2);
    }
    for (const q of this.puffs) {
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.life -= dt * 0.8;
    }
    this.puffs = this.puffs.filter((q) => q.life > 0);
    if (hp.leakOn && Math.random() < dt * 6) {
      const out = hp.snap.hi.Ptotal > R.P_ATM;
      this.puffs.push({
        x: LEAK.x + (out ? -6 : -40),
        y: LEAK.y,
        vx: out ? -40 - Math.random() * 30 : 45,
        vy: (Math.random() - 0.5) * 20,
        life: 1,
      });
    }
  }

  private spawn(hp: HeatPumpModel): Particle {
    // Place new marbles where they'd be in steady flow (dense in liquid).
    for (let tries = 0; tries < 50; tries++) {
      const s = Math.random() * PATH.total;
      const pt = pointAt(s);
      const loc = localState(hp, pt.seg, pt.t);
      if (Math.random() < visualDensity(loc.x)) return { s, off: (Math.random() - 0.5) * 8, u: Math.random(), v: 0.85 + Math.random() * 0.3 };
    }
    return { s: Math.random() * PATH.total, off: 0, u: Math.random(), v: 0.85 + Math.random() * 0.3 };
  }

  private drawLoop(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, dt: number, fmt: TempFormatter): void {
    const s = hp.snap;
    // High / low side shading.
    ctx.fillStyle = "rgba(224,122,95,0.06)";
    ctx.fillRect(LX0 - 30, LY0 - 55, LX1 - LX0 + 60, (LY1 - LY0) / 2 + 45);
    ctx.fillStyle = "rgba(95,143,216,0.07)";
    ctx.fillRect(LX0 - 30, (LY0 + LY1) / 2 - 10, LX1 - LX0 + 60, (LY1 - LY0) / 2 + 60);
    label(ctx, "HIGH PRESSURE SIDE", LX1 + 22, LY0 + 60, { size: 10, color: "rgba(224,122,95,0.8)", weight: 700, align: "left" });
    label(ctx, `${gaugeBar(s.hi.Ptotal)} bar`, LX1 + 22, LY0 + 74, { size: 10, color: "rgba(224,122,95,0.8)", align: "left" });
    label(ctx, "LOW PRESSURE SIDE", LX1 + 22, LY1 - 40, { size: 10, color: "rgba(95,159,216,0.9)", weight: 700, align: "left" });
    label(ctx, `${gaugeBar(s.lo.Ptotal)} bar`, LX1 + 22, LY1 - 26, { size: 10, color: "rgba(95,159,216,0.9)", align: "left" });

    this.drawCondenserBox(ctx, hp);
    this.drawEvaporatorBox(ctx, hp, dt);

    // Pipes coloured by the refrigerant temperature along them.
    ctx.lineCap = "round";
    ctx.lineWidth = PIPE_W + 4;
    ctx.strokeStyle = "#05070a";
    ctx.beginPath();
    for (const sg of PATH.segs) {
      ctx.moveTo(sg.x0, sg.y0);
      ctx.lineTo(sg.x1, sg.y1);
    }
    ctx.stroke();
    ctx.lineWidth = PIPE_W;
    const step = 6;
    for (let d = 0; d < PATH.total; d += step) {
      const a = pointAt(d);
      const b = pointAt(Math.min(PATH.total - 0.01, d + step));
      const loc = localState(hp, a.seg, a.t);
      ctx.strokeStyle = celsiusRgba(loc.T, 0.55);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Marbles.
    for (const p of this.particles) {
      const pt = pointAt(p.s);
      const x = pt.x + pt.nx * p.off;
      const y = pt.y + pt.ny * p.off;
      if (Math.hypot(x - COMP.x, y - COMP.y) < COMP.r - 2) continue;
      const loc = localState(hp, pt.seg, pt.t);
      if (p.u < loc.x) {
        ctx.strokeStyle = "rgba(238,242,247,0.75)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, 3.3, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#eef2f7";
        ctx.beginPath();
        ctx.arc(x, y, 2.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const q of this.puffs) {
      ctx.fillStyle = `rgba(200,210,220,${(q.life * 0.6).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2.5 + (1 - q.life) * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawCompressor(ctx, hp, dt);
    this.drawAccumulator(ctx);
    this.drawExpansionValve(ctx, hp);
    this.drawSightGlass(ctx, hp);
    if (hp.leakOn) {
      const out = s.hi.Ptotal > R.P_ATM;
      label(ctx, out ? "LEAK: refrigerant escaping" : "LEAK: air being sucked in", LEAK.x + 14, LEAK.y, {
        size: 11, color: "#ff8a6a", weight: 700, align: "left",
      });
    }
    if (s.hi.Pnc > 0.15 && s.hi.phase === "twoPhase") {
      ctx.fillStyle = "rgba(170,175,185,0.35)";
      ctx.beginPath();
      ctx.ellipse(HX0 + 40, LY0 - 18, 34, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      label(ctx, `air trapped: +${s.hi.Pnc.toFixed(1)} bar`, HX0 + 40, LY0 - 18, { size: 10, color: "#e6e8ec", weight: 700 });
    }

    this.drawStageCaptions(ctx, hp, fmt);
  }

  private drawCondenserBox(ctx: CanvasRenderingContext2D, hp: HeatPumpModel): void {
    const s = hp.snap;
    const y0 = LY0 - 30;
    const y1 = LY0 + 30;
    roundRect(ctx, HX0 - 8, y0, HX1 - HX0 + 16, y1 - y0, 8);
    ctx.fillStyle = "#141922";
    ctx.fill();
    ctx.strokeStyle = "#3a4459";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Water channel above the refrigerant channel, counter-flow: cool
    // return water enters on the left, leaves hot on the right.
    const tIn = hp.tReturn;
    const tOut = s.mdotWater > 0 ? hp.tReturn + s.qCond / (s.mdotWater * 4.186) : hp.tReturn;
    const grad = ctx.createLinearGradient(HX0, 0, HX1, 0);
    grad.addColorStop(0, celsiusRgba(tIn, 0.8));
    grad.addColorStop(1, celsiusRgba(tOut, 0.8));
    ctx.fillStyle = grad;
    ctx.fillRect(HX0, LY0 - 24, HX1 - HX0, 9);
    // Heat arrows from refrigerant up into the water.
    if (hp.running && s.qCond > 0.1) {
      const n = Math.min(8, Math.round(s.qCond * 1.2));
      for (let i = 0; i < n; i++) {
        const x = HX0 + 20 + ((i + 0.5) * (HX1 - HX0 - 40)) / n;
        heatArrow(ctx, x, LY0 - 7, x, LY0 - 15, "#f0a070", this.time + i * 0.3);
      }
    }
    label(ctx, "CONDENSER (plate heat exchanger)", (HX0 + HX1) / 2, LY0 + 20, { size: 10, color: "#c7cdd6", weight: 700 });
  }

  private drawEvaporatorBox(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, dt: number): void {
    const s = hp.snap;
    const y0 = LY1 - 28;
    const y1 = LY1 + 28;
    ctx.fillStyle = "#131a24";
    roundRect(ctx, HX0 - 8, y0, HX1 - HX0 + 16, y1 - y0, 6);
    ctx.fill();
    ctx.strokeStyle = "#3a4459";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Fins
    ctx.strokeStyle = "rgba(150,170,200,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = HX0; x <= HX1; x += 7) {
      ctx.moveTo(x, y0 + 3);
      ctx.lineTo(x, y1 - 3);
    }
    ctx.stroke();
    label(ctx, "EVAPORATOR (outdoor air coil)", (HX0 + HX1) / 2, LY1 - 19, { size: 10, color: "#c7cdd6", weight: 700 });

    // Fan underneath blowing outdoor air up through the coil.
    const fanOn = hp.running ? hp.fanPct / 100 : 0;
    this.fanAngle += dt * fanOn * 14;
    ctx.save();
    ctx.translate(FAN.x, FAN.y);
    ctx.strokeStyle = "#3a4459";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.rotate(this.fanAngle);
    ctx.fillStyle = fanOn > 0 ? "#8fa3bf" : "#4a5263";
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.ellipse(0, -14, 6, 13, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    label(ctx, fanOn > 0 ? `fan ${hp.fanPct.toFixed(0)}%` : "fan off", FAN.x + 42, FAN.y + 4, { size: 10, color: "#8b93a1", align: "left" });

    // Air arrows through the coil, coloured by temperature.
    if (fanOn > 0) {
      for (let i = 0; i < 5; i++) {
        const x = HX0 + 20 + i * ((HX1 - HX0 - 40) / 4);
        if (Math.abs(x - FAN.x) < 34) continue;
        arrow(ctx, x, LY1 + 60, x, LY1 + 34, celsiusColor(hp.outdoorC), 2);
        arrow(ctx, x, LY1 - 32, x, LY1 - 52, celsiusColor(s.airOut), 2);
      }
      label(ctx, `air in ${this.fmt(hp.outdoorC, 0)}`, HX0 - 12, LY1 + 50, { size: 10, color: "#8b93a1", align: "right" });
      // The middle arrow is skipped (fan below), which leaves room for this.
      label(ctx, `air out ${this.fmt(s.airOut, 0)}`, FAN.x, LY1 - 42, { size: 10, color: "#8b93a1" });
      // Heat soaking into the coil from the air.
      const n = Math.min(8, Math.round(Math.max(0, s.qEvap) * 1.4));
      for (let i = 0; i < n; i++) {
        const x = HX0 + 15 + ((i + 0.5) * (HX1 - HX0 - 30)) / n;
        heatArrow(ctx, x, LY1 + 24, x, LY1 + 10, "#f0a070", this.time + i * 0.37);
      }
    }
  }

  private drawCompressor(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, dt: number): void {
    const s = hp.snap;
    this.compAngle += dt * (hp.running ? hp.hz / 8 : 0);
    ctx.beginPath();
    ctx.arc(COMP.x, COMP.y, COMP.r, 0, Math.PI * 2);
    ctx.fillStyle = "#1b2130";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = hp.running ? "#f2c94c" : "#3a4459";
    ctx.stroke();
    // Orbiting scroll: an off-centre spiral that wobbles as it turns.
    ctx.save();
    ctx.translate(COMP.x + Math.cos(this.compAngle) * 5, COMP.y + Math.sin(this.compAngle) * 5);
    ctx.strokeStyle = hp.running ? "#f2c94c" : "#5a6275";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 5; a += 0.2) {
      const r = 3 + a * 1.6;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (a === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
    label(ctx, "COMPRESSOR", COMP.x + COMP.r + 8, COMP.y + 24, { size: 10, color: "#c7cdd6", weight: 700, align: "left" });
    label(ctx, hp.running ? `${hp.hz.toFixed(0)} Hz` : "off", COMP.x + COMP.r + 8, COMP.y + 37, { size: 10, color: "#8b93a1", align: "left" });
    // Electricity in.
    const elecX = COMP.x + COMP.r + 6;
    ctx.strokeStyle = hp.running ? "#f2c94c" : "#3a4459";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(elecX + 50, COMP.y - 8);
    ctx.lineTo(elecX + 22, COMP.y - 8);
    ctx.lineTo(elecX + 30, COMP.y + 2);
    ctx.lineTo(elecX, COMP.y + 2);
    ctx.stroke();
    if (hp.running) {
      label(ctx, `⚡ ${s.elecComp.toFixed(1)} kW`, elecX + 54, COMP.y - 8, { size: 11, color: "#f2c94c", weight: 700, align: "left" });
    }
    label(ctx, `discharge ${this.fmt(s.tDischarge, 0)}`, LX1 + 22, LY0 + 18, { size: 10, color: celsiusColor(s.tDischarge), align: "left" });
  }

  private drawAccumulator(ctx: CanvasRenderingContext2D): void {
    roundRect(ctx, LX1 - 13, ACC_Y0, 26, ACC_Y1 - ACC_Y0, 10);
    ctx.fillStyle = "rgba(20,25,34,0.85)";
    ctx.fill();
    ctx.strokeStyle = "#3a4459";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private drawExpansionValve(ctx: CanvasRenderingContext2D, hp: HeatPumpModel): void {
    const { x, y } = EEV;
    ctx.fillStyle = "#1b2130";
    ctx.strokeStyle = "#c7cdd6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 14, y - 16);
    ctx.lineTo(x + 14, y - 16);
    ctx.lineTo(x - 14, y + 16);
    ctx.lineTo(x + 14, y + 16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Stepper motor on top with an opening gauge.
    roundRect(ctx, x + 18, y - 12, 12, 24, 3);
    ctx.fillStyle = "#1b2130";
    ctx.fill();
    ctx.stroke();
    const open = hp.eev;
    ctx.fillStyle = "#6fcf97";
    ctx.fillRect(x + 20, y + 10 - 20 * open, 8, 20 * open);
    label(ctx, "EXPANSION VALVE", x - 20, y - 6, { size: 10, color: "#c7cdd6", weight: 700, align: "right" });
    label(ctx, `${(open * 100).toFixed(0)}% open`, x - 20, y + 7, { size: 10, color: "#8b93a1", align: "right" });
  }

  private drawSightGlass(ctx: CanvasRenderingContext2D, hp: HeatPumpModel): void {
    const s = hp.snap;
    const { x, y } = SIGHT;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fillStyle = "#0e1622";
    ctx.fill();
    ctx.strokeStyle = "#c7cdd6";
    ctx.lineWidth = 2;
    ctx.stroke();
    const bubbles = hp.running && s.x3 > 0.005;
    if (bubbles) {
      for (let i = 0; i < 5; i++) {
        const a = this.time * 3 + i * 1.3;
        ctx.strokeStyle = "rgba(230,240,255,0.8)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * 5, y + ((this.time * 20 + i * 7) % 18) - 9, 1.8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    label(ctx, "sight glass", x + 16, y - 6, { size: 10, color: "#8b93a1", align: "left" });
    label(ctx, !hp.running ? "" : bubbles ? "bubbling — flash gas" : "clear — full of liquid", x + 16, y + 7, {
      size: 10, color: bubbles ? "#ff8a6a" : "#6fcf97", align: "left",
    });
  }

  private drawStageCaptions(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, fmt: TempFormatter): void {
    const s = hp.snap;
    const cx = (LX0 + LX1) / 2;
    const idle = !hp.running;
    caption(ctx, cx, LY0 + 48, "③", idle ? "Condenser" : `Hot vapour gives its heat to the water`, idle ? "" : `and condenses back to liquid at ${fmt(s.hi.T, 0)}`);
    caption(ctx, cx, LY1 - 88, "①", idle ? "Evaporator" : `Refrigerant boils at ${fmt(s.lo.T, 0)} —`, idle ? "" : `colder than the air, so heat flows in`);
    caption(ctx, LX0 + 105, (LY0 + LY1) / 2 + 60, "④", idle ? "Expansion valve" : "Pressure drops:", idle ? "" : "the liquid flashes ice cold");
    caption(ctx, COMP.x + 30, COMP.y - 70, "②", idle ? "Compressor" : "Squeezing", idle ? "" : `heats it to ${fmt(s.tDischarge, 0)}`, "left");

    // Machine status in the middle of the loop.
    const status = machineStatus(hp, this.fmt);
    label(ctx, status.title, cx, (LY0 + LY1) / 2 - 22, { size: 15, color: status.color, weight: 800 });
    wrapLabel(ctx, status.detail, cx, (LY0 + LY1) / 2 - 2, 250, { size: 11, color: "#c7cdd6" });
  }

  // --- Service side: gauges & tools --------------------------------------

  private drawService(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, fmt: TempFormatter): void {
    const s = hp.snap;
    // Hoses from the gauges to the service ports.
    hose(ctx, GAUGE_HI.x + GAUGE_R, GAUGE_HI.y, HI_PORT.x - 8, HI_PORT.y, "#b04a3a");
    hose(ctx, GAUGE_LO.x + GAUGE_R, GAUGE_LO.y, LO_PORT.x - 8, LO_PORT.y, "#3a6fb0");
    port(ctx, HI_PORT.x, HI_PORT.y);
    port(ctx, LO_PORT.x, LO_PORT.y);

    const hiG = s.hi.Ptotal - R.P_ATM;
    const loG = s.lo.Ptotal - R.P_ATM;
    const charged = hp.chargeKg > 0.02;
    drawGauge(ctx, GAUGE_HI.x, GAUGE_HI.y, GAUGE_R, "HIGH", hiG, 0, 35, "#e07a5f", P_HP_TRIP - R.P_ATM, fmt, s.hi.Ptotal, charged);
    drawGauge(ctx, GAUGE_LO.x, GAUGE_LO.y, GAUGE_R, "LOW", loG, -1, 15, "#5f9fd8", P_LP_TRIP - R.P_ATM, fmt, s.lo.Ptotal, charged);

    // Clamp thermometers and what a tech works out from them.
    const settled = hp.running && hp.runTimer > 60;
    const sh = hp.tSuctionMeas - R.tsat(Math.max(s.lo.Ptotal, 1e-3));
    const sc = R.tsat(Math.max(s.hi.Ptotal, 1e-3)) - hp.tLiquidMeas;
    readoutBox(ctx, 22, GAUGE_HI.y + GAUGE_R + 32, 166, [
      ["liquid line", settled ? fmt(hp.tLiquidMeas) : "—"],
      ["subcooling", settled ? formatDelta(fmt, sc) : "—"],
    ], "#e07a5f");
    readoutBox(ctx, 22, GAUGE_LO.y + GAUGE_R + 32, 166, [
      ["suction line", settled ? fmt(hp.tSuctionMeas) : "—"],
      ["superheat", settled ? formatDelta(fmt, sh) : "—"],
    ], "#5f9fd8");
    label(ctx, "clamp thermometers", 22 + 83, GAUGE_LO.y + GAUGE_R + 80, { size: 9, color: "#6b7383" });

    // Manifold body between the gauges; centre hose goes to the tools.
    roundRect(ctx, MANIFOLD.x - 30, MANIFOLD.y - 12, 60, 24, 5);
    ctx.fillStyle = "#262d3b";
    ctx.fill();
    ctx.strokeStyle = "#4a5263";
    ctx.stroke();
    label(ctx, "manifold", MANIFOLD.x, MANIFOLD.y, { size: 9, color: "#8b93a1" });

    // Tools along the bottom-left.
    const tools: { x: number; name: string; active: boolean; draw: (x: number, y: number) => void; info: string }[] = [
      {
        x: 40, name: "R290 on scale", active: false,
        draw: (x, y) => cylinder(ctx, x, y, "#c0392b", "R290"),
        info: `${hp.cylinderKg.toFixed(3)} kg`,
      },
      {
        x: 102, name: "vacuum", active: hp.vacuumOn,
        draw: (x, y) => vacuumPump(ctx, x, y, hp.vacuumOn, this.time),
        info: hp.vacuumOn || hp.decayStatus() ? micronText(hp.microns()) : "",
      },
      {
        x: 164, name: "recovery", active: hp.recoveryOn,
        draw: (x, y) => recoveryUnit(ctx, x, y, hp.recoveryOn, this.time),
        info: hp.recoveredKg > 0 ? `${(hp.recoveredKg * 1000).toFixed(0)} g` : "",
      },
      {
        x: 224, name: "nitrogen", active: hp.n2Test,
        draw: (x, y) => cylinder(ctx, x, y, "#2b2f36", "N₂"),
        info: hp.n2Test ? `${gaugeBar(s.lo.Ptotal)} bar` : "",
      },
    ];
    const toolY = 652;
    for (const t of tools) {
      if (!t.active) continue;
      // Centre hose: out of the manifold, down the left edge past the low
      // gauge, then along to the tool.
      const run = toolY - 42;
      ctx.strokeStyle = "#c7cdd6";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(MANIFOLD.x - 30, MANIFOLD.y);
      ctx.arcTo(10, MANIFOLD.y, 10, run, 10);
      ctx.arcTo(10, run, t.x, run, 10);
      ctx.arcTo(t.x, run, t.x, toolY - 30, 6);
      ctx.lineTo(t.x, toolY - 30);
      ctx.stroke();
    }
    tools.forEach((t, i) => {
      t.draw(t.x, toolY);
      label(ctx, t.name, t.x, toolY + 36, { size: 9, color: t.active ? "#e6e8ec" : "#8b93a1", weight: t.active ? 700 : 400 });
      // Stagger the readings so wide ones don't run into their neighbours.
      if (t.info) label(ctx, t.info, t.x, toolY + (i % 2 ? 61 : 49), { size: 10, color: "#f2c94c", weight: 700 });
    });
    // Scale under the bottle.
    ctx.fillStyle = "#262d3b";
    ctx.fillRect(22, toolY + 22, 36, 6);
  }

  // --- Water loop & house -------------------------------------------------

  private drawWaterPipes(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, dt: number, fmt: TempFormatter): void {
    const flowing = hp.snap.mdotWater > 0;
    this.waterPhase += dt * (flowing ? hp.pumpLpm * 2.2 : 0);
    const inX = hp.source === "heatPump" ? HX0 + 10 : 360;
    const outX = hp.source === "heatPump" ? HX1 - 10 : 500;
    const topY = hp.source === "heatPump" ? LY0 - 30 : 220;
    const houseX = HOUSE.x0 + 30;
    const radY = HOUSE.y1 - 70;
    const flow: [number, number][] = [[outX, topY], [outX, FLOW_Y], [HOUSE.x0 - 20, FLOW_Y], [HOUSE.x0 - 20, radY], [houseX, radY]];
    const ret: [number, number][] = [[houseX, radY + 22], [HOUSE.x0 - 40, radY + 22], [HOUSE.x0 - 40, RETURN_Y], [inX, RETURN_Y], [inX, topY]];
    waterPipe(ctx, flow, hp.tFlow, this.waterPhase);
    waterPipe(ctx, ret, hp.tReturn, this.waterPhase);
    label(ctx, `flow ${fmt(hp.tFlow)}`, 700, FLOW_Y + 13, { size: 11, color: celsiusColor(hp.tFlow), weight: 700 });
    label(ctx, `return ${fmt(hp.tReturn)}`, 700, RETURN_Y - 12, { size: 11, color: celsiusColor(hp.tReturn), weight: 700 });
    // Pump on the return.
    const px = HOUSE.x0 - 40;
    const py = 490;
    ctx.beginPath();
    ctx.arc(px, py, 13, 0, Math.PI * 2);
    ctx.fillStyle = "#1b2130";
    ctx.fill();
    ctx.strokeStyle = flowing ? "#6fcf97" : "#4a5263";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(this.waterPhase / 10);
    ctx.beginPath();
    ctx.moveTo(-7, 0);
    ctx.lineTo(7, 0);
    ctx.moveTo(0, -7);
    ctx.lineTo(0, 7);
    ctx.stroke();
    ctx.restore();
    label(ctx, "pump", px - 18, py - 4, { size: 10, color: "#8b93a1", align: "right" });
    label(ctx, `${hp.pumpLpm.toFixed(0)} L/min`, px - 18, py + 9, { size: 10, color: "#c7cdd6", align: "right" });
  }

  private drawHouse(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, fmt: TempFormatter): void {
    const s = hp.snap;
    const { x0, x1, y0, y1, peak } = HOUSE;
    const mid = (x0 + x1) / 2;
    // Room fill tinted by temperature.
    ctx.fillStyle = celsiusRgba(hp.tRoom, 0.28);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = "#8b93a1";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x0 - 15, y0 + 2);
    ctx.lineTo(mid, peak);
    ctx.lineTo(x1 + 15, y0 + 2);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1, y0);
    ctx.stroke();

    // Room temperature, big.
    const diff = hp.tRoom - hp.roomSetpointC;
    const tColor = Math.abs(diff) < 0.6 ? "#6fcf97" : diff < 0 ? "#5f9fd8" : "#f0a070";
    label(ctx, "ROOM", mid, y0 + 30, { size: 11, color: "#c7cdd6", weight: 700 });
    label(ctx, fmt(hp.tRoom), mid, y0 + 60, { size: 34, color: "#e6e8ec", weight: 800 });
    label(ctx, `thermostat set to ${fmt(hp.roomSetpointC, 0)}`, mid, y0 + 88, { size: 11, color: "#8b93a1" });
    label(
      ctx,
      Math.abs(diff) < 0.6 ? "comfortable" : diff < 0 ? `${(-diff).toFixed(1)}° too cold` : `${diff.toFixed(1)}° too warm`,
      mid, y0 + 106, { size: 12, color: tColor, weight: 700 }
    );

    // Heat escaping through walls and roof.
    const lossN = Math.min(7, Math.round(Math.max(0, s.qLoss) * 1.1));
    for (let i = 0; i < lossN; i++) {
      const t = (i + 0.5) / lossN;
      if (i % 2 === 0) {
        const y = y0 + 20 + t * (y1 - y0 - 40);
        heatArrow(ctx, x1 + 6, y, x1 + 30, y, "#e07a5f", this.time + i);
      } else {
        const x = x0 + 20 + t * (x1 - x0 - 40);
        const yRoof = y0 - (1 - Math.abs(x - mid) / ((x1 - x0) / 2 + 15)) * (y0 - peak);
        heatArrow(ctx, x, yRoof - 4, x, yRoof - 28, "#e07a5f", this.time + i);
      }
    }
    label(ctx, `heat escaping ${Math.max(0, s.qLoss).toFixed(1)} kW`, VIEW_W - 8, peak + 28, { size: 11, color: "#e07a5f", align: "right" });

    // Radiators: one panel per ~1.5 kW of rated output, so bigger
    // radiators literally take up more wall.
    const panels = Math.max(1, Math.min(16, Math.round(hp.radiatorQ50 / 1.5)));
    const tRad = (hp.tFlow + hp.tReturn) / 2;
    const rw = 18;
    const gap = 3;
    const perRow = 12;
    const rows = Math.ceil(panels / perRow);
    for (let i = 0; i < panels; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = Math.min(perRow, panels - row * perRow);
      const startX = mid - (inRow * (rw + gap)) / 2;
      const x = startX + col * (rw + gap);
      const y = y1 - 58 - row * 52;
      ctx.fillStyle = celsiusColor(tRad);
      roundRect(ctx, x, y, rw, 40, 3);
      ctx.fill();
      ctx.strokeStyle = "rgba(11,13,18,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let fx = x + 4; fx < x + rw - 2; fx += 5) {
        ctx.moveTo(fx, y + 4);
        ctx.lineTo(fx, y + 36);
      }
      ctx.stroke();
    }
    // Heat rising off the radiators.
    const qN = Math.min(8, Math.round(Math.max(0, s.qRad) * 1.3));
    for (let i = 0; i < qN; i++) {
      const x = mid - 100 + (i + 0.5) * (200 / qN);
      const y = y1 - 60 - (rows - 1) * 52;
      heatArrow(ctx, x, y - 6, x, y - 34, "#f0a070", this.time * 0.8 + i * 0.4);
    }
    label(ctx, `radiators: ${hp.radiatorQ50.toFixed(1)} kW rated (at ΔT50)`, mid, y1 + 16, { size: 11, color: "#c7cdd6" });
    label(ctx, `giving out ${Math.max(0, s.qRad).toFixed(1)} kW at ${fmt(tRad)} average water`, mid, y1 + 31, {
      size: 11, color: "#f0a070",
    });
  }

  // --- Boiler view ----------------------------------------------------------

  private drawBoiler(ctx: CanvasRenderingContext2D, hp: HeatPumpModel, fmt: TempFormatter): void {
    const s = hp.snap;
    const x0 = 340;
    const x1 = 520;
    const y0 = 220;
    const y1 = 520;
    label(ctx, "Gas boiler (for comparison)", (x0 + x1) / 2, 92, { size: 13, color: "#c7cdd6", weight: 700 });
    roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 12);
    ctx.fillStyle = "#1b2130";
    ctx.fill();
    ctx.strokeStyle = "#8b93a1";
    ctx.lineWidth = 2;
    ctx.stroke();
    // Heat exchanger coil.
    ctx.strokeStyle = celsiusColor(hp.tFlow);
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const y = y0 + 50 + i * 30;
      ctx.moveTo(x0 + 30, y);
      ctx.lineTo(x1 - 30, y);
    }
    ctx.stroke();
    // Flame sized by output.
    const f = s.qBoiler / 24;
    if (f > 0.01) {
      for (let i = 0; i < 7; i++) {
        const x = x0 + 30 + i * ((x1 - x0 - 60) / 6);
        const h = 20 + 60 * f * (0.7 + 0.3 * Math.sin(this.time * 9 + i * 1.7));
        const g = ctx.createLinearGradient(x, y1 - 30, x, y1 - 30 - h);
        g.addColorStop(0, "rgba(90,140,255,0.9)");
        g.addColorStop(0.4, "rgba(255,160,60,0.85)");
        g.addColorStop(1, "rgba(255,220,120,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - 9, y1 - 30);
        ctx.quadraticCurveTo(x, y1 - 30 - h * 1.2, x + 9, y1 - 30);
        ctx.fill();
      }
    }
    // Gas in, flue out.
    ctx.strokeStyle = "#f2c94c";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo((x0 + x1) / 2, y1);
    ctx.lineTo((x0 + x1) / 2, y1 + 70);
    ctx.lineTo(x0 - 60, y1 + 70);
    ctx.stroke();
    label(ctx, `gas ${s.gasIn.toFixed(1)} kW`, x0 - 60, y1 + 88, { size: 11, color: "#f2c94c", align: "left" });
    ctx.strokeStyle = "#555c6a";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(x0 + 30, y0);
    ctx.lineTo(x0 + 30, 160);
    ctx.stroke();
    label(ctx, "flue", x0 + 48, 172, { size: 10, color: "#8b93a1", align: "left" });
    label(ctx, "BOILER", (x0 + x1) / 2, y1 - 12, { size: 11, color: "#c7cdd6", weight: 700 });
    const status = machineStatus(hp, this.fmt);
    label(ctx, status.title, 140, 330, { size: 15, color: status.color, weight: 800 });
    wrapLabel(ctx, status.detail, 140, 352, 240, { size: 11, color: "#c7cdd6" });
    label(ctx, `flow set to ${fmt(hp.designFlowC, 0)}`, 140, 420, { size: 11, color: "#8b93a1" });
  }
}

// --- Status text ---------------------------------------------------------

export interface MachineStatus {
  title: string;
  detail: string;
  color: string;
}

export function machineStatus(hp: HeatPumpModel, fmt: TempFormatter): MachineStatus {
  const s = hp.snap;
  if (hp.source === "boiler") {
    if (s.qBoiler > 0.1) return { title: "BOILER FIRING", detail: `Burning gas to heat the water to ${fmt(hp.designFlowC, 0)}.`, color: "#f0a070" };
    return { title: "BOILER OFF", detail: "The room is warm enough.", color: "#8b93a1" };
  }
  if (hp.vacuumOn) {
    const m = hp.microns();
    if (hp.chargeKg > 0.02) {
      return { title: "VENTING REFRIGERANT!", detail: "The vacuum pump is blowing refrigerant into the air. Recover it first — venting is illegal and wastes the charge.", color: "#ff6b5a" };
    }
    if (hp.waterLiquid > 0 && m < 20000) {
      return { title: "EVACUATING", detail: `${micronText(m)} and stalling: moisture inside is boiling off. Keep pumping.`, color: "#f2c94c" };
    }
    if (m < 500) return { title: "EVACUATING", detail: `${micronText(m)} — below 500 microns. Isolate the pump and do a decay test.`, color: "#6fcf97" };
    return { title: "EVACUATING", detail: `Pulling air out of the system: ${micronText(m)}.`, color: "#f2c94c" };
  }
  if (hp.recoveryOn) {
    const done = s.lo.Ptotal < 0.4;
    return {
      title: done ? "RECOVERY COMPLETE" : "RECOVERING REFRIGERANT",
      detail: `${(hp.recoveredKg * 1000).toFixed(0)} g pumped into the recovery bottle.${done ? " The system is empty." : ""}`,
      color: done ? "#6fcf97" : "#f2c94c",
    };
  }
  if (hp.n2Test) {
    return {
      title: "NITROGEN PRESSURE TEST",
      detail: hp.leakOn
        ? `Pressure is dropping (${gaugeBar(s.lo.Ptotal)} bar): there's a leak. Find it before going any further.`
        : `Holding at ${gaugeBar(s.lo.Ptotal)} bar. No drop means no leaks — vent the nitrogen and evacuate.`,
      color: hp.leakOn ? "#ff6b5a" : "#6fcf97",
    };
  }
  const decay = hp.decayStatus();
  if (decay && hp.chargeKg < 0.001) {
    const rising = decay.rise > 500 * Math.max(1, decay.minutes / 10);
    return {
      title: rising ? "DECAY TEST: FAILING" : "DECAY TEST",
      detail: rising
        ? `Up ${decay.rise.toFixed(0)} microns in ${decay.minutes.toFixed(0)} min and still rising: air is leaking in.`
        : `${micronText(hp.microns())}, up ${Math.max(0, decay.rise).toFixed(0)} in ${decay.minutes.toFixed(0)} min. Holding — weigh in the charge.`,
      color: rising ? "#ff6b5a" : "#6fcf97",
    };
  }
  if (hp.trip) return { title: "LOCKED OUT", detail: `${hp.trip.reason}. It will try again in ${Math.ceil(hp.trip.timer / 60)} min.`, color: "#ff6b5a" };
  if (hp.chargeKg < 0.05) {
    const air = hp.ncHi + hp.ncLo > 0.001;
    return {
      title: "NO REFRIGERANT",
      detail: air ? "The system is full of air. Pressure test, evacuate, then weigh in the charge." : "Empty and under vacuum. Weigh in the charge from the bottle.",
      color: "#8b93a1",
    };
  }
  if (!hp.running) {
    if (hp.pumpLpm < 3) return { title: "NO WATER FLOW", detail: "The flow switch stops the compressor: with no water moving the pressure would shoot up.", color: "#ff6b5a" };
    if (!hp.demand && hp.runMode === "thermostat") return { title: "OFF", detail: "The room is warm enough; the thermostat has switched the heat pump off.", color: "#8b93a1" };
    return { title: "STARTING", detail: "Waiting out the anti-short-cycle timer.", color: "#8b93a1" };
  }
  return { title: `RUNNING · COP ${s.cop.toFixed(1)}`, detail: diagnose(hp, fmt), color: "#6fcf97" };
}

/** What a technician would conclude from the gauges and thermometers. */
export function diagnose(hp: HeatPumpModel, fmt: TempFormatter): string {
  const s = hp.snap;
  if (hp.runTimer < 120) return "Settling after start-up — give it a couple of minutes before reading the gauges.";
  const sh = hp.tSuctionMeas - R.tsat(Math.max(s.lo.Ptotal, 1e-3));
  const sc = R.tsat(Math.max(s.hi.Ptotal, 1e-3)) - hp.tLiquidMeas;
  if (s.xSuction < 1) return "Liquid is flooding back to the compressor — far too much refrigerant on the low side.";
  if (s.hi.Pnc > 0.3) return "Head pressure high and subcooling reads high: air (non-condensables) in the system. Recover, evacuate, recharge.";
  if (sh > 7.5 && sc < 1.5) return "High superheat, no subcooling, bubbles in the sight glass: undercharged. Find the leak, then top up.";
  if (sc > 8) return "Subcooling and head pressure high: liquid backing up in the condenser — overcharged.";
  if (sc < 1.5) return "Subcooling has gone: no spare liquid in the condenser. The valve is opening wider to hide it — short of charge. Look for a leak.";
  if (hp.tRoom < hp.roomSetpointC - 1 && s.qRad < s.qLoss) {
    if (hp.hz > HZ_MAX - 1 && hp.tFlow < s.flowTarget - 2) {
      return "The charge is fine, but it's flat out and still can't keep up: too small for this cold. A backup heater would help here.";
    }
    if (s.flowTarget > hp.designFlowC + 3) {
      return "The charge is fine, but the radiators are too small: the controls push the flow temperature up and the COP falls.";
    }
  }
  return `Superheat ${formatDelta(fmt, sh, 0)}, subcooling ${formatDelta(fmt, sc, 0)}: the charge is right.`;
}

// --- Drawing helpers ------------------------------------------------------

interface LabelOpts {
  size?: number;
  color?: string;
  weight?: number;
  align?: CanvasTextAlign;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, o: LabelOpts = {}): void {
  ctx.font = `${o.weight ?? 500} ${o.size ?? 12}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = o.color ?? "#c7cdd6";
  ctx.textAlign = o.align ?? "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function wrapLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, o: LabelOpts): void {
  ctx.font = `${o.weight ?? 500} ${o.size ?? 12}px system-ui, -apple-system, sans-serif`;
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => label(ctx, l, x, y + i * ((o.size ?? 12) + 4), o));
}

function caption(ctx: CanvasRenderingContext2D, x: number, y: number, num: string, l1: string, l2: string, align: CanvasTextAlign = "center"): void {
  label(ctx, `${num} ${l1}`, x, y, { size: 11, color: "#e6e8ec", weight: 700, align });
  if (l2) label(ctx, l2, x, y + 14, { size: 11, color: "#aab2bf", align });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws a bar segment with its caption underneath, starting no further left
 *  than `textX` so captions of thin neighbouring segments don't collide.
 *  Returns the right edge of the caption. */
function bar(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  color: string, text: string, textX = x,
): number {
  if (w <= 0.5) return textX;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#0b0d12";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (!text) return textX;
  const tx = Math.max(x + 2, textX);
  label(ctx, text, tx, y + h + 11, { size: 11, color, weight: 700, align: "left" });
  return tx + ctx.measureText(text).width;
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, w: number): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - Math.cos(a) * 5, y1 - Math.sin(a) * 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(a - 0.5) * 8, y1 - Math.sin(a - 0.5) * 8);
  ctx.lineTo(x1 - Math.cos(a + 0.5) * 8, y1 - Math.sin(a + 0.5) * 8);
  ctx.closePath();
  ctx.fill();
}

/** A wavy "heat" arrow that shimmers along its length. */
function heatArrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, phase: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const alpha = 0.55 + 0.45 * Math.sin(phase * 4);
  ctx.globalAlpha = Math.max(0.2, alpha);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let d = 0; d <= len - 5; d += 1.5) {
    const w = Math.sin(d * 0.5 + phase * 6) * 2.5;
    const x = x0 + ux * d - uy * w;
    const y = y0 + uy * d + ux * w;
    if (d === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * 6 - uy * 4, y1 - uy * 6 + ux * 4);
  ctx.lineTo(x1 - ux * 6 + uy * 4, y1 - uy * 6 - ux * 4);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function hose(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  const mx = (x0 + x1) / 2;
  ctx.bezierCurveTo(mx, y0 + 25, mx, y1 + 25, x1, y1);
  ctx.stroke();
}

function port(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#c7cdd6";
  ctx.fillRect(x - 12, y - 4, 8, 8);
}

function waterPipe(ctx: CanvasRenderingContext2D, pts: [number, number][], T: number, phase: number): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#05070a";
  ctx.lineWidth = 12;
  polyline(ctx, pts);
  ctx.stroke();
  ctx.strokeStyle = celsiusColor(T);
  ctx.lineWidth = 8;
  polyline(ctx, pts);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 10]);
  ctx.lineDashOffset = -phase;
  polyline(ctx, pts);
  ctx.stroke();
  ctx.setLineDash([]);
}

function polyline(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
}

function drawGauge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  name: string,
  pGauge: number,
  min: number,
  max: number,
  color: string,
  tripGauge: number,
  fmt: TempFormatter,
  pAbs: number,
  charged: boolean,
): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#e9ecef";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();
  const a0 = Math.PI * 0.75;
  const sweep = Math.PI * 1.5;
  const angle = (p: number) => a0 + (clamp(p, min, max) - min) / (max - min) * sweep;
  // Red zone beyond the pressure switch setting.
  ctx.strokeStyle = "rgba(220,60,40,0.55)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  if (name === "HIGH") ctx.arc(cx, cy, r - 8, angle(tripGauge), angle(max));
  else ctx.arc(cx, cy, r - 8, angle(min), angle(tripGauge));
  ctx.stroke();
  const step = max - min > 20 ? 5 : 2;
  ctx.strokeStyle = "#1b2130";
  ctx.lineWidth = 1.2;
  for (let p = Math.ceil(min / step) * step; p <= max; p += step) {
    const a = angle(p);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
    ctx.lineTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
    ctx.stroke();
    label(ctx, `${p}`, cx + Math.cos(a) * (r - 20), cy + Math.sin(a) * (r - 20), { size: 8, color: "#1b2130", weight: 600 });
  }
  const a = angle(pGauge);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#111";
  ctx.fill();
  label(ctx, name, cx, cy + 16, { size: 10, color, weight: 800 });
  label(ctx, "bar", cx, cy + 27, { size: 8, color: "#555" });
  // Digital readout under the dial: pressure and the matching R290
  // saturation temperature, like the temperature scale on a real gauge.
  const pText = pGauge > max ? `>${max}` : pGauge.toFixed(1);
  label(ctx, `${pText} bar`, cx, cy + r + 11, { size: 12, color: "#e6e8ec", weight: 700 });
  const sat = pGauge < -0.1 ? "vacuum" : !charged ? "no refrigerant inside" : pAbs > 0.72 ? `R290 boils at ${fmt(R.tsat(pAbs), 0)}` : "vacuum";
  label(ctx, sat, cx, cy + r + 25, { size: 10, color: "#8b93a1" });
}

function readoutBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, rows: [string, string][], color: string): void {
  roundRect(ctx, x, y, w, rows.length * 16 + 8, 5);
  ctx.fillStyle = "#12161f";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  rows.forEach(([k, v], i) => {
    label(ctx, k, x + 8, y + 12 + i * 16, { size: 10, color: "#8b93a1", align: "left" });
    label(ctx, v, x + w - 8, y + 12 + i * 16, { size: 11, color: "#e6e8ec", weight: 700, align: "right" });
  });
}

function cylinder(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, text: string): void {
  roundRect(ctx, x - 12, y - 22, 24, 44, 8);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#8b93a1";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#8b93a1";
  ctx.fillRect(x - 4, y - 30, 8, 8);
  label(ctx, text, x, y, { size: 9, color: "#fff", weight: 700 });
}

function vacuumPump(ctx: CanvasRenderingContext2D, x: number, y: number, on: boolean, t: number): void {
  roundRect(ctx, x - 22, y - 12, 44, 30, 5);
  ctx.fillStyle = on ? "#2f6f4f" : "#262d3b";
  ctx.fill();
  ctx.strokeStyle = "#8b93a1";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - 6, y + 3, 8, 0, Math.PI * 2);
  ctx.stroke();
  if (on) {
    ctx.beginPath();
    ctx.moveTo(x - 6, y + 3);
    ctx.lineTo(x - 6 + Math.cos(t * 20) * 7, y + 3 + Math.sin(t * 20) * 7);
    ctx.stroke();
  }
}

function recoveryUnit(ctx: CanvasRenderingContext2D, x: number, y: number, on: boolean, t: number): void {
  roundRect(ctx, x - 20, y - 16, 40, 34, 5);
  ctx.fillStyle = on ? "#6b4f1d" : "#262d3b";
  ctx.fill();
  ctx.strokeStyle = "#8b93a1";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = on && Math.sin(t * 8) > 0 ? "#f2c94c" : "#4a5263";
  ctx.beginPath();
  ctx.arc(x + 10, y - 7, 3, 0, Math.PI * 2);
  ctx.fill();
}

function micronText(m: number): string {
  if (m > 25000) return "micron gauge: OL";
  return `${Math.round(m).toLocaleString("en-GB")} microns`;
}

function gaugeBar(pAbs: number): string {
  return (pAbs - R.P_ATM).toFixed(1);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
