// Speed/energy → RGB. Perceptually monotonic, dark→bright. Used for colouring
// atoms by their instantaneous kinetic energy so hot regions read as hot to
// the eye. Values outside [0,1] are clamped.
//
// Palette: near-black → indigo → magenta → orange → white-yellow.
// Not viridis (viridis is optimised for print, and washes out on OLED backgrounds).
const STOPS: readonly [number, number, number][] = [
  [11, 13, 18],
  [36, 25, 88],
  [122, 44, 130],
  [222, 87, 96],
  [252, 187, 68],
  [252, 246, 213],
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

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
