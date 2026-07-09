import { CanvasRenderer } from "./render/canvasRenderer";
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
let currentId = SCENARIOS[0]!.id;

function load(id: string) {
  currentId = id;
  const scenario = scenarioById(id);
  blurbEl.textContent = scenario.blurb;
  const built = scenario.build();
  sim = built.sim;
  tick = built.tick;
  readouts = built.readouts ?? [];
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

const SUBSTEPS = 4;
let lastFrame = performance.now();
let fpsAvg = 60;

function frame(now: number) {
  const dtMs = now - lastFrame;
  lastFrame = now;
  const fps = 1000 / Math.max(1, dtMs);
  fpsAvg = fpsAvg * 0.9 + fps * 0.1;

  if (!paused) {
    for (let s = 0; s < SUBSTEPS; s++) {
      tick(sim.step);
      sim.advance(1);
    }
  }

  // Colour scale — use the running measured T so hot atoms read hot at
  // whatever temperature the scenario is currently at.
  const d = sim.diagnostics();
  const tScale = Math.max(0.3, d.temperature);
  renderer.draw(sim, { temperatureScale: tScale, atomRadius: 0.5 });

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
