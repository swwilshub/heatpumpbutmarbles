import { describe, expect, it } from "vitest";
import * as R from "../src/hp/r290";
import { HeatPumpModel, NAMEPLATE_CHARGE, SH_TARGET, type PresetId } from "../src/hp/model";

describe("R290 properties", () => {
  it("matches known saturation points", () => {
    expect(R.psat(0)).toBeCloseTo(4.745, 2);
    expect(R.psat(50)).toBeCloseTo(17.13, 1);
    expect(R.tsat(R.psat(-17.3))).toBeCloseTo(-17.3, 6);
  });

  it("round-trips a two-phase state through mass, energy and volume", () => {
    const V = 5e-3;
    for (const [T, x] of [[-20, 0.9], [0, 0.3], [40, 0.05]] as const) {
      const m = V / (R.vL(T) + x * (R.vV(T) - R.vL(T)));
      const s = R.solveRefrigerant(m, R.twoPhaseEnergy(m, T, x), V);
      expect(s.phase).toBe("twoPhase");
      expect(s.T).toBeCloseTo(T, 3);
      expect(s.x).toBeCloseTo(x, 4);
    }
  });

  it("sends pressure above saturation once a volume is packed with liquid", () => {
    const V = 1e-3;
    const m = 1.02 * V * R.rhoL(30);
    const s = R.solveRefrigerant(m, m * R.uL(30), V);
    expect(s.phase).toBe("liquid");
    expect(s.P).toBeGreaterThan(R.psat(s.T) + 1);
  });
});

function settled(preset: PresetId, hours = 0): HeatPumpModel {
  const hp = new HeatPumpModel();
  hp.loadPreset(preset);
  if (hours > 0) hp.advance(hours * 3600);
  return hp;
}

describe("heat pump cycle", () => {
  const normal = settled("normal", 1);

  it("runs a healthy cycle at nameplate charge", () => {
    const s = normal.snap;
    expect(normal.running).toBe(true);
    expect(normal.chargeKg).toBeCloseTo(NAMEPLATE_CHARGE, 6);
    expect(Math.abs(s.superheat - SH_TARGET)).toBeLessThan(1);
    expect(s.subcooling).toBeGreaterThan(3);
    expect(s.subcooling).toBeLessThan(9);
    expect(s.cop).toBeGreaterThan(3.2);
    expect(s.cop).toBeLessThan(4.5);
    expect(Math.abs(normal.tFlow - s.flowTarget)).toBeLessThan(1.5);
  });

  it("conserves energy: heat to water = heat from outside + compressor electricity", () => {
    const s = normal.snap;
    const casingLoss = 0.003 * (s.hi.T - normal.outdoorC);
    expect(s.qCond).toBeCloseTo(s.qEvap + s.elecComp - casingLoss, 1);
  });

  it("gets less efficient as the lift grows", () => {
    const cop = (outdoor: number, designFlow: number) => {
      const hp = new HeatPumpModel();
      hp.outdoorC = outdoor;
      hp.designFlowC = designFlow;
      hp.runMode = "service";
      hp.setCharge(NAMEPLATE_CHARGE);
      hp.warmUp(2400);
      return hp.snap.cop;
    };
    expect(cop(7, 35)).toBeGreaterThan(cop(2, 45));
    expect(cop(2, 45)).toBeGreaterThan(cop(-7, 55));
  });

  it("shows the undercharge signature: high superheat, no subcooling", () => {
    const s = settled("undercharged", 1).snap;
    expect(s.superheat).toBeGreaterThan(SH_TARGET + 3);
    expect(s.subcooling).toBeLessThan(0.5);
    expect(s.cop).toBeLessThan(normal.snap.cop - 0.5);
  });

  it("shows the overcharge signature: extra subcooling and head pressure", () => {
    const s = settled("overcharged", 1).snap;
    expect(s.subcooling).toBeGreaterThan(normal.snap.subcooling + 1.5);
    expect(s.hi.Ptotal).toBeGreaterThan(normal.snap.hi.Ptotal + 0.5);
  });

  it("shows air in the system as extra head pressure", () => {
    const hp = settled("air", 1);
    expect(hp.snap.hi.Pnc).toBeGreaterThan(1);
    expect(hp.snap.hi.Ptotal).toBeGreaterThan(normal.snap.hi.Ptotal + 1);
  });

  it("can't hold the room with boiler-sized radiators at heat pump temperatures", () => {
    const small = settled("smallRadiators", 3);
    expect(small.tRoom).toBeLessThan(19.5);
    expect(small.snap.flowTarget).toBeGreaterThan(normal.snap.flowTarget + 3);
  });

  it("holds the same room with the same small radiators on a 70 °C boiler", () => {
    const hp = settled("smallRadiators");
    hp.source = "boiler";
    hp.designFlowC = 70;
    hp.advance(3 * 3600);
    expect(hp.tRoom).toBeGreaterThan(20);
    expect(hp.snap.gasIn).toBeGreaterThanOrEqual(0);
  });
});

describe("service procedures", () => {
  it("won't start the compressor on a system full of air", () => {
    const hp = settled("newInstall");
    hp.advance(600);
    expect(hp.running).toBe(false);
    expect(hp.trip).toBeNull();
  });

  it("holds a nitrogen pressure test unless there's a leak", () => {
    const hp = settled("newInstall");
    expect(hp.pressureTest()).toBeNull();
    hp.advance(60);
    const start = hp.snap.lo.Ptotal;
    expect(start).toBeGreaterThan(20);
    hp.advance(1800);
    expect(hp.snap.lo.Ptotal).toBeCloseTo(start, 1);
    hp.leakOn = true;
    hp.advance(600);
    expect(hp.snap.lo.Ptotal).toBeLessThan(start - 0.3);
  });

  it("refuses to pressure test a system that still has refrigerant in it", () => {
    expect(settled("normal").pressureTest()).not.toBeNull();
  });

  it("stalls while moisture boils off, then pulls below 500 microns", () => {
    const hp = settled("newInstall");
    hp.setVacuum(true);
    hp.advance(600);
    expect(hp.microns()).toBeGreaterThan(1000);
    hp.advance(2.5 * 3600);
    expect(hp.microns()).toBeLessThan(500);
    expect(hp.waterLiquid).toBe(0);
  });

  it("passes a decay test when tight and fails it with a leak", () => {
    const tight = settled("newInstall");
    tight.setVacuum(true);
    tight.advance(3 * 3600);
    tight.setVacuum(false);
    tight.advance(600);
    expect(tight.decayStatus()!.rise).toBeLessThan(200);

    const leaky = settled("newInstall");
    leaky.setVacuum(true);
    leaky.advance(3 * 3600);
    leaky.setVacuum(false);
    leaky.leakOn = true;
    leaky.advance(600);
    expect(leaky.decayStatus()!.rise).toBeGreaterThan(5000);
  });

  it("recovers the charge into the recovery cylinder", () => {
    const hp = settled("normal");
    hp.setRecovery(true);
    hp.advance(1200);
    expect(hp.chargeKg).toBeLessThan(0.02);
    expect(hp.recoveredKg).toBeGreaterThan(NAMEPLATE_CHARGE - 0.02);
  });

  it("runs again after evacuating and weighing in the nameplate charge", () => {
    const hp = settled("newInstall");
    hp.setVacuum(true);
    hp.advance(3 * 3600);
    hp.setVacuum(false);
    hp.charge(NAMEPLATE_CHARGE * 1000);
    expect(hp.cylinderKg).toBeCloseTo(5 - NAMEPLATE_CHARGE, 6);
    hp.advance(1800);
    expect(hp.running).toBe(true);
    expect(Math.abs(hp.snap.superheat - SH_TARGET)).toBeLessThan(1.5);
  });
});
