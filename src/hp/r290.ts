// Propane (R290) property model for the heat pump diagram.
//
// Saturation data every 10 °C from -50 to 80 °C, IIR reference state
// (saturated liquid at 0 °C: h = 200 kJ/kg). Values are rounded from NIST
// data and checked against Clausius–Clapeyron; they are good to a few
// percent, which is plenty for a teaching model. Units throughout:
//   T °C, P bar absolute, ρ kg/m³, v m³/kg, h/u kJ/kg, cp kJ/(kg·K).

const T_MIN = -50;
const T_STEP = 10;
const T_TAB = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80];
const P_TAB = [0.7055, 1.111, 1.679, 2.445, 3.451, 4.745, 6.366, 8.362, 10.79, 13.69, 17.13, 21.17, 25.89, 31.37];
const RHO_L = [591, 579, 567, 554, 541, 528, 514, 500, 485, 468, 449, 428, 404, 375];
const RHO_V = [1.72, 2.61, 3.82, 5.4, 7.43, 10.35, 13.8, 17.9, 22.9, 29.1, 36.6, 46.0, 58.0, 74.0];
const H_L = [83.5, 105.9, 128.7, 152.0, 175.7, 200.0, 224.9, 250.5, 277.0, 304.4, 333.1, 363.4, 395.9, 431.8];
const H_V = [515.5, 529.5, 542.7, 555.5, 567.7, 579.8, 590.9, 601.5, 611.5, 620.4, 628.6, 634.9, 639.4, 639.8];
// Vapour cp near the saturation line at that saturation temperature.
const CP_V = [1.66, 1.7, 1.75, 1.81, 1.88, 1.96, 2.05, 2.16, 2.29, 2.45, 2.65, 2.92, 3.3, 3.9];
const CP_L = [2.23, 2.26, 2.3, 2.35, 2.4, 2.46, 2.52, 2.6, 2.69, 2.8, 2.94, 3.12, 3.38, 3.8];

const LN_P = P_TAB.map(Math.log);
const LN_RHO_V = RHO_V.map(Math.log);
const N = T_TAB.length;
export const T_TABLE_MIN = T_MIN;
export const T_TABLE_MAX = T_TAB[N - 1]!;

/** Specific gas constant of propane, kJ/(kg·K). */
export const R_R290 = 8.314 / 44.1;
/** Specific gas constant used for non-condensables (air / nitrogen). */
export const R_AIR = 0.287;
export const R_WATER = 0.4615;
/** Atmospheric pressure, bar absolute. */
export const P_ATM = 1.01325;
/** 1 bar = 750 062 microns of mercury. */
export const MICRONS_PER_BAR = 750062;

function lerpTable(tab: readonly number[], T: number): number {
  const f = (T - T_MIN) / T_STEP;
  let i = Math.floor(f);
  if (i < 0) i = 0;
  else if (i > N - 2) i = N - 2;
  const t = f - i;
  return tab[i]! + (tab[i + 1]! - tab[i]!) * t;
}

// Inverse lookup on a monotonic table: returns T with tab(T) = y.
function invertTable(tab: readonly number[], y: number, increasing: boolean): number {
  let lo = 0;
  let hi = N - 1;
  const inside = (k: number) => (increasing ? tab[k]! <= y : tab[k]! >= y);
  if (!inside(0)) {
    lo = 0;
  } else if (inside(N - 1)) {
    lo = N - 2;
  } else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (inside(mid)) lo = mid;
      else hi = mid;
    }
  }
  const a = tab[lo]!;
  const b = tab[lo + 1]!;
  const t = (y - a) / (b - a);
  return T_TAB[lo]! + t * T_STEP;
}

export const psat = (T: number): number => Math.exp(lerpTable(LN_P, T));
export const tsat = (P: number): number => invertTable(LN_P, Math.log(Math.max(P, 1e-9)), true);
export const rhoL = (T: number): number => lerpTable(RHO_L, T);
export const rhoV = (T: number): number => Math.exp(lerpTable(LN_RHO_V, T));
export const hL = (T: number): number => lerpTable(H_L, T);
export const hV = (T: number): number => lerpTable(H_V, T);
export const cpV = (T: number): number => lerpTable(CP_V, T);
export const cpL = (T: number): number => lerpTable(CP_L, T);
export const vL = (T: number): number => 1 / rhoL(T);
export const vV = (T: number): number => 1 / rhoV(T);
/** Internal energies (P·v in kPa·m³/kg = kJ/kg). */
export const uL = (T: number): number => hL(T) - 100 * psat(T) * vL(T);
export const uV = (T: number): number => hV(T) - 100 * psat(T) * vV(T);
const cvV = (T: number): number => cpV(T) - R_R290;

/** Enthalpy of superheated vapour at pressure P and temperature T. */
export function hVapour(P: number, T: number): number {
  const Ts = tsat(P);
  return hV(Ts) + cpV(Ts) * Math.max(0, T - Ts);
}

/** Temperature of superheated vapour with enthalpy h at pressure P. */
export function tVapour(P: number, h: number): number {
  const Ts = tsat(P);
  return Ts + Math.max(0, h - hV(Ts)) / cpV(Ts);
}

/** Saturation vapour pressure of water, bar (Magnus formula). */
export function pWater(T: number): number {
  return 0.0061094 * Math.exp((17.625 * T) / (T + 243.04));
}

export type Phase = "twoPhase" | "vapour" | "liquid";

export interface RefrigerantState {
  T: number; // °C (saturation temperature when two-phase)
  P: number; // bar abs, refrigerant partial pressure
  x: number; // vapour quality by mass (0 liquid … 1 vapour)
  phase: Phase;
  liquidVolume: number; // m³ of liquid in the volume
}

// Bulk modulus used once a volume is completely full of liquid. The real
// value is far higher; this is soft enough to integrate stably and still
// sends pressure off the scale (the high-pressure switch trips first).
const K_LIQUID = 800; // bar per unit volumetric strain

function twoPhaseU(T: number, v: number): number {
  const vl = vL(T);
  const vg = vV(T);
  const x = (v - vl) / (vg - vl);
  const ul = uL(T);
  return ul + x * (uV(T) - ul);
}

/**
 * State of a closed refrigerant volume from its mass (kg), internal energy
 * (kJ) and volume (m³). `guess` is the previous temperature, used to warm
 * start the root find so each call only needs a few evaluations.
 */
export function solveRefrigerant(m: number, U: number, V: number, guess?: number): RefrigerantState {
  const v = V / m;
  const u = U / m;

  // Density below saturated vapour at the bottom of the table: a thin gas.
  if (v >= vV(T_MIN)) {
    const T = T_MIN + (u - uV(T_MIN)) / cvV(T_MIN);
    const P = (R_R290 * (T + 273.15)) / v / 100;
    return { T, P, x: 1, phase: "vapour", liquidVolume: 0 };
  }

  // Temperature at which saturated vapour has this density.
  const Tv = Math.min(T_TABLE_MAX, invertTable(LN_RHO_V, -Math.log(v), true));
  if (u >= uV(Tv)) {
    const T = Tv + (u - uV(Tv)) / cvV(Tv);
    const P = psat(Tv) * ((T + 273.15) / (Tv + 273.15));
    return { T, P, x: 1, phase: "vapour", liquidVolume: 0 };
  }

  // Liquid line: temperature at which saturated liquid has this density.
  const Tl = v < vL(T_TABLE_MAX) ? invertTable(RHO_L, 1 / v, false) : Infinity;
  const Tup = Math.min(Tv, Tl, T_TABLE_MAX);

  const f = (T: number) => twoPhaseU(T, v) - u;
  let lo = T_MIN;
  let hi = Tup;
  if (f(lo) >= 0) return twoPhaseAt(T_MIN, v, m);
  if (f(hi) <= 0) {
    if (Tl <= Tup) {
      // Completely full of liquid: pressure rises steeply with compression.
      let a = Tl;
      let b = T_TABLE_MAX;
      for (let k = 0; k < 30; k++) {
        const mid = 0.5 * (a + b);
        if (uL(mid) < u) a = mid;
        else b = mid;
      }
      const T = 0.5 * (a + b);
      const strain = Math.max(0, (vL(T) - v) / vL(T));
      return { T, P: psat(T) + K_LIQUID * strain, x: 0, phase: "liquid", liquidVolume: V };
    }
    return twoPhaseAt(Tup, v, m);
  }

  // Safeguarded secant from the previous solution, falling back to bisection.
  let T = guess !== undefined && guess > lo && guess < hi ? guess : 0.5 * (lo + hi);
  let fT = f(T);
  if (fT < 0) lo = T;
  else hi = T;
  let T2 = Math.min(hi, Math.max(lo, T + (fT < 0 ? 0.5 : -0.5)));
  let f2 = f(T2);
  for (let k = 0; k < 40; k++) {
    if (f2 < 0) lo = Math.max(lo, T2);
    else hi = Math.min(hi, T2);
    if (Math.abs(f2) < 1e-6 || hi - lo < 1e-6) break;
    let next = f2 !== fT ? T2 - (f2 * (T2 - T)) / (f2 - fT) : NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    T = T2;
    fT = f2;
    T2 = next;
    f2 = f(T2);
  }
  return twoPhaseAt(T2, v, m);
}

function twoPhaseAt(T: number, v: number, m: number): RefrigerantState {
  const vl = vL(T);
  const x = Math.min(1, Math.max(0, (v - vl) / (vV(T) - vl)));
  return { T, P: psat(T), x, phase: "twoPhase", liquidVolume: m * (1 - x) * vl };
}

/** Internal energy (kJ) of m kg at saturation temperature T and quality x. */
export function twoPhaseEnergy(m: number, T: number, x: number): number {
  return m * (uL(T) + x * (uV(T) - uL(T)));
}

/** Internal energy (kJ) of m kg filling volume V as vapour at temperature T. */
export function vapourEnergy(m: number, V: number, T: number): number {
  const v = V / m;
  if (v >= vV(T_MIN)) return m * (uV(T_MIN) + cvV(T_MIN) * (T - T_MIN));
  const Tv = Math.min(T_TABLE_MAX, invertTable(LN_RHO_V, -Math.log(v), true));
  return m * (uV(Tv) + cvV(Tv) * Math.max(0, T - Tv));
}
