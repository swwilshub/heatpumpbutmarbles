// Temperature colour ramp — cool blue → magenta → red → orange → white-yellow.
// Deliberately starts at a saturated blue (not black) so cold atoms stay
// visible against the dark canvas background. Values outside [0,1] clamp.

const STOPS: readonly [number, number, number][] = [
  [32, 78, 180], // cold — deep blue
  [90, 84, 210], // cool — indigo
  [176, 66, 178], // mid — magenta
  [222, 68, 96], // warm — coral red
  [244, 152, 40], // hot — orange
  [252, 232, 128], // very hot — pale yellow
];

export function speedColor(t: number): string {
  const c = clamp01(t);
  const seg = c * (STOPS.length - 1);
  const i = Math.min(Math.floor(seg), STOPS.length - 2);
  const f = seg - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

// For drawing the colour bar: sample the palette at N evenly-spaced points
// so the renderer doesn't have to know about STOPS.
export function paletteSamples(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(speedColor(i / (n - 1)));
  }
  return out;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
