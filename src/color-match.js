// Perceptual colour distance (CIE Lab, ΔE76), so "close to my shirt" means what the eye sees
export function hexToLab(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!match) return null;
  const n = parseInt(match[1], 16);
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export const deltaE = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
// A wardrobe colour counts as "this colour of the combination" within this distance
export const CLOSE = 22;

// How close a wardrobe piece is to a colour (its main or second colour)
export const itemDistance = (item, lab) => Math.min(deltaE(hexToLab(item.color), lab), deltaE(hexToLab(item.secondaryColor), lab));
