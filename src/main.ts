import { CanvasRenderer, type PartSchematic } from "./render/canvasRenderer";
import {
  SCENARIOS,
  scenarioById,
  regionToRenderer,
  type Readout,
  type Region,
  type ScenarioSlider,
} from "./scenarios";
import type { Simulation } from "./sim/simulation";
import { DEFAULT_ANCHORS, formatTemperature, type UnitAnchors, type UnitMode } from "./units";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas);

const stepEl = document.getElementById("stepStat") as HTMLElement;
const nEl = document.getElementById("nStat") as HTMLElement;
const keEl = document.getElementById("keStat") as HTMLElement;
const peEl = document.getElementById("peStat") as HTMLElement;
const eEl = document.getElementById("eStat") as HTMLElement;
const tmEl = document.getElementById("tmStat") as HTMLElement;
const fpsEl = document.getElementById("fpsStat") as HTMLElement;
const scenarioSel = document.getElementById("scenario") as HTMLSelectElement;
const blurbEl = document.getElementById("blurb") as HTMLElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const stepBtn = document.getElementById("step") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const readoutsEl = document.getElementById("readouts") as HTMLElement;
const slidersEl = document.getElementById("sliders") as HTMLElement;
const dilationSlider = document.getElementById("dilation") as HTMLInputElement;
const dilationLabel = document.getElementById("dilationLabel") as HTMLElement;
const unitSel = document.getElementById("units") as HTMLSelectElement;
const expertRow = document.getElementById("expertRow") as HTMLElement;

const SUBSTEP_LADDER = [0, 1, 2, 4, 8, 16, 32];

for (const s of SCENARIOS) {
  const opt = document.createElement("option");
  opt.value = s.id;
  opt.textContent = s.name;
  scenarioSel.appendChild(opt);
}

let paused = false;
let sim: Simulation;
let tick: (step: number) => void;
let readouts: Readout[] = [];
let readoutEls: HTMLElement[] = [];
let anchors: UnitAnchors = DEFAULT_ANCHORS;
let cMin: number | undefined;
let cMax: number | undefined;
let regions: Region[] = [];
let parts: PartSchematic[] = [];
let currentId = SCENARIOS[0]!.id;

function unitMode(): UnitMode {
  const v = unitSel.value;
  return v === "F" ? "F" : v === "star" ? "star" : "C";
}
function formatT(tStar: number): string {
  return formatTemperature(tStar, unitMode(), anchors, 1);
}

function renderReadout(r: Readout): string {
  if (r.v.kind === "temperature") return formatT(r.v.value());
  return r.v.value();
}

function load(id: string) {
  currentId = id;
  const scenario = scenarioById(id);
  blurbEl.textContent = scenario.blurb;
  const built = scenario.build();
  sim = built.sim;
  tick = built.tick;
  readouts = built.readouts ?? [];
  anchors = built.unitAnchors ?? DEFAULT_ANCHORS;
  regions = built.regions ?? [];
  parts = built.parts ?? [];
  cMin = built.cMin;
  cMax = built.cMax;
  readoutsEl.innerHTML = "";
  readoutEls = [];
  for (const r of readouts) {
    const row = document.createElement("div");
    row.className = "row";
    const stat = document.createElement("div");
    stat.className = "stat";
    const label = document.createElement("span");
    label.textContent = r.label;
    const val = document.createElement("span");
    val.textContent = renderReadout(r);
    stat.appendChild(label);
    stat.appendChild(val);
    row.appendChild(stat);
    readoutsEl.appendChild(row);
    readoutEls.push(val);
  }
  renderSliders(built.sliders ?? []);
}

function renderSliders(sliders: ScenarioSlider[]) {
  slidersEl.innerHTML = "";
  if (sliders.length === 0) return;
  const title = document.createElement("div");
  title.textContent = "parts";
  title.style.cssText = "font-size:11px;color:#8b93a1;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;";
  slidersEl.appendChild(title);
  for (const s of sliders) {
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
    const valSpan = document.createElement("span");
    valSpan.style.cssText = "font-variant-numeric:tabular-nums;color:#c7cdd6;font-size:12px;float:right;";
    const fmt = s.format ?? ((v: number) => v.toFixed(2));
    valSpan.textContent = fmt(s.initial);
    label.appendChild(valSpan);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      valSpan.textContent = fmt(v);
      s.onChange(v);
    });
    row.appendChild(label);
    row.appendChild(input);
    slidersEl.appendChild(row);
  }
}

load(currentId);
scenarioSel.value = currentId;

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "resume" : "pause";
});
stepBtn.addEventListener("click", () => {
  if (paused) {
    tick(sim.step);
    sim.advance(1);
  }
});
resetBtn.addEventListener("click", () => load(currentId));
scenarioSel.addEventListener("change", () => load(scenarioSel.value));

function currentSubsteps(): number {
  const idx = Math.max(0, Math.min(SUBSTEP_LADDER.length - 1, Number(dilationSlider.value)));
  return SUBSTEP_LADDER[idx]!;
}
function updateDilationLabel() {
  const s = currentSubsteps();
  dilationLabel.textContent = s === 0 ? "paused" : `${s}× (${s} steps / frame)`;
}
dilationSlider.addEventListener("input", updateDilationLabel);
updateDilationLabel();

unitSel.addEventListener("change", () => {
  // Show/hide expert (reduced-units) diagnostics based on mode.
  expertRow.style.display = unitSel.value === "star" ? "block" : "none";
});

let lastFrame = performance.now();
let fpsAvg = 60;

function frame(now: number) {
  const dtMs = now - lastFrame;
  lastFrame = now;
  const fps = 1000 / Math.max(1, dtMs);
  fpsAvg = fpsAvg * 0.9 + fps * 0.1;

  const substeps = currentSubsteps();
  if (!paused && substeps > 0) {
    for (let s = 0; s < substeps; s++) {
      tick(sim.step);
      sim.advance(1);
    }
  }

  const rendererRegions = regions.map((r) => regionToRenderer(r, formatT));
  renderer.draw(sim, {
    atomRadius: 0.5,
    anchors,
    regions: rendererRegions,
    parts,
    drawLegend: true,
    cMin,
    cMax,
  });

  const d = sim.diagnostics();
  stepEl.textContent = String(d.step);
  nEl.textContent = String(sim.n);
  keEl.textContent = d.kineticEnergy.toFixed(2);
  peEl.textContent = d.potentialEnergy.toFixed(2);
  eEl.textContent = d.totalEnergy.toFixed(2);
  tmEl.textContent = formatT(d.temperature);
  fpsEl.textContent = fpsAvg.toFixed(0);
  for (let i = 0; i < readouts.length; i++) {
    readoutEls[i]!.textContent = renderReadout(readouts[i]!);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
