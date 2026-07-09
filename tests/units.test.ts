import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANCHORS,
  celsiusToFahrenheit,
  celsiusToStar,
  formatTemperature,
  starToCelsius,
  type UnitAnchors,
} from "../src/units";

describe("units mapping", () => {
  it("passes through both anchor points exactly", () => {
    const a = DEFAULT_ANCHORS;
    expect(starToCelsius(a.t1_star, a)).toBeCloseTo(a.t1_celsius, 6);
    expect(starToCelsius(a.t2_star, a)).toBeCloseTo(a.t2_celsius, 6);
    expect(celsiusToStar(a.t1_celsius, a)).toBeCloseTo(a.t1_star, 6);
    expect(celsiusToStar(a.t2_celsius, a)).toBeCloseTo(a.t2_star, 6);
  });
  it("is a self-inverse", () => {
    for (const t of [0.3, 0.5, 1.0, 1.6, 3.2]) {
      const c = starToCelsius(t);
      expect(celsiusToStar(c)).toBeCloseTo(t, 6);
    }
  });
  it("with custom anchors, midpoint interpolates linearly", () => {
    const a: UnitAnchors = { t1_star: 0, t1_celsius: 0, t2_star: 1, t2_celsius: 100 };
    expect(starToCelsius(0.5, a)).toBeCloseTo(50, 6);
    expect(starToCelsius(1.5, a)).toBeCloseTo(150, 6); // extrapolates
    expect(starToCelsius(-0.2, a)).toBeCloseTo(-20, 6);
  });
  it("Fahrenheit conversion", () => {
    expect(celsiusToFahrenheit(0)).toBeCloseTo(32, 6);
    expect(celsiusToFahrenheit(100)).toBeCloseTo(212, 6);
    expect(celsiusToFahrenheit(-40)).toBeCloseTo(-40, 6);
  });
  it("formatTemperature respects mode", () => {
    const s = formatTemperature(1.0, "C");
    expect(s).toMatch(/°C$/);
    expect(formatTemperature(1.0, "F")).toMatch(/°F$/);
    expect(formatTemperature(1.0, "star")).toMatch(/^T\*/);
  });
});
