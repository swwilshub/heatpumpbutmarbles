// Side-panel definition for the heat pump diagram: presets, controls,
// service tools and readouts, all driving one HeatPumpModel.

import { R, type Readout, type ScenarioAction, type ScenarioSlider } from "../scenarios";
import * as P from "./r290";
import { HeatPumpDiagram, formatDelta, type TempFormatter } from "./diagram";
import { HeatPumpModel, NAMEPLATE_CHARGE, type PresetId } from "./model";

export interface DiagramSeries {
  name: string;
  colour: string;
  /** Temperature in °C. */
  value: () => number;
}

export interface HeatPumpView {
  model: HeatPumpModel;
  diagram: HeatPumpDiagram;
  readouts: Readout[];
  sliders: ScenarioSlider[];
  actions: ScenarioAction[];
  series: DiagramSeries[];
  explainer: string;
}

const BOILER_FLOW = 70;
const HEAT_PUMP_FLOW = 45;

export function buildHeatPumpView(fmt: TempFormatter): HeatPumpView {
  const hp = new HeatPumpModel();
  const diagram = new HeatPumpDiagram();
  const kw = (v: number) => `${v.toFixed(1)} kW`;
  const bar = (pAbs: number) => `${(pAbs - P.P_ATM).toFixed(1)} bar`;
  const settled = () => hp.running && hp.runTimer > 60;
  // Gauge pressure plus the temperature R290 boils at, as a manifold's
  // temperature scale shows it.
  const gauge = (pAbs: number) => {
    if (hp.source === "boiler") return "—";
    return pAbs > 0.72 ? `${bar(pAbs)} · ${fmt(P.tsat(pAbs))}` : bar(pAbs);
  };

  const preset = (id: PresetId, label: string): ScenarioAction => ({
    id: `preset_${id}`,
    label,
    group: "Start from",
    onClick: () => hp.loadPreset(id),
  });

  const actions: ScenarioAction[] = [
    preset("normal", "Healthy system"),
    preset("smallRadiators", "Boiler-sized radiators"),
    preset("undercharged", "Undercharged (leaked)"),
    preset("overcharged", "Overcharged"),
    preset("air", "Air in the system"),
    preset("newInstall", "New install: empty, full of air"),
    {
      id: "source",
      group: "Heat source",
      label: () => (hp.source === "heatPump" ? "Swap to a gas boiler" : "Swap back to the heat pump"),
      onClick: () => {
        const toBoiler = hp.source === "heatPump";
        hp.source = toBoiler ? "boiler" : "heatPump";
        hp.designFlowC = toBoiler ? BOILER_FLOW : HEAT_PUMP_FLOW;
      },
    },
    {
      id: "runMode",
      group: "Service tools",
      label: () => (hp.runMode === "service" ? "Service run: ON" : "Service run (ignore thermostat)"),
      active: () => hp.runMode === "service",
      onClick: () => {
        hp.runMode = hp.runMode === "service" ? "thermostat" : "service";
      },
    },
    {
      id: "charge50",
      group: "Service tools",
      label: "Weigh in +50 g",
      onClick: () => hp.charge(50),
    },
    {
      id: "chargeNameplate",
      group: "Service tools",
      label: () => `Weigh in to ${(NAMEPLATE_CHARGE * 1000).toFixed(0)} g`,
      onClick: () => hp.charge(Math.max(0, NAMEPLATE_CHARGE * 1000 - hp.chargeKg * 1000)),
    },
    {
      id: "recover",
      group: "Service tools",
      label: () => (hp.recoveryOn ? "Recovery machine: ON" : "Recover refrigerant"),
      active: () => hp.recoveryOn,
      onClick: () => hp.setRecovery(!hp.recoveryOn),
    },
    {
      id: "vacuum",
      group: "Service tools",
      label: () => (hp.vacuumOn ? "Vacuum pump: ON (click to isolate)" : "Vacuum pump"),
      active: () => hp.vacuumOn,
      onClick: () => hp.setVacuum(!hp.vacuumOn),
    },
    {
      id: "nitrogen",
      group: "Service tools",
      label: () => (hp.n2Test ? "Vent the nitrogen" : hp.chargeKg > 0.02 ? "Nitrogen test (recover first)" : "Nitrogen pressure test"),
      active: () => hp.n2Test,
      onClick: () => {
        if (hp.n2Test) hp.ventNitrogen();
        else hp.pressureTest();
      },
    },
    {
      id: "leak",
      group: "Faults",
      label: () => (hp.leakOn ? "Leak on the liquid line: ON" : "Make a leak"),
      active: () => hp.leakOn,
      onClick: () => {
        hp.leakOn = !hp.leakOn;
      },
    },
    {
      id: "resetTrip",
      group: "Faults",
      label: "Reset lockout",
      onClick: () => hp.resetTrip(),
    },
  ];

  const sliders: ScenarioSlider[] = [
    {
      id: "outdoor",
      group: "Weather & house",
      label: "outdoor temperature",
      min: -20, max: 20, step: 1, initial: hp.outdoorC,
      format: (v) => fmt(v, 0),
      onChange: (v) => { hp.outdoorC = v; },
      value: () => hp.outdoorC,
    },
    {
      id: "heatLoss",
      group: "Weather & house",
      label: "house heat loss (at -3 °C outside)",
      min: 2, max: 12, step: 0.5, initial: hp.heatLossDesignKW,
      format: (v) => `${v.toFixed(1)} kW`,
      onChange: (v) => { hp.heatLossDesignKW = v; },
      value: () => hp.heatLossDesignKW,
    },
    {
      id: "setpoint",
      group: "Weather & house",
      label: "room thermostat",
      min: 16, max: 24, step: 0.5, initial: hp.roomSetpointC,
      format: (v) => fmt(v, 1),
      onChange: (v) => { hp.roomSetpointC = v; },
      value: () => hp.roomSetpointC,
    },
    {
      id: "radiators",
      group: "Heating system",
      label: "radiator size (rated output at ΔT50)",
      min: 4, max: 30, step: 0.5, initial: hp.radiatorQ50,
      format: (v) => `${v.toFixed(1)} kW`,
      onChange: (v) => { hp.radiatorQ50 = v; },
      value: () => hp.radiatorQ50,
    },
    {
      id: "pump",
      group: "Heating system",
      label: "water flow rate",
      min: 0, max: 40, step: 1, initial: hp.pumpLpm,
      format: (v) => `${v.toFixed(0)} L/min`,
      onChange: (v) => { hp.pumpLpm = v; },
      value: () => hp.pumpLpm,
    },
    {
      id: "flowTemp",
      group: "Heating system",
      label: "flow temperature (heat pump: at -3 °C outside)",
      min: 30, max: 75, step: 1, initial: hp.designFlowC,
      format: (v) => fmt(v, 0),
      onChange: (v) => { hp.designFlowC = v; },
      value: () => hp.designFlowC,
    },
    {
      id: "fan",
      group: "Heating system",
      label: "outdoor fan speed",
      min: 10, max: 100, step: 5, initial: hp.fanPct,
      format: (v) => `${v.toFixed(0)}%`,
      onChange: (v) => { hp.fanPct = v; },
      value: () => hp.fanPct,
    },
  ];

  const s = () => hp.snap;
  const readouts: Readout[] = [
    { group: "Energy", label: "heat into the water", v: R(() => kw(Math.max(0, hp.source === "boiler" ? s().qBoiler : s().qCond))) },
    { group: "Energy", label: "electricity (or gas) used", v: R(() => (hp.source === "boiler" ? kw(s().gasIn) : kw(s().elecTotal))) },
    { group: "Energy", label: "heat taken from outside air", v: R(() => (hp.source === "boiler" ? "—" : kw(hp.running ? Math.max(0, s().qEvap) : 0))) },
    {
      group: "Energy",
      label: "average efficiency since start",
      v: R(() => {
        if (hp.source === "boiler") return hp.gasKWh > 0.01 ? `${((100 * hp.heatKWh) / hp.gasKWh).toFixed(0)}%` : "—";
        return hp.elecKWh > 0.01 && hp.heatKWh > 0.01 ? `COP ${(hp.heatKWh / hp.elecKWh).toFixed(2)}` : "—";
      }),
    },
    { group: "Refrigerant", label: "compressor", v: R(() => (hp.source === "boiler" ? "—" : hp.running ? `${hp.hz.toFixed(0)} Hz` : hp.trip ? "locked out" : "off")) },
    { group: "Refrigerant", label: "low side (evaporating)", v: R(() => gauge(s().lo.Ptotal)) },
    { group: "Refrigerant", label: "high side (condensing)", v: R(() => gauge(s().hi.Ptotal)) },
    { group: "Refrigerant", label: "discharge temperature", v: R(() => (hp.running ? fmt(s().tDischarge) : "—")) },
    { group: "Refrigerant", label: "superheat", v: R(() => (settled() ? formatDelta(fmt, hp.tSuctionMeas - P.tsat(Math.max(s().lo.Ptotal, 1e-3))) : "—")) },
    { group: "Refrigerant", label: "subcooling", v: R(() => (settled() ? formatDelta(fmt, P.tsat(Math.max(s().hi.Ptotal, 1e-3)) - hp.tLiquidMeas) : "—")) },
    { group: "Refrigerant", label: "charge", v: R(() => `${(hp.chargeKg * 1000).toFixed(0)} g (nameplate ${(NAMEPLATE_CHARGE * 1000).toFixed(0)} g)`) },
    { group: "Refrigerant", label: "air / nitrogen inside", v: R(() => (hp.ncHi + hp.ncLo < 1e-5 ? "none" : `${((hp.ncHi + hp.ncLo) * 1000).toFixed(1)} g`)) },
    { group: "Heating water", label: "flow / return", v: R(() => `${fmt(hp.tFlow)} / ${fmt(hp.tReturn)}`) },
    { group: "Heating water", label: "flow temperature asked for", v: R(() => fmt(s().flowTarget)) },
    { group: "Heating water", label: "radiators giving out", v: R(() => kw(Math.max(0, s().qRad))) },
    { group: "Heating water", label: "house losing", v: R(() => kw(Math.max(0, s().qLoss))) },
    { group: "Service", label: "micron gauge", v: R(() => { const m = hp.microns(); return m > 25000 ? "OL" : `${Math.round(m).toLocaleString("en-GB")} microns`; }) },
    { group: "Service", label: "R290 bottle on the scale", v: R(() => `${hp.cylinderKg.toFixed(3)} kg`) },
    { group: "Service", label: "recovered / leaked / vented", v: R(() => `${g(hp.recoveredKg)} / ${g(hp.leakedKg)} / ${g(hp.ventedKg)}`) },
  ];

  const series: DiagramSeries[] = [
    { name: "room", colour: "#f2c94c", value: () => hp.tRoom },
    { name: "flow", colour: "#e07a5f", value: () => hp.tFlow },
    { name: "return", colour: "#b07ad8", value: () => hp.tReturn },
    { name: "evaporating", colour: "#5f9fd8", value: () => hp.snap.lo.T },
    { name: "outside", colour: "#8b93a1", value: () => hp.outdoorC },
  ];

  return { model: hp, diagram, readouts, sliders, actions, series, explainer: EXPLAINER };
}

function g(kg: number): string {
  return `${(kg * 1000).toFixed(0)} g`;
}

const EXPLAINER = `
<b>How it works.</b> The refrigerant (propane) goes round and round, and the trick is pressure:
<b>①</b> in the outdoor coil it's kept at low pressure, where it boils at well below the outdoor
temperature, so even cold air warms it up and it soaks up heat. <b>②</b> The compressor squeezes
that vapour, which makes it hot. <b>③</b> In the condenser the hot vapour gives its heat to the
radiator water and turns back to liquid. <b>④</b> The expansion valve drops the pressure again
and the liquid flashes ice cold, ready to go round again. Most of the heat comes from outside;
the electricity only moves it — that's why the COP is 3 or 4.
<br><br>
<b>Try:</b>
<ul style="margin:4px 0 0 16px;padding:0">
<li><b>Boiler-sized radiators</b>: the room slowly drifts cold and the controls push the flow
temperature (and your bills) up. Drag the radiator size up — or swap to the gas boiler to see why
70 °C water got away with small radiators.</li>
<li>Turn the <b>water flow rate</b> down and watch the return temperature fall and the radiators lose output.</li>
<li>Drop the <b>outdoor temperature</b> to -15 °C: the evaporating temperature follows it down and the COP falls.</li>
<li><b>Faults</b>: load "undercharged", "overcharged" or "air in the system" and read the superheat,
subcooling and head pressure like a technician.</li>
<li><b>New install</b>: nitrogen pressure test → vent → vacuum (watch the gauge stall while moisture boils
off) → click the pump again to isolate it for a decay test → weigh in the charge → it starts.</li>
</ul>
<div style="margin-top:6px;color:#8b93a1">Speed up time with the slider at the top: the house takes hours to warm up.</div>
`;
