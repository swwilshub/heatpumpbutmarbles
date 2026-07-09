import { Simulation } from "./sim/simulation";
import type { LineSegment, PotentialParams } from "./sim/types";
import { seedLattice } from "./sim/init";
import { Rng } from "./sim/rng";
import { CanvasRenderer } from "./render/canvasRenderer";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas);

const stepEl = document.getElementById("stepStat") as HTMLElement;
const nEl = document.getElementById("nStat") as HTMLElement;
const keEl = document.getElementById("keStat") as HTMLElement;
const peEl = document.getElementById("peStat") as HTMLElement;
const eEl = document.getElementById("eStat") as HTMLElement;
const tmEl = document.getElementById("tmStat") as HTMLElement;
const fpsEl = document.getElementById("fpsStat") as HTMLElement;
const tempSlider = document.getElementById("temp") as HTMLInputElement;
const tempVal = document.getElementById("tempVal") as HTMLElement;
const potentialSelect = document.getElementById("potential") as HTMLSelectElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const stepBtn = document.getElementById("step") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;

let paused = false;
let sim: Simulation;

function boxSegments(x0: number, y0: number, x1: number, y1: number): LineSegment[] {
  return [
    { ax: x0, ay: y0, bx: x1, by: y0, epsilon: 1, sigma: 1 },
    { ax: x1, ay: y0, bx: x1, by: y1, epsilon: 1, sigma: 1 },
    { ax: x1, ay: y1, bx: x0, by: y1, epsilon: 1, sigma: 1 },
    { ax: x0, ay: y1, bx: x0, by: y0, epsilon: 1, sigma: 1 },
  ];
}

function makeSim(): Simulation {
  const potentialKind = potentialSelect.value === "wca" ? "wca" : "lj";
  const potential: PotentialParams = {
    kind: potentialKind,
    epsilon: 1,
    sigma: 1,
    rCut: 2.5,
  };
  const domain = { xMin: 0, yMin: 0, xMax: 40, yMax: 30 };
  const s = new Simulation({
    domain,
    potential,
    segments: boxSegments(1, 1, 39, 29),
    dt: 0.005,
    capacity: 2000,
  });
  const T = Number(tempSlider.value);
  seedLattice(s, { xMin: 3, yMin: 3, xMax: 37, yMax: 27 }, 1.2, T, new Rng(1234));
  s.primeForces();
  return s;
}

sim = makeSim();

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "resume" : "pause";
});
stepBtn.addEventListener("click", () => {
  if (paused) sim.advance(1);
});
resetBtn.addEventListener("click", () => {
  sim = makeSim();
});
potentialSelect.addEventListener("change", () => {
  sim = makeSim();
});
tempSlider.addEventListener("input", () => {
  tempVal.textContent = Number(tempSlider.value).toFixed(2);
});

// Frame loop. Physics runs in fixed-size substeps decoupled from render frames
// so slower devices skip frames rather than integrate with too large a dt.
const dt = sim.config.dt;
const targetPhysicsPerFrame = 4; // substeps per rendered frame at 60 fps
let lastFrame = performance.now();
let fpsAvg = 60;

function frame(now: number) {
  const dtMs = now - lastFrame;
  lastFrame = now;
  const fps = 1000 / Math.max(1, dtMs);
  fpsAvg = fpsAvg * 0.9 + fps * 0.1;

  if (!paused) sim.advance(targetPhysicsPerFrame);

  const T = Number(tempSlider.value);
  renderer.draw(sim, { temperatureScale: T, atomRadius: 0.55 });

  const d = sim.diagnostics();
  stepEl.textContent = String(d.step);
  nEl.textContent = String(sim.n);
  keEl.textContent = d.kineticEnergy.toFixed(2);
  peEl.textContent = d.potentialEnergy.toFixed(2);
  eEl.textContent = d.totalEnergy.toFixed(2);
  tmEl.textContent = d.temperature.toFixed(3);
  fpsEl.textContent = fpsAvg.toFixed(0);

  requestAnimationFrame(frame);
}
tempVal.textContent = Number(tempSlider.value).toFixed(2);
void dt;
requestAnimationFrame(frame);
