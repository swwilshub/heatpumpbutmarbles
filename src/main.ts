import { CanvasRenderer, type PartSchematic } from "./render/canvasRenderer";
import {
  SCENARIOS,
  regionToRenderer,
  type Readout,
  type Region,
  type Scenario,
  type ScenarioAction,
  type ScenarioSlider,
} from "./scenarios";
import type { Simulation } from "./sim/simulation";
import {
  DEFAULT_ANCHORS,
  REFRIGERANT_NAME,
  celsiusToFahrenheit,
  formatTemperature,
  starToCelsius,
  type UnitAnchors,
  type UnitMode,
} from "./units";
import { TimeSeries, drawTimeSeriesPlot, type PlotSeriesSpec } from "./render/timeSeries";
import { buildHeatPumpView, type HeatPumpView } from "./hp/view";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $<HTMLElement>("stage");
const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d")!;
const renderer = new CanvasRenderer(canvas);

const stepLabelEl = $<HTMLElement>("stepLabel");
const stepEl = $<HTMLElement>("stepStat");
const nRow = $<HTMLElement>("nRow");
const nEl = $<HTMLElement>("nStat");
const tmRow = $<HTMLElement>("tmRow");
const keEl = $<HTMLElement>("keStat");
const peEl = $<HTMLElement>("peStat");
const eEl = $<HTMLElement>("eStat");
const tmEl = $<HTMLElement>("tmStat");
const fpsEl = $<HTMLElement>("fpsStat");
const scenarioSel = $<HTMLSelectElement>("scenario");
const blurbEl = $<HTMLElement>("blurb");
const pauseBtn = $<HTMLButtonElement>("pause");
const stepBtn = $<HTMLButtonElement>("step");
const resetBtn = $<HTMLButtonElement>("reset");
const readoutsEl = $<HTMLElement>("readouts");
const slidersEl = $<HTMLElement>("sliders");
const actionsEl = $<HTMLElement>("actions");
const explainerEl = $<HTMLElement>("explainer");
const dilationSlider = $<HTMLInputElement>("dilation");
const dilationTitle = $<HTMLElement>("dilationTitle");
const dilationLabel = $<HTMLElement>("dilationLabel");
const graphSection = $<HTMLElement>("graphSection");
const graphCanvas = $<HTMLCanvasElement>("graphCanvas");
const graphLegend = $<HTMLElement>("graphLegend");
const marbleHelp = $<HTMLElement>("marbleHelp");
const unitSel = $<HTMLSelectElement>("units");
const expertRow = $<HTMLElement>("expertRow");
$<HTMLElement>("refrigerantName").textContent = REFRIGERANT_NAME;
const graphCtx = graphCanvas.getContext("2d")!;

// 300 samples pushed every 4th frame ≈ 20 s of history at 60 fps.
const SERIES_CAPACITY = 300;
const MD_SUBSTEPS = [0, 1, 2, 4, 8, 16, 32];
// Simulated seconds per real second for the diagram. The house takes hours
// to warm up, so the top of the range compresses half an hour into a second.
const DIAGRAM_SPEEDS = [0, 1, 10, 60, 300, 900, 1800];

type Entry = { id: string; name: string; blurb: string; group: string } & (
  | { kind: "md"; scenario: Scenario }
  | { kind: "diagram" }
);

const ENTRIES: Entry[] = [
  {
    kind: "diagram",
    id: "heat_pump",
    name: "How a heat pump works",
    group: "How a heat pump works",
    blurb:
      "A real R290 air-to-water heat pump heating a house. Watch the refrigerant go round: it boils in the outdoor coil, gets squeezed hot by the compressor, gives its heat to the radiator water and flashes cold again through the expansion valve. Service it like an engineer, break it, or swap in a gas boiler to compare.",
  },
  ...SCENARIOS.map((s): Entry => ({ kind: "md", id: s.id, name: s.name, blurb: s.blurb, group: s.group, scenario: s })),
];

{
  let group: HTMLOptGroupElement | null = null;
  for (const e of ENTRIES) {
    if (!group || group.label !== e.group) {
      group = document.createElement("optgroup");
      group.label = e.group;
      scenarioSel.appendChild(group);
    }
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.name;
    group.appendChild(opt);
  }
}

// --- Per-view state ------------------------------------------------------

interface MdState {
  sim: Simulation;
  tick: (step: number) => void;
  anchors: UnitAnchors;
  regions: Region[];
  parts: PartSchematic[];
  cMin?: number;
  cMax?: number;
}

let md: MdState | null = null;
let diagram: HeatPumpView | null = null;
let current: Entry = ENTRIES[0]!;
let paused = false;
let frameCount = 0;

interface SeriesLine {
  name: string;
  colour: string;
  celsius: () => number;
  buffer: TimeSeries;
}
let seriesLines: SeriesLine[] = [];
let readouts: Readout[] = [];
let readoutEls: HTMLElement[] = [];
// Temperature readouts jitter with thermal noise in the marble scenarios, so
// they show a short rolling average.
const readoutAverages = new Map<Readout, TimeSeries>();
let liveSliders: { spec: ScenarioSlider; input: HTMLInputElement; valueEl: HTMLElement }[] = [];
let liveActions: { spec: ScenarioAction; btn: HTMLButtonElement }[] = [];

function unitMode(): UnitMode {
  const v = unitSel.value;
  return v === "F" ? "F" : v === "star" ? "star" : "C";
}

function formatStar(tStar: number): string {
  return formatTemperature(tStar, unitMode(), md?.anchors ?? DEFAULT_ANCHORS, 1);
}

function formatCelsius(c: number, digits = 1): string {
  const f = unitMode() === "F";
  const text = (f ? celsiusToFahrenheit(c) : c).toFixed(digits);
  // Avoid showing "-0".
  return `${Number(text) === 0 ? (0).toFixed(digits) : text} ${f ? "°F" : "°C"}`;
}

function renderReadout(r: Readout): string {
  if (r.v.kind === "temperature") {
    const avg = readoutAverages.get(r);
    return formatStar(avg ? avg.mean() : r.v.value());
  }
  return r.v.value();
}

function load(id: string) {
  current = ENTRIES.find((e) => e.id === id) ?? ENTRIES[0]!;
  blurbEl.textContent = current.blurb;
  md = null;
  diagram = null;
  let sliders: ScenarioSlider[];
  let actions: ScenarioAction[];
  let explainer: string | undefined;

  if (current.kind === "md") {
    const built = current.scenario.build();
    md = {
      sim: built.sim,
      tick: built.tick,
      anchors: built.unitAnchors ?? DEFAULT_ANCHORS,
      regions: built.regions ?? [],
      parts: built.parts ?? [],
      cMin: built.cMin,
      cMax: built.cMax,
    };
    const anchors = md.anchors;
    readouts = built.readouts ?? [];
    sliders = built.sliders ?? [];
    actions = built.actions ?? [];
    explainer = built.explainer;
    seriesLines = (built.series ?? []).map((s) => ({
      name: s.name,
      colour: s.colour,
      celsius: () => starToCelsius(s.value(), anchors),
      buffer: new TimeSeries(SERIES_CAPACITY),
    }));
  } else {
    diagram = buildHeatPumpView(formatCelsius);
    readouts = diagram.readouts;
    sliders = diagram.sliders;
    actions = diagram.actions;
    explainer = diagram.explainer;
    seriesLines = diagram.series.map((s) => ({ ...s, celsius: s.value, buffer: new TimeSeries(SERIES_CAPACITY) }));
  }

  const isDiagram = current.kind === "diagram";
  nRow.style.display = isDiagram ? "none" : "";
  tmRow.style.display = isDiagram ? "none" : "";
  marbleHelp.style.display = isDiagram ? "none" : "";
  stepLabelEl.textContent = isDiagram ? "time" : "step";
  dilationTitle.textContent = isDiagram ? "simulation speed" : "time dilation (steps / frame)";
  expertRow.style.display = !isDiagram && unitSel.value === "star" ? "block" : "none";
  sizeCanvas();
  updateDilationLabel();

  graphSection.style.display = seriesLines.length > 0 ? "block" : "none";
  graphLegend.innerHTML = "";
  for (const s of seriesLines) {
    const chip = document.createElement("span");
    chip.style.cssText = "display:inline-block;margin-right:10px;";
    chip.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:${s.colour};margin-right:4px;vertical-align:middle;border-radius:2px;"></span>${s.name}`;
    graphLegend.appendChild(chip);
  }

  readoutAverages.clear();
  for (const r of readouts) {
    if (r.v.kind === "temperature") readoutAverages.set(r, new TimeSeries(60));
  }
  readoutsEl.innerHTML = "";
  readoutEls = [];
  let lastGroup: string | undefined;
  for (const r of readouts) {
    if (r.group && r.group !== lastGroup) {
      readoutsEl.appendChild(heading(r.group));
      lastGroup = r.group;
    }
    const row = document.createElement("div");
    row.className = "row";
    const stat = document.createElement("div");
    stat.className = "stat";
    const label = document.createElement("span");
    label.textContent = r.label;
    const val = document.createElement("span");
    val.textContent = renderReadout(r);
    stat.append(label, val);
    row.appendChild(stat);
    readoutsEl.appendChild(row);
    readoutEls.push(val);
  }
  renderSliders(sliders);
  renderActions(actions);
  explainerEl.innerHTML = explainer ?? "";
  explainerEl.style.display = explainer ? "block" : "none";
}

function heading(text: string): HTMLElement {
  const h = document.createElement("div");
  h.textContent = text;
  h.className = "groupHeading";
  return h;
}

function actionLabel(a: ScenarioAction): string {
  return typeof a.label === "function" ? a.label() : a.label;
}

function renderActions(actions: ScenarioAction[]) {
  actionsEl.innerHTML = "";
  liveActions = [];
  let lastGroup: string | undefined;
  let wrap: HTMLElement = actionsEl;
  for (const a of actions) {
    if (a.group !== lastGroup || wrap === actionsEl) {
      if (a.group) actionsEl.appendChild(heading(a.group));
      wrap = document.createElement("div");
      wrap.className = "buttonRow";
      actionsEl.appendChild(wrap);
      lastGroup = a.group;
    }
    const btn = document.createElement("button");
    btn.textContent = actionLabel(a);
    btn.addEventListener("click", () => {
      a.onClick();
      refreshControls();
    });
    wrap.appendChild(btn);
    liveActions.push({ spec: a, btn });
  }
}

function renderSliders(sliders: ScenarioSlider[]) {
  slidersEl.innerHTML = "";
  liveSliders = [];
  if (sliders.length === 0) return;
  let lastGroup: string | undefined;
  if (!sliders[0]!.group) slidersEl.appendChild(heading("parts"));
  for (const s of sliders) {
    if (s.group && s.group !== lastGroup) {
      slidersEl.appendChild(heading(s.group));
      lastGroup = s.group;
    }
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = s.label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.value = String(s.initial);
    const valueEl = document.createElement("span");
    valueEl.className = "sliderValue";
    const fmt = s.format ?? ((v: number) => v.toFixed(2));
    valueEl.textContent = fmt(s.initial);
    label.appendChild(valueEl);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      valueEl.textContent = fmt(v);
      s.onChange(v);
    });
    row.append(label, input);
    slidersEl.appendChild(row);
    liveSliders.push({ spec: s, input, valueEl });
  }
}

/** Keep toggle labels and slider positions in step with the model. */
function refreshControls() {
  for (const { spec, btn } of liveActions) {
    const text = actionLabel(spec);
    if (btn.textContent !== text) btn.textContent = text;
    btn.classList.toggle("active", spec.active?.() ?? false);
  }
  for (const { spec, input, valueEl } of liveSliders) {
    if (!spec.value || document.activeElement === input) continue;
    const v = spec.value();
    if (Number(input.value) !== v) input.value = String(v);
    valueEl.textContent = (spec.format ?? ((x: number) => x.toFixed(2)))(v);
  }
}

function sizeCanvas() {
  if (current.kind === "diagram") {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, stage.clientWidth - 16);
    const h = Math.max(240, stage.clientHeight - 16);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  } else {
    canvas.style.width = "";
    canvas.style.height = "";
    renderer.resize(720, 540);
  }
}

function speedIndex(): number {
  return Math.max(0, Math.min(MD_SUBSTEPS.length - 1, Number(dilationSlider.value)));
}

function updateDilationLabel() {
  const i = speedIndex();
  if (current.kind === "diagram") {
    const s = DIAGRAM_SPEEDS[i]!;
    dilationLabel.textContent =
      s === 0 ? "paused" : s === 1 ? "real time" : s < 60 ? `${s}× (${s} s per second)` : `${s / 60} min of sim per second`;
  } else {
    const s = MD_SUBSTEPS[i]!;
    dilationLabel.textContent = s === 0 ? "paused" : `${s}× (${s} steps / frame)`;
  }
}

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

load(current.id);
scenarioSel.value = current.id;

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "resume" : "pause";
});
stepBtn.addEventListener("click", () => {
  if (!paused) return;
  if (md) {
    md.tick(md.sim.step);
    md.sim.advance(1);
  } else if (diagram) {
    diagram.model.advance(1);
  }
});
resetBtn.addEventListener("click", () => load(current.id));
scenarioSel.addEventListener("change", () => load(scenarioSel.value));
dilationSlider.addEventListener("input", updateDilationLabel);
unitSel.addEventListener("change", () => {
  expertRow.style.display = current.kind === "md" && unitSel.value === "star" ? "block" : "none";
});
window.addEventListener("resize", sizeCanvas);

let lastFrame = performance.now();
let fpsAvg = 60;

function frame(now: number) {
  const wallDt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  fpsAvg = fpsAvg * 0.9 + (1 / Math.max(1e-3, wallDt)) * 0.1;
  const idx = speedIndex();

  if (md) {
    const substeps = MD_SUBSTEPS[idx]!;
    if (!paused) {
      for (let s = 0; s < substeps; s++) {
        md.tick(md.sim.step);
        md.sim.advance(1);
      }
    }
    renderer.draw(md.sim, {
      atomRadius: 0.5,
      anchors: md.anchors,
      regions: md.regions.map((r) => regionToRenderer(r, formatStar)),
      parts: md.parts,
      drawLegend: true,
      cMin: md.cMin,
      cMax: md.cMax,
    });
    const d = md.sim.diagnostics();
    stepEl.textContent = String(d.step);
    nEl.textContent = String(md.sim.n);
    keEl.textContent = d.kineticEnergy.toFixed(2);
    peEl.textContent = d.potentialEnergy.toFixed(2);
    eEl.textContent = d.totalEnergy.toFixed(2);
    tmEl.textContent = formatStar(d.temperature);
  } else if (diagram) {
    const speed = DIAGRAM_SPEEDS[idx]!;
    const running = !paused && speed > 0;
    if (running) diagram.model.advance(speed * wallDt);
    diagram.diagram.draw(ctx, canvas.width, canvas.height, diagram.model, wallDt, running, formatCelsius);
    stepEl.textContent = clock(diagram.model.time);
  }

  for (const r of readouts) {
    const avg = readoutAverages.get(r);
    if (avg && r.v.kind === "temperature") avg.push(r.v.value());
  }
  frameCount++;
  if (frameCount % 4 === 0 && !paused) {
    for (const s of seriesLines) s.buffer.push(s.celsius());
  }
  if (seriesLines.length > 0) {
    const specs: PlotSeriesSpec[] = seriesLines.map((s) => ({ name: s.name, colour: s.colour, series: s.buffer }));
    drawTimeSeriesPlot(graphCtx, graphCanvas.width, graphCanvas.height, specs, { yUnit: "°C" });
  }
  fpsEl.textContent = fpsAvg.toFixed(0);
  for (let i = 0; i < readouts.length; i++) readoutEls[i]!.textContent = renderReadout(readouts[i]!);
  if (frameCount % 6 === 0) refreshControls();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
