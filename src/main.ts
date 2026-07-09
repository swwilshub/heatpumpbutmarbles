import { CanvasRenderer, type RegionOverlay } from "./render/canvasRenderer";
import { SCENARIOS, scenarioById, type Readout } from "./scenarios";
import type { Simulation } from "./sim/simulation";

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
const dilationSlider = document.getElementById("dilation") as HTMLInputElement;
const dilationLabel = document.getElementById("dilationLabel") as HTMLElement;

// Substeps-per-frame mapping. 0 → paused. Powers-of-two ladder from 1× to 32×.
// (Rendered frames stay at ~60 fps; more substeps means faster sim time.)
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
let temperatureScale = 2.0;
let regions: RegionOverlay[] = [];
let currentId = SCENARIOS[0]!.id;

function load(id: string) {
  currentId = id;
  const scenario = scenarioById(id);
  blurbEl.textContent = scenario.blurb;
  const built = scenario.build();
  sim = built.sim;
  tick = built.tick;
  readouts = built.readouts ?? [];
  temperatureScale = built.temperatureScale ?? 2.0;
  regions = built.regions ?? [];
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
    val.textContent = r.value();
    stat.appendChild(label);
    stat.appendChild(val);
    row.appendChild(stat);
    readoutsEl.appendChild(row);
    readoutEls.push(val);
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

  renderer.draw(sim, {
    temperatureScale,
    atomRadius: 0.5,
    regions,
    drawLegend: true,
  });

  const d = sim.diagnostics();
  stepEl.textContent = String(d.step);
  nEl.textContent = String(sim.n);
  keEl.textContent = d.kineticEnergy.toFixed(2);
  peEl.textContent = d.potentialEnergy.toFixed(2);
  eEl.textContent = d.totalEnergy.toFixed(2);
  tmEl.textContent = d.temperature.toFixed(3);
  fpsEl.textContent = fpsAvg.toFixed(0);
  for (let i = 0; i < readouts.length; i++) {
    readoutEls[i]!.textContent = readouts[i]!.value();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
