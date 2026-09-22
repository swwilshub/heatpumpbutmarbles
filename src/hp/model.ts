// Dynamic model of an air-to-water R290 heat pump heating a house.
//
// The refrigerant circuit is two lumped volumes: the HIGH side (discharge
// line, condenser, liquid line) and the LOW side (evaporator, suction line,
// accumulator). Each is tracked by refrigerant mass and internal energy, so
// pressure, temperature and how much of each side is liquid all come out
// of the property model rather than being assumed. The compressor moves
// mass low → high, the expansion valve lets it back high → low, and the
// two heat exchangers add/remove heat. Superheat and subcooling follow from
// how much of the evaporator is still wet and how far liquid has backed up
// into the condenser — which is exactly what a technician's gauges read.
//
// Units: T °C, P bar absolute, mass kg, energy kJ, power kW, time s.

import * as R from "./r290";

export type HeatSource = "heatPump" | "boiler";
export type RunMode = "thermostat" | "service";
export type PresetId =
  | "normal"
  | "smallRadiators"
  | "undercharged"
  | "overcharged"
  | "air"
  | "newInstall";

// --- Refrigerant circuit geometry -----------------------------------------
const V_DISCHARGE = 0.35e-3;
const V_COND = 1.8e-3;
const V_LIQUID = 0.45e-3;
export const V_HI = V_DISCHARGE + V_COND + V_LIQUID;
const V_EVAP = 3.5e-3;
const V_SUCTION = 0.6e-3;
const V_ACC = 1.2e-3;
export const V_LO = V_EVAP + V_SUCTION + V_ACC;
const V_TOTAL = V_HI + V_LO;
/** Liquid fraction of the condenser volume while it is condensing normally. */
const FILM = 0.18;
/** Liquid fraction of the evaporator volume when it is wet end to end. */
const HOLDUP_EVAP = 0.22;

// --- Components -----------------------------------------------------------
const UA_EVAP = 1.1; // kW/K, outdoor coil at full fan
const UA_COND = 1.3; // kW/K, plate heat exchanger
const AIR_FLOW = 1.05; // kg/s through the outdoor coil at 100 % fan
const FAN_POWER = 0.07; // kW at 100 %
const PUMP_POWER = 0.045; // kW
const DISPLACEMENT = 30e-6; // m³ per revolution
const KAPPA = 1.13;
const MOTOR_EFF = 0.93;
const K_EEV = 1.6e-6; // m², expansion valve flow area × discharge coefficient
const K_LEAK = 1.07e-9; // m², a flare-nut leak on the liquid line
const HZ_MIN = 20;
export const HZ_MAX = 110;
const EEV_PARK = 0.15;
export const SH_TARGET = 5;
export const NAMEPLATE_CHARGE = 0.92; // kg

// --- Safety switches & timers --------------------------------------------
export const P_LP_TRIP = 1.2;
export const P_LP_CUT_IN = 1.8;
export const P_HP_TRIP = 28;
export const T_DISCHARGE_TRIP = 120;
const LP_DELAY = 20;
const MIN_OFF_TIME = 180;
const TRIP_RESET = 300;
const MIN_FLOW_LPM = 3;

// --- Water loop & house ---------------------------------------------------
const M_FLOW_PIPES = 15; // kg of water between the heat pump and radiators
const C_HOUSE = 6000; // kJ/K — a light house, so warm-up is watchable
const INTERNAL_GAINS = 0.25; // kW from people and appliances
export const DESIGN_OUTDOOR = -3;
const RAD_EXPONENT = 1.3;
const BOILER_MAX = 24;

// --- Service tools --------------------------------------------------------
const CYLINDER_T = 15;
const VACUUM_SPEED = 0.6e-3; // m³/s effective at the ports, through the hoses
// Hoses and valve cores choke the pump once flow stops being viscous, so the
// effective speed falls away at low pressure: half speed at this pressure.
const VACUUM_KNEE = 5000 / R.MICRONS_PER_BAR;
const VACUUM_ULTIMATE = 20 / R.MICRONS_PER_BAR;
// Air dissolved in the compressor oil comes back out slowly under vacuum.
const OIL_GAS_TAU = 600;
const RECOVERY_SPEED = 3e-3;
const RECOVERY_LIQUID = 0.012; // kg/s push-pull liquid recovery
const RECOVERY_FLOOR = 0.35;
const MOISTURE_RATE = 2e-4; // kg/s per bar of vapour-pressure deficit
const HUMIDITY = 0.006; // kg water per kg of air leaking in
const N2_TEST_P = 26; // bar abs ≈ 25 bar gauge
/** Below this a side is too thin to have a meaningful internal state. */
const M_TINY = 0.02;

export interface SideSnapshot extends R.RefrigerantState {
  m: number;
  Pnc: number; // non-condensable partial pressure
  Ptotal: number;
}

export interface Snapshot {
  hi: SideSnapshot;
  lo: SideSnapshot;
  /** Fraction of the condenser flooded with liquid. */
  psi: number;
  /** Vapour quality entering the liquid line (flash gas when > 0). */
  x3: number;
  /** Fraction of the evaporator that is still wet. */
  phi: number;
  /** Fraction of the condenser blanketed by air. */
  blanket: number;
  xSuction: number;
  superheat: number;
  subcooling: number;
  mdotComp: number;
  mdotEev: number;
  h1: number;
  h2: number;
  h3: number;
  x4: number;
  tDischarge: number;
  tSuction: number;
  tLiquid: number;
  qEvap: number;
  qCond: number;
  qRad: number;
  qLoss: number;
  qBoiler: number;
  gasIn: number;
  elecComp: number;
  elecTotal: number;
  cop: number;
  flowTarget: number;
  airOut: number;
  mdotWater: number;
}

export interface Trip {
  reason: string;
  timer: number;
}

interface DecayTest {
  startMicrons: number;
  startTime: number;
}

export class HeatPumpModel {
  // --- Settings (the UI writes these) ---
  source: HeatSource = "heatPump";
  runMode: RunMode = "thermostat";
  outdoorC = 2;
  /** Flow temperature the weather curve asks for at the design outdoor temperature. */
  designFlowC = 45;
  roomSetpointC = 21;
  radiatorQ50 = 18; // kW total radiator rating at ΔT50
  pumpLpm = 20;
  fanPct = 100;
  heatLossDesignKW = 6; // at -3 °C outside, 21 °C inside

  // --- Refrigerant state ---
  mHi = 0;
  UHi = 0;
  mLo = 0;
  ULo = 0;
  ncHi = 0; // kg of air / nitrogen
  ncLo = 0;
  waterLiquid = 0; // kg of moisture in the circuit
  waterVapour = 0;
  oilGas = 0; // kg of air dissolved in the compressor oil

  // --- Machine state ---
  running = false;
  hz = 0;
  eev = EEV_PARK;
  private hzI = 0;
  private eevI = EEV_PARK;
  offTimer = MIN_OFF_TIME;
  runTimer = 0;
  trip: Trip | null = null;
  private lpTimer = 0;
  demand = true;

  // --- Water & house ---
  tFlow = 30;
  tReturn = 28;
  tRoom = 20;
  private qBoilerSmoothed = 0;
  private dFlowSmoothed = 0;

  // --- Sensors (lagged like real clamp thermometers) ---
  tSuctionMeas = 0;
  tLiquidMeas = 0;
  private shActual = SH_TARGET;

  // --- Service ---
  vacuumOn = false;
  recoveryOn = false;
  leakOn = false;
  n2Test = false;
  /** Bumped on every preset load so views can reset their animation. */
  presetLoads = 0;
  cylinderKg = 5;
  recoveredKg = 0;
  leakedKg = 0;
  ventedKg = 0;
  private decay: DecayTest | null = null;
  private pumpedDown = false;

  // --- Bookkeeping ---
  time = 0;
  elecKWh = 0;
  heatKWh = 0;
  outsideKWh = 0;
  gasKWh = 0;

  snap!: Snapshot;
  private tHiGuess = 30;
  private tLoGuess = 0;

  constructor() {
    this.loadPreset("normal");
  }

  get chargeKg(): number {
    return this.mHi + this.mLo;
  }

  get serviceIsolated(): boolean {
    return this.vacuumOn || this.recoveryOn || this.n2Test;
  }

  /** Flow temperature the controller is aiming for right now. */
  flowTarget(): number {
    if (this.source === "boiler") return this.designFlowC;
    const lift = Math.max(0, (this.roomSetpointC - this.outdoorC) / (this.roomSetpointC - DESIGN_OUTDOOR));
    const curve = this.roomSetpointC + (this.designFlowC - this.roomSetpointC) * Math.pow(lift, 1 / RAD_EXPONENT);
    const roomBoost = Math.min(10, Math.max(-5, 2 * (this.roomSetpointC - this.tRoom)));
    return Math.min(70, Math.max(20, curve + roomBoost));
  }

  // --- Presets ------------------------------------------------------------

  loadPreset(id: PresetId): void {
    this.presetLoads++;
    this.source = "heatPump";
    this.runMode = "thermostat";
    this.outdoorC = 2;
    this.designFlowC = 45;
    this.roomSetpointC = 21;
    this.radiatorQ50 = 18;
    this.pumpLpm = 20;
    this.fanPct = 100;
    this.heatLossDesignKW = 6;
    this.vacuumOn = this.recoveryOn = this.leakOn = this.n2Test = false;
    this.decay = null;
    this.pumpedDown = false;
    this.trip = null;
    this.running = false;
    this.demand = true;
    this.hz = 0;
    this.offTimer = MIN_OFF_TIME;
    this.cylinderKg = 5;
    this.recoveredKg = this.leakedKg = this.ventedKg = 0;
    this.ncHi = this.ncLo = 0;
    this.waterLiquid = this.waterVapour = this.oilGas = 0;
    this.tRoom = 20.5;
    this.tFlow = 35;
    this.tReturn = 32;

    let charge = NAMEPLATE_CHARGE;
    if (id === "smallRadiators") this.radiatorQ50 = 7.5;
    if (id === "undercharged") charge = NAMEPLATE_CHARGE * 0.5;
    if (id === "overcharged") charge = NAMEPLATE_CHARGE * 1.25;
    if (id === "air") this.fillWithGas(0.5); // system charged without being evacuated first

    if (id === "newInstall") {
      charge = 0;
      this.fillWithGas(R.P_ATM);
      this.waterLiquid = 0.003;
      this.oilGas = 0.00025;
      this.tRoom = 16;
      this.tFlow = this.tReturn = 16;
    }

    this.setCharge(charge);
    this.resetCounters();
    if (charge > 0) {
      this.warmUp(1200);
      this.resetCounters();
    } else {
      this.step(0.1);
    }
  }

  private resetCounters(): void {
    this.time = 0;
    this.elecKWh = this.heatKWh = this.outsideKWh = this.gasKWh = 0;
  }

  /** Run the model forward quickly so presets open on a settled machine. */
  warmUp(seconds: number): void {
    const room = this.tRoom;
    for (let t = 0; t < seconds; t += 0.1) {
      this.step(0.1);
      this.tRoom = room;
    }
  }

  /** Put `kg` of refrigerant in the circuit at standstill, split so both sides equalise. */
  setCharge(kg: number): void {
    const T = this.outdoorC;
    // Standing system: both sides at outdoor temperature, same pressure,
    // mass split so the overall density is uniform.
    this.mHi = (kg * V_HI) / V_TOTAL;
    this.mLo = (kg * V_LO) / V_TOTAL;
    this.UHi = this.standingEnergy(this.mHi, V_HI, T);
    this.ULo = this.standingEnergy(this.mLo, V_LO, T);
    this.tHiGuess = this.tLoGuess = T;
  }

  private standingEnergy(m: number, V: number, T: number): number {
    if (m <= 0) return 0;
    const v = V / m;
    if (v >= R.vV(T)) return R.vapourEnergy(m, V, T);
    const x = Math.max(0, (v - R.vL(T)) / (R.vV(T) - R.vL(T)));
    return R.twoPhaseEnergy(m, T, x);
  }

  /** Fill the circuit with non-condensable gas at `pBar` absolute. */
  private fillWithGas(pBar: number): void {
    const Tk = this.outdoorC + 273.15;
    this.ncHi = (pBar * 100 * V_HI) / (R.R_AIR * Tk);
    this.ncLo = (pBar * 100 * V_LO) / (R.R_AIR * Tk);
  }

  // --- Service actions ----------------------------------------------------

  /** Weigh refrigerant in from the cylinder into the low-side service port. */
  charge(grams: number): number {
    const kg = Math.min(grams / 1000, this.cylinderKg);
    if (kg <= 0) return 0;
    this.cylinderKg -= kg;
    this.mLo += kg;
    this.ULo += kg * R.uL(CYLINDER_T);
    this.decay = null;
    this.pumpedDown = false;
    return kg;
  }

  setVacuum(on: boolean): void {
    this.vacuumOn = on;
    if (on) {
      this.recoveryOn = false;
      this.n2Test = false;
      this.decay = null;
      this.pumpedDown = false;
    } else if (this.pumpedDown) {
      this.decay = { startMicrons: this.microns(), startTime: this.time };
    }
  }

  setRecovery(on: boolean): void {
    this.recoveryOn = on;
    if (on) this.vacuumOn = false;
  }

  /** Pressurise with oxygen-free nitrogen for a strength/tightness test. */
  pressureTest(): string | null {
    if (this.chargeKg > 0.02) return "Recover the refrigerant before pressure testing.";
    this.vacuumOn = false;
    this.decay = null;
    const s = this.snap;
    const addHi = Math.max(0, N2_TEST_P - s.hi.Ptotal);
    const addLo = Math.max(0, N2_TEST_P - s.lo.Ptotal);
    this.ncHi += (addHi * 100 * V_HI) / (R.R_AIR * (s.hi.T + 273.15));
    this.ncLo += (addLo * 100 * V_LO) / (R.R_AIR * (s.lo.T + 273.15));
    this.n2Test = true;
    return null;
  }

  /** Let the nitrogen out to atmosphere. */
  ventNitrogen(): void {
    const s = this.snap;
    const atmHi = (R.P_ATM * 100 * V_HI) / (R.R_AIR * (s.hi.T + 273.15));
    const atmLo = (R.P_ATM * 100 * V_LO) / (R.R_AIR * (s.lo.T + 273.15));
    this.ncHi = Math.min(this.ncHi, atmHi);
    this.ncLo = Math.min(this.ncLo, atmLo);
    this.n2Test = false;
  }

  resetTrip(): void {
    this.trip = null;
    this.lpTimer = 0;
  }

  /** Absolute pressure in microns as read on a micron gauge on the low side. */
  microns(): number {
    return this.snap.lo.Ptotal * R.MICRONS_PER_BAR;
  }

  decayStatus(): { rise: number; minutes: number } | null {
    if (!this.decay) return null;
    return {
      rise: this.microns() - this.decay.startMicrons,
      minutes: (this.time - this.decay.startTime) / 60,
    };
  }

  // --- Simulation ---------------------------------------------------------

  /** Advance `seconds` of simulated time. */
  advance(seconds: number): void {
    const dt = 0.1;
    let left = seconds;
    while (left > 1e-9) {
      const h = Math.min(dt, left);
      this.step(h);
      left -= h;
    }
  }

  private side(m: number, U: number, V: number, guess: number, wallT: number): R.RefrigerantState {
    if (m < M_TINY) {
      const T = wallT;
      const P = m > 0 ? (R.R_R290 * (T + 273.15) * m) / V / 100 : 0;
      return { T, P, x: 1, phase: "vapour", liquidVolume: 0 };
    }
    return R.solveRefrigerant(m, U, V, guess);
  }

  step(dt: number): void {
    const Tout = this.outdoorC;
    const mdotW = this.pumpLpm / 60;
    const Cw = Math.max(0.02, mdotW * 4.186);
    const hiWall = mdotW > 0 ? this.tReturn : Tout;

    // --- Refrigerant states ---------------------------------------------
    const hiR = this.side(this.mHi, this.UHi, V_HI, this.tHiGuess, hiWall);
    const loR = this.side(this.mLo, this.ULo, V_LO, this.tLoGuess, Tout);
    this.tHiGuess = hiR.T;
    this.tLoGuess = loR.T;
    const pWv = (this.waterVapour * R.R_WATER * (Tout + 273.15)) / V_TOTAL / 100;
    const hiPnc = (this.ncHi * R.R_AIR * (hiR.T + 273.15)) / V_HI / 100;
    const loPnc = (this.ncLo * R.R_AIR * (loR.T + 273.15)) / V_LO / 100;
    const hi: SideSnapshot = { ...hiR, m: this.mHi, Pnc: hiPnc, Ptotal: hiR.P + hiPnc + pWv };
    const lo: SideSnapshot = { ...loR, m: this.mLo, Pnc: loPnc, Ptotal: loR.P + loPnc + pWv };

    // Where the liquid sits on the high side: film in the condenser, then
    // the liquid line, then pooling back up the condenser (subcooling).
    let psi = 0;
    let x3 = 0;
    if (hi.phase === "liquid") psi = 1;
    else if (hi.phase === "vapour") x3 = 1;
    else {
      const need = FILM * V_COND + V_LIQUID;
      if (hi.liquidVolume >= need) {
        psi = Math.min(0.97, (hi.liquidVolume - need) / ((1 - FILM) * V_COND));
      } else {
        x3 = Math.pow(1 - hi.liquidVolume / need, 1.5);
      }
    }
    const blanket = hi.phase === "twoPhase" ? clamp((1.5 * hiPnc) / Math.max(hi.Ptotal, 1e-6), 0, 0.7) : 0;

    // Low side: how much of the evaporator is wet, and whether liquid is
    // overflowing the accumulator towards the compressor.
    const wetCapacity = HOLDUP_EVAP * V_EVAP;
    let phi = 0;
    let xSuction = 1;
    if (lo.phase === "liquid") {
      phi = 1;
      xSuction = 0.7;
    } else if (lo.phase === "twoPhase") {
      phi = Math.min(1, lo.liquidVolume / wetCapacity);
      const pooled = Math.max(0, lo.liquidVolume - wetCapacity);
      if (pooled > 0.7 * V_ACC) xSuction = 1 - 0.3 * clamp((pooled - 0.7 * V_ACC) / (0.3 * V_ACC), 0, 1);
    }

    // --- Controls -------------------------------------------------------
    if (this.tRoom < this.roomSetpointC - 1) this.demand = true;
    else if (this.tRoom > this.roomSetpointC + 1) this.demand = false;
    const wantHeat = this.runMode === "service" || this.demand;
    const flowTarget = this.flowTarget();
    this.updateTrips(dt, hi, lo);

    // A stopped compressor won't start unless the low-pressure switch has
    // enough pressure to cut in — it can't start on an empty system.
    const canRun =
      this.source === "heatPump" &&
      wantHeat &&
      this.pumpLpm >= MIN_FLOW_LPM &&
      !this.trip &&
      !this.serviceIsolated &&
      (this.running || (this.offTimer >= MIN_OFF_TIME && lo.Ptotal > P_LP_CUT_IN));
    if (this.running && !canRun) this.stopCompressor();
    else if (!this.running && canRun) this.startCompressor();
    if (this.running) {
      this.runTimer += dt;
      this.controlCompressor(dt, flowTarget);
    } else {
      this.offTimer += dt;
      this.hz = 0;
    }

    const fanFrac = this.running ? this.fanPct / 100 : 0;
    const Cair = AIR_FLOW * 1.006 * Math.max(0.08, fanFrac);
    const UAe = UA_EVAP * (0.15 + 0.85 * Math.pow(fanFrac, 0.6));

    // --- Compressor -----------------------------------------------------
    const Te = lo.T;
    let suctionRho = lo.phase === "vapour" ? this.mLo / V_LO : R.rhoV(Te) * ((Te + 273.15) / (Te + this.shActual + 273.15));
    if (xSuction < 1) suctionRho = 1 / (xSuction * R.vV(Te) + (1 - xSuction) * R.vL(Te));
    const pr = hi.Ptotal / Math.max(lo.Ptotal, 0.05);
    let mdotComp = 0;
    if (this.running && this.mLo > 0) {
      const etaV = Math.max(0, 0.97 - 0.05 * (Math.pow(pr, 1 / KAPPA) - 1));
      mdotComp = Math.min(suctionRho * DISPLACEMENT * this.hz * etaV, (0.3 * this.mLo) / dt);
    }

    // Evaporator: two-phase part soaks up heat at the evaporating
    // temperature; the dry tail superheats the vapour on its way out.
    let qEvap: number;
    let superheat = 0;
    if (lo.phase === "twoPhase" || lo.phase === "liquid") {
      const q2 = (1 - Math.exp((-UAe * phi) / Cair)) * Cair * (Tout - Te);
      if (mdotComp > 1e-6 && Tout > Te && phi < 1) {
        superheat = (Tout - Te) * (1 - Math.exp((-UAe * (1 - phi)) / (mdotComp * R.cpV(Te))));
      }
      qEvap = q2 + mdotComp * R.cpV(Te) * superheat;
    } else {
      qEvap = limitHeat((1 - Math.exp((-0.3 * UAe) / Cair)) * Cair * (Tout - lo.T), this.mLo, Tout - lo.T, dt);
      superheat = lo.T - R.tsat(Math.max(lo.P, 1e-3));
    }
    this.shActual = clamp(superheat, 0, 60);
    qEvap += limitHeat(0.01 * (Tout - lo.T), this.mLo, Tout - lo.T, dt);

    let h1: number;
    if (lo.phase === "vapour") h1 = R.hVapour(Math.max(lo.P, 1e-3), lo.T);
    else if (xSuction < 1) h1 = R.hL(Te) + xSuction * (R.hV(Te) - R.hL(Te));
    else h1 = R.hV(Te) + R.cpV(Te) * superheat;

    let elecComp = 0;
    let h2 = h1;
    if (mdotComp > 0) {
      const p1 = 100 * lo.Ptotal;
      const ws = (KAPPA / (KAPPA - 1)) * p1 * (1 / suctionRho) * (Math.pow(pr, (KAPPA - 1) / KAPPA) - 1) * xSuction;
      const etaIs = clamp(0.75 - 0.008 * (pr - 3.2) ** 2, 0.45, 0.75) * MOTOR_EFF;
      elecComp = (mdotComp * ws) / etaIs;
      h2 = h1 + elecComp / mdotComp; // hermetic: motor heat ends up in the gas too
    }
    const Tc = hi.T;
    const tDischarge = hi.phase === "twoPhase" && h2 > R.hV(Tc) ? R.tVapour(hi.P, h2) : hi.T;

    // --- Expansion valve ------------------------------------------------
    const dP = hi.Ptotal - lo.Ptotal;
    let rhoIn: number;
    if (dP >= 0) {
      if (hi.phase === "liquid") rhoIn = R.rhoL(Tc);
      else if (hi.phase === "vapour") rhoIn = Math.max(1e-6, this.mHi / V_HI);
      else rhoIn = 1 / (x3 * R.vV(Tc) + (1 - x3) * R.vL(Tc));
    } else {
      rhoIn = lo.phase === "vapour" ? Math.max(1e-6, this.mLo / V_LO) : R.rhoV(Te);
    }
    const dPsmooth = (dP * 1e5) / Math.sqrt(Math.max(Math.abs(dP), 0.05) * 1e5);
    let mdotEev = K_EEV * this.eev * Math.sqrt(rhoIn) * dPsmooth;
    if (mdotEev > 0) mdotEev = Math.min(mdotEev, (0.3 * this.mHi) / dt);
    else mdotEev = Math.max(mdotEev, (-0.3 * this.mLo) / dt);

    let subcooling = 0;
    if (hi.phase === "twoPhase" && x3 === 0 && psi > 0 && mdotEev > 1e-6 && Tc > this.tReturn) {
      subcooling = (Tc - this.tReturn) * (1 - Math.exp((-UA_COND * psi) / (mdotEev * R.cpL(Tc))));
    }
    let h3: number;
    if (mdotEev < 0) h3 = lo.phase === "vapour" ? R.hVapour(Math.max(lo.P, 1e-3), lo.T) : R.hV(Te);
    else if (hi.phase === "vapour") h3 = R.hVapour(Math.max(hi.P, 1e-3), hi.T);
    else if (hi.phase === "liquid") h3 = R.hL(hi.T);
    else if (x3 > 0) h3 = R.hL(Tc) + x3 * (R.hV(Tc) - R.hL(Tc));
    else h3 = R.hL(Tc) - R.cpL(Tc) * subcooling;
    const x4 = clamp((h3 - R.hL(Te)) / (R.hV(Te) - R.hL(Te)), 0, 1);

    // --- Condenser ------------------------------------------------------
    let qCond: number;
    if (hi.phase === "twoPhase") {
      const area = Math.max(0.03, 1 - psi - blanket);
      qCond = (1 - Math.exp((-UA_COND * area) / Cw)) * Cw * (Tc - this.tReturn);
      qCond += Math.max(0, mdotEev) * R.cpL(Tc) * subcooling;
    } else {
      const ua = hi.phase === "liquid" ? 0.5 * UA_COND : 0.3 * UA_COND;
      qCond = limitHeat((1 - Math.exp(-ua / Cw)) * Cw * (hi.T - this.tReturn), this.mHi, hi.T - this.tReturn, dt);
    }
    const qCasing = limitHeat(0.003 * (hi.T - Tout), this.mHi, hi.T - Tout, dt);

    // --- Refrigerant balances -------------------------------------------
    this.mHi += (mdotComp - mdotEev) * dt;
    this.UHi += (mdotComp * h2 - mdotEev * h3 - qCond - qCasing) * dt;
    this.mLo += (mdotEev - mdotComp) * dt;
    this.ULo += (mdotEev * h3 - mdotComp * h1 + qEvap) * dt;

    this.migrateNonCondensables(dt, hi, lo);
    this.serviceFlows(dt, hi, lo, x3);
    this.settleTinySides(hiWall, Tout);

    // --- Sensors ----------------------------------------------------------
    const tSuction = lo.phase === "vapour" ? lo.T : xSuction < 1 ? Te : Te + superheat;
    const tLiquid = hi.phase === "twoPhase" ? Tc - subcooling : hi.T;
    const lag = Math.min(1, dt / 4);
    this.tSuctionMeas += (tSuction - this.tSuctionMeas) * lag;
    this.tLiquidMeas += (tLiquid - this.tLiquidMeas) * lag;
    if (this.running) this.controlValve(dt, lo.Ptotal);
    else this.eev += (EEV_PARK - this.eev) * Math.min(1, dt / 5);
    if (this.serviceIsolated) this.eev = 1;

    // --- Water loop, radiators, house -----------------------------------
    let qBoiler = 0;
    let gasIn = 0;
    if (this.source === "boiler") {
      const want = wantHeat ? clamp(Cw * (flowTarget - this.tReturn), 0, BOILER_MAX) : 0;
      this.qBoilerSmoothed += (want - this.qBoilerSmoothed) * Math.min(1, dt / 20);
      qBoiler = this.qBoilerSmoothed;
      gasIn = qBoiler / boilerEfficiency(this.tReturn);
    } else {
      this.qBoilerSmoothed = 0;
    }
    const qToWater = this.source === "boiler" ? qBoiler : qCond;
    const prevFlow = this.tFlow;
    if (mdotW > 0) {
      const tHxOut = this.tReturn + qToWater / Cw;
      this.tFlow += (dt * mdotW * (tHxOut - this.tFlow)) / M_FLOW_PIPES;
    }
    this.dFlowSmoothed += ((this.tFlow - prevFlow) / dt - this.dFlowSmoothed) * Math.min(1, dt / 10);
    const tMean = this.tReturn + 0.5 * (this.tFlow - this.tReturn) * Math.min(1, mdotW / 0.05);
    const dRad = tMean - this.tRoom;
    const qRad = this.radiatorQ50 * Math.sign(dRad) * Math.pow(Math.abs(dRad) / 50, RAD_EXPONENT);
    const mRad = 10 + 5 * this.radiatorQ50;
    this.tReturn += (dt * (mdotW * 4.186 * (this.tFlow - this.tReturn) - qRad)) / (mRad * 4.186);
    const qLoss = (this.heatLossDesignKW / (this.roomSetpointC - DESIGN_OUTDOOR)) * (this.tRoom - Tout);
    this.tRoom += (dt * (qRad + INTERNAL_GAINS - qLoss)) / C_HOUSE;

    // --- Energy accounts ------------------------------------------------
    const elecTotal = elecComp + FAN_POWER * fanFrac ** 3 + (mdotW > 0 ? PUMP_POWER : 0);
    this.elecKWh += (elecTotal * dt) / 3600;
    this.heatKWh += (Math.max(0, qToWater) * dt) / 3600;
    this.outsideKWh += (this.running ? Math.max(0, qEvap) : 0) * (dt / 3600);
    this.gasKWh += (gasIn * dt) / 3600;
    this.time += dt;

    this.snap = {
      hi,
      lo,
      psi,
      x3,
      phi,
      blanket,
      xSuction,
      superheat,
      subcooling,
      mdotComp,
      mdotEev,
      h1,
      h2,
      h3,
      x4,
      tDischarge,
      tSuction,
      tLiquid,
      qEvap: this.running ? qEvap : 0,
      qCond,
      qRad,
      qLoss,
      qBoiler,
      gasIn,
      elecComp,
      elecTotal,
      cop: elecComp > 0.05 ? Math.max(0, qCond) / elecTotal : 0,
      flowTarget,
      airOut: Tout - (this.running ? qEvap / Cair : 0),
      mdotWater: mdotW,
    };
  }

  private startCompressor(): void {
    this.running = true;
    this.runTimer = 0;
    this.hz = HZ_MIN + 10;
    this.hzI = this.hz;
    this.eevI = 0.35;
    this.eev = 0.35;
  }

  private stopCompressor(): void {
    this.running = false;
    this.offTimer = 0;
    this.hz = 0;
  }

  private controlCompressor(dt: number, flowTarget: number): void {
    // PI on flow temperature, with the measurement projected a minute ahead
    // so the slow water loop doesn't make it overshoot. Soft-start ramp.
    const err = flowTarget - (this.tFlow + 60 * this.dFlowSmoothed);
    this.hzI = clamp(this.hzI + dt * 0.05 * err, HZ_MIN, HZ_MAX);
    const want = clamp(this.hzI + 4 * err, HZ_MIN, HZ_MAX);
    const rate = 1.5 * dt;
    this.hz = clamp(want, this.hz - rate, this.hz + rate);
  }

  private controlValve(dt: number, pLow: number): void {
    // PI on measured superheat, like an electronic expansion valve driver.
    const sh = this.tSuctionMeas - R.tsat(Math.max(pLow, 1e-3));
    const err = sh - SH_TARGET;
    this.eevI = clamp(this.eevI + dt * 0.002 * err, 0.05, 1);
    this.eev = clamp(this.eevI + 0.02 * err, 0.05, 1);
  }

  private updateTrips(dt: number, hi: SideSnapshot, lo: SideSnapshot): void {
    if (this.trip) {
      this.trip.timer -= dt;
      const pressuresOk = hi.Ptotal < P_HP_TRIP - 5 && lo.Ptotal > P_LP_TRIP + 0.5;
      if (this.trip.timer <= 0 && pressuresOk) this.trip = null;
      return;
    }
    if (!this.running) {
      this.lpTimer = 0;
      return;
    }
    const tripWith = (reason: string) => {
      this.trip = { reason, timer: TRIP_RESET };
      this.stopCompressor();
    };
    if (hi.Ptotal > P_HP_TRIP) return tripWith("High-pressure switch tripped");
    if (this.snap && this.snap.tDischarge > T_DISCHARGE_TRIP) return tripWith("Discharge temperature too high");
    if (lo.Ptotal < P_LP_TRIP) {
      this.lpTimer += dt;
      if (this.lpTimer > LP_DELAY) tripWith("Low-pressure switch tripped");
    } else {
      this.lpTimer = 0;
    }
  }

  private migrateNonCondensables(dt: number, hi: SideSnapshot, lo: SideSnapshot): void {
    // Air gets swept round with the refrigerant and ends up trapped at the
    // top of the condenser; at standstill (or with the manifold hoses
    // joining both sides) it spreads back out evenly.
    const total = this.ncHi + this.ncLo;
    // At standstill it settles to equal pressure on both sides.
    const hiShare = V_HI / (hi.T + 273.15);
    const loShare = V_LO / (lo.T + 273.15);
    const target = this.running ? 0.95 * total : (total * hiShare) / (hiShare + loShare);
    const tau = this.serviceIsolated ? 5 : this.running ? 40 : 120;
    this.ncHi += (target - this.ncHi) * Math.min(1, dt / tau);
    this.ncLo = total - this.ncHi;
  }

  private serviceFlows(dt: number, hi: SideSnapshot, lo: SideSnapshot, x3: number): void {
    const Tk = this.outdoorC + 273.15;

    // Moisture boils off whenever its vapour pressure beats what's there.
    const pv = R.pWater(this.outdoorC);
    const pWv = (this.waterVapour * R.R_WATER * Tk) / V_TOTAL / 100;
    if (this.waterLiquid > 0 && pWv < pv) {
      const evap = Math.min(this.waterLiquid, MOISTURE_RATE * (pv - pWv) * dt);
      this.waterLiquid -= evap;
      this.waterVapour += evap;
    } else if (pWv > pv) {
      const excess = ((pWv - pv) * 100 * V_TOTAL) / (R.R_WATER * Tk);
      this.waterVapour -= excess;
      this.waterLiquid += excess;
    }

    // Dissolved air bubbles out of the oil once the system is under vacuum.
    if (this.oilGas > 0 && lo.Ptotal < 0.2) {
      const out = (this.oilGas * dt) / OIL_GAS_TAU;
      this.oilGas -= out;
      this.ncLo += out;
    }

    const removeGas = (which: "hi" | "lo", speed: number, s: SideSnapshot, floor: number, knee = 0): number => {
      const V = which === "hi" ? V_HI : V_LO;
      const P = Math.max(s.Ptotal, 1e-9);
      const S = ((speed * (V / V_TOTAL)) / (1 + knee / P)) * Math.max(0, 1 - floor / P);
      if (S <= 0) return 0;
      const m = which === "hi" ? this.mHi : this.mLo;
      const rhoRef = s.phase === "vapour" ? m / V : R.rhoV(s.T);
      const dm = Math.min(m, S * rhoRef * dt);
      const h = s.phase === "vapour" ? R.hVapour(Math.max(s.P, 1e-3), s.T) : R.hV(s.T);
      if (which === "hi") {
        this.mHi -= dm;
        this.UHi -= dm * h;
        this.ncHi -= Math.min(this.ncHi, (S * this.ncHi * dt) / V);
      } else {
        this.mLo -= dm;
        this.ULo -= dm * h;
        this.ncLo -= Math.min(this.ncLo, (S * this.ncLo * dt) / V);
      }
      this.waterVapour -= Math.min(this.waterVapour, (S * this.waterVapour * dt) / V_TOTAL);
      return dm;
    };

    if (this.vacuumOn) {
      const vented =
        removeGas("hi", VACUUM_SPEED, hi, VACUUM_ULTIMATE, VACUUM_KNEE) +
        removeGas("lo", VACUUM_SPEED, lo, VACUUM_ULTIMATE, VACUUM_KNEE);
      this.ventedKg += vented;
      if (this.microns() < 500 && this.chargeKg < 0.001) this.pumpedDown = true;
    }

    if (this.recoveryOn) {
      let got = removeGas("hi", RECOVERY_SPEED, hi, RECOVERY_FLOOR) + removeGas("lo", RECOVERY_SPEED, lo, RECOVERY_FLOOR);
      // Push-pull: liquid sitting on the high side is drawn off directly.
      if (hi.phase === "twoPhase" && hi.liquidVolume > 0 && hi.Ptotal > RECOVERY_FLOOR) {
        const dm = Math.min(this.mHi, RECOVERY_LIQUID * dt);
        this.mHi -= dm;
        this.UHi -= dm * R.hL(hi.T);
        got += dm;
      }
      this.recoveredKg += got;
    }

    if (this.leakOn) {
      const dP = hi.Ptotal - R.P_ATM;
      if (dP > 0) {
        if (hi.phase === "twoPhase" && x3 === 0) {
          const dm = Math.min(this.mHi, K_LEAK * Math.sqrt(R.rhoL(hi.T) * dP * 1e5) * dt);
          this.mHi -= dm;
          this.UHi -= dm * R.hL(hi.T);
          this.leakedKg += dm;
        } else {
          const rhoRef = hi.phase === "vapour" ? this.mHi / V_HI : R.rhoV(hi.T);
          const rhoNc = this.ncHi / V_HI;
          const rhoWv = this.waterVapour / V_TOTAL;
          const rho = rhoRef + rhoNc + rhoWv;
          const out = K_LEAK * Math.sqrt(rho * dP * 1e5) * dt;
          if (rho > 0) {
            const dm = Math.min(this.mHi, (out * rhoRef) / rho);
            const h = hi.phase === "vapour" ? R.hVapour(Math.max(hi.P, 1e-3), hi.T) : R.hV(hi.T);
            this.mHi -= dm;
            this.UHi -= dm * h;
            this.leakedKg += dm;
            this.ncHi -= Math.min(this.ncHi, (out * rhoNc) / rho);
            this.waterVapour -= Math.min(this.waterVapour, (out * rhoWv) / rho);
          }
        }
      } else {
        const air = K_LEAK * Math.sqrt(1.2 * -dP * 1e5) * dt;
        this.ncHi += air;
        this.waterLiquid += air * HUMIDITY;
      }
    }
  }

  private settleTinySides(hiWall: number, loWall: number): void {
    // Too little refrigerant to hold its own temperature: it just sits at
    // the temperature of the pipework around it.
    if (this.mHi < M_TINY) {
      this.mHi = Math.max(0, this.mHi);
      this.UHi = this.mHi > 0 ? R.vapourEnergy(this.mHi, V_HI, hiWall) : 0;
    }
    if (this.mLo < M_TINY) {
      this.mLo = Math.max(0, this.mLo);
      this.ULo = this.mLo > 0 ? R.vapourEnergy(this.mLo, V_LO, loWall) : 0;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Cap a heat flow into/out of a vapour-only volume so one step can't overshoot. */
function limitHeat(q: number, m: number, dT: number, dt: number): number {
  const cap = (0.8 * Math.max(m, 1e-6) * 1.7 * Math.abs(dT)) / dt;
  return Math.sign(q) * Math.min(Math.abs(q), cap);
}

function boilerEfficiency(tReturn: number): number {
  // Condensing boilers only condense the flue gas when the return water is
  // below ~55 °C; above that they drop to non-condensing efficiency.
  return tReturn < 55 ? 0.97 - 0.004 * Math.max(0, tReturn - 30) : 0.87;
}
