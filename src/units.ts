// User-facing units. The MD engine works in reduced Lennard-Jones units
// (T*=1 sets the natural energy scale) — that's honest for physics but
// meaningless to anyone who doesn't already know MD. A scenario declares
// two anchor points that fix a LINEAR map T* ↔ °C, editable in the
// expert panel. Default anchors calibrate to an R290-like refrigerant
// loop: evaporator boils around -25 °C, condenser condenses around +55 °C.

export interface UnitAnchors {
  t1_star: number;
  t1_celsius: number;
  t2_star: number;
  t2_celsius: number;
}

// Propane (R290) calibration. Propane's LJ ε/k_B ≈ 250 K in the standard
// 2-parameter fit, giving room temperature at T*≈1.19 and typical heat-pump
// operating temperatures right in the demo's usual T* range. The anchor
// values below are chosen so 0 °C sits comfortably inside the palette and
// the compressor's post-compression T (T* ~ 1.5-1.8 in demo) reads as a
// believable 60-90 °C rather than something absurd.
export const DEFAULT_ANCHORS: UnitAnchors = {
  t1_star: 0.7, t1_celsius: -40,
  t2_star: 1.5, t2_celsius: 100,
};

// Name of the reference refrigerant these anchors are calibrated for.
// Used in the UI so users know what fluid they're seeing.
export const REFRIGERANT_NAME = "propane (R290)";

export function starToCelsius(t: number, a: UnitAnchors = DEFAULT_ANCHORS): number {
  const m = (a.t2_celsius - a.t1_celsius) / (a.t2_star - a.t1_star);
  return a.t1_celsius + m * (t - a.t1_star);
}

export function celsiusToStar(c: number, a: UnitAnchors = DEFAULT_ANCHORS): number {
  const m = (a.t2_star - a.t1_star) / (a.t2_celsius - a.t1_celsius);
  return a.t1_star + m * (c - a.t1_celsius);
}

export function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
}

export type UnitMode = "C" | "F" | "star";

export function formatTemperature(
  tStar: number,
  mode: UnitMode,
  anchors: UnitAnchors = DEFAULT_ANCHORS,
  decimals = 1
): string {
  if (mode === "star") return `T*=${tStar.toFixed(2)}`;
  const c = starToCelsius(tStar, anchors);
  if (mode === "F") return `${celsiusToFahrenheit(c).toFixed(decimals)} °F`;
  return `${c.toFixed(decimals)} °C`;
}
