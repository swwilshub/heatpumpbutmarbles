// Temperature colour ramp — anchored in *degrees Celsius*, not in normalised
// [0,1]. Deep blue below -30 °C, cool blue at 0 °C (freeze point sits at a
// distinct color), through purple / red at room temp, orange / yellow / white
// at typical condenser hot-side. This lets the user read the palette as an
// actual temperature scale rather than an abstract normalisation.

const STOPS: readonly { c: number; rgb: [number, number, number] }[] = [
  { c: -60, rgb: [10, 40, 120] }, // ice-cold
  { c: -30, rgb: [30, 90, 200] },
  { c: 0, rgb: [70, 130, 220] }, // freezing point — distinct cool blue
  { c: 20, rgb: [140, 100, 200] }, // room temp — soft purple
  { c: 40, rgb: [210, 80, 140] },
  { c: 60, rgb: [232, 90, 74] },
  { c: 90, rgb: [244, 152, 40] }, // hot condenser
  { c: 150, rgb: [252, 232, 128] }, // scorching
];

export function celsiusColor(c: number): string {
  // Find surrounding stops. Clamp to endpoints.
  const first = STOPS[0]!;
  const last = STOPS[STOPS.length - 1]!;
  if (c <= first.c) return rgb(first.rgb);
  if (c >= last.c) return rgb(last.rgb);
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i]!;
    const b = STOPS[i + 1]!;
    if (c >= a.c && c <= b.c) {
      const f = (c - a.c) / (b.c - a.c);
      const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f);
      const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f);
      const bl = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f);
      return `rgb(${r},${g},${bl})`;
    }
  }
  return rgb(last.rgb);
}

function rgb(v: [number, number, number]): string {
  return `rgb(${v[0]},${v[1]},${v[2]})`;
}

// Palette range for the legend and colour bar. Renderer picks the wider of
// [scenario min..max] and [defaultMin..defaultMax] so the legend fits the
// scene without clipping.
export const DEFAULT_LEGEND_C_MIN = -50;
export const DEFAULT_LEGEND_C_MAX = 120;

export function paletteSamplesCelsius(n: number, cMin: number, cMax: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = cMin + (i / (n - 1)) * (cMax - cMin);
    out.push(celsiusColor(c));
  }
  return out;
}
