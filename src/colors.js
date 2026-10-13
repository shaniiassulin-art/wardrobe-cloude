// Groups any hex colour into a family people filter by ("green" covers olive,
// mint, emerald...). Order matters: neutrals are decided before hues.
export const COLOR_FAMILIES = [
  { id: "black", label: "שחור", swatch: "#1d1d1d" },
  { id: "white", label: "לבן", swatch: "#f7f5f0" },
  { id: "gray", label: "אפור", swatch: "#9a9a9a" },
  { id: "beige", label: "בז׳", swatch: "#d9c4a3" },
  { id: "brown", label: "חום", swatch: "#7a5235" },
  { id: "red", label: "אדום", swatch: "#c0392b" },
  { id: "pink", label: "ורוד", swatch: "#e48aa6" },
  { id: "orange", label: "כתום", swatch: "#e67e22" },
  { id: "yellow", label: "צהוב", swatch: "#f1c40f" },
  { id: "green", label: "ירוק", swatch: "#3e8e41" },
  { id: "turquoise", label: "טורקיז", swatch: "#1abc9c" },
  { id: "blue", label: "כחול", swatch: "#2f5d9c" },
  { id: "purple", label: "סגול", swatch: "#8e44ad" },
];

function toHsl(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export function colorFamily(hex) {
  const hsl = toHsl(hex);
  if (!hsl) return null;
  const { h, s, l } = hsl;
  if (l < 0.14) return "black";
  if (l > 0.9 && s < 0.35) return "white";
  if (s < 0.12) return l > 0.8 ? "white" : "gray";
  // Very light warm tones read as beige (cream, ecru); dull dark reds read as brown
  if (h >= 38 && h < 70 && l > 0.85) return "beige";
  if ((h < 18 || h >= 345) && l < 0.3 && s < 0.5) return "brown";
  if (h >= 18 && h < 50) {
    if (l < 0.42) return "brown";
    if (s < 0.55 && l > 0.55) return "beige";
    return h < 38 ? "orange" : "yellow";
  }
  if (h < 12 || h >= 345) return l > 0.72 ? "pink" : "red";
  if (h < 18) return l < 0.35 ? "brown" : "orange";
  if (h < 68) return l < 0.35 ? "green" : "yellow"; // dark yellow is olive
  if (h < 160) return "green";
  if (h < 195) return "turquoise";
  if (h < 255) return l > 0.88 && h >= 225 ? "purple" : "blue"; // lavender
  if (h < 290) return "purple";
  return "pink";
}

// Families an item belongs to (primary and secondary colour)
export function itemColorFamilies(item) {
  return [...new Set([colorFamily(item.color), colorFamily(item.secondaryColor)].filter(Boolean))];
}
