import { useMemo, useState } from "react";
import { MagicWand, X } from "@phosphor-icons/react";
import { COLOR_FAMILIES, colorFamily } from "./colors.js";
import { WADA_COLORS, WADA_PALETTES } from "./data/wada.js";
import { fittedImage, imageFallback, thumbUrl } from "./image-files.js";

// Perceptual colour distance (CIE Lab, ΔE76), so "close to my shirt" means what the eye sees
function hexToLab(hex) {
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
const deltaE = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
// A wardrobe colour counts as "this colour of the combination" within this distance
const CLOSE = 22;

const COLORS = WADA_COLORS.map(([name, hex]) => ({ name, hex, lab: hexToLab(hex), family: colorFamily(hex) }));
const PALETTES = WADA_PALETTES.map(([number, indexes]) => ({ number, colors: indexes.map((i) => COLORS[i]) }));

// Every recommended combination from Sanzo Wada's "A Dictionary of Colour
// Combinations", filtered by a colour or by a piece from the wardrobe, with the
// wardrobe pieces that match each colour and a quick way to make a look of them
export function ColorCombos({ items, onCreateLook }) {
  const [family, setFamily] = useState(null);
  const [pieceId, setPieceId] = useState(null);
  const [size, setSize] = useState(0);
  const [onlyMine, setOnlyMine] = useState(false);
  const pieces = useMemo(() => items
    .map((item) => ({ item, lab: hexToLab(item.color), lab2: hexToLab(item.secondaryColor) }))
    .filter((entry) => entry.lab), [items]);
  const piece = pieces.find((entry) => entry.item.id === pieceId) || null;

  // For one colour of a combination: the wardrobe pieces close to it, closest first
  const matchesFor = (color) => pieces
    .map((entry) => ({ ...entry, d: Math.min(deltaE(entry.lab, color.lab), deltaE(entry.lab2, color.lab)) }))
    .filter((entry) => entry.d <= CLOSE)
    .sort((a, b) => a.d - b.d);

  const shown = useMemo(() => PALETTES
    .filter((palette) => !size || palette.colors.length === size)
    .filter((palette) => !family || palette.colors.some((color) => color.family === family))
    .filter((palette) => !piece || palette.colors.some((color) => Math.min(deltaE(piece.lab, color.lab), deltaE(piece.lab2, color.lab)) <= CLOSE))
    .map((palette) => ({ ...palette, matches: palette.colors.map(matchesFor) }))
    .filter((palette) => !onlyMine || palette.matches.filter((list) => list.length).length >= Math.min(2, palette.colors.length)),
  [family, piece, size, onlyMine, pieces]); // eslint-disable-line react-hooks/exhaustive-deps

  const familiesInBook = COLOR_FAMILIES.filter((entry) => COLORS.some((color) => color.family === entry.id));
  const active = Boolean(family || piece || size || onlyMine);

  return (
    <section className="combos" aria-label="שילובי צבעים">
      <div className="combos__intro">
        <h2>שילובי צבעים</h2>
        <p>348 השילובים של "מילון שילובי הצבעים" מאת סאנזו ואדה, יפן, 1933, הספר שמעצבי אופנה חוזרים אליו עד היום. מתחת לכל צבע מופיעים הבגדים שלך בגוון קרוב.</p>
      </div>

      <div className="combos__filters">
        <div className="combos__row" role="group" aria-label="סינון לפי צבע">
          {familiesInBook.map((entry) => (
            <button key={entry.id} type="button" className={`filter-chip${family === entry.id ? " is-on" : ""}`} aria-pressed={family === entry.id} onClick={() => setFamily(family === entry.id ? null : entry.id)}>
              <span className="filter-chip__dot" style={{ background: entry.swatch }} />{entry.label}
            </button>
          ))}
        </div>
        {pieces.length > 0 && (
          <div className="combos__pieces" role="group" aria-label="שילובים לפריט מהארון">
            {pieces.map(({ item }) => (
              <button key={item.id} type="button" className={`look-filters__item${pieceId === item.id ? " is-on" : ""}`} aria-pressed={pieceId === item.id} onClick={() => setPieceId(pieceId === item.id ? null : item.id)}>
                <span className="look-filters__thumb">
                  <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 160)} onError={imageFallback(item.thumbnail || item.image)} alt="" loading="lazy" decoding="async" />
                </span>
                <span className="look-filters__name">{item.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="combos__row">
          {[[0, "הכל"], [2, "2 צבעים"], [3, "3 צבעים"], [4, "4 צבעים"]].map(([value, label]) => (
            <button key={value} type="button" className={`filter-chip${size === value ? " is-on" : ""}`} aria-pressed={size === value} onClick={() => setSize(value)}>{label}</button>
          ))}
          <button type="button" className={`filter-chip${onlyMine ? " is-on" : ""}`} aria-pressed={onlyMine} onClick={() => setOnlyMine((value) => !value)}>יש לי בארון</button>
          {active && (
            <button type="button" className="wardrobe-filters__clear" onClick={() => { setFamily(null); setPieceId(null); setSize(0); setOnlyMine(false); }}>
              <X size={13} aria-hidden="true" /> ניקוי
            </button>
          )}
        </div>
        <p className="combos__count">{shown.length} שילובים</p>
      </div>

      <div className="combos__grid">
        {shown.map((palette) => {
          // One piece per colour (the closest), different pieces, to start a look from
          const used = new Set();
          const picks = palette.matches.map((list) => {
            const pick = list.find((entry) => !used.has(entry.item.id));
            if (pick) used.add(pick.item.id);
            return pick?.item.id;
          }).filter(Boolean);
          return (
            <article key={palette.number} className="combo">
              <div className="combo__swatches">
                {palette.colors.map((color, index) => (
                  <div key={index} className="combo__color">
                    <span className="combo__swatch" style={{ background: color.hex }} title={color.name} />
                    <div className="combo__mine">
                      {palette.matches[index].slice(0, 3).map(({ item }) => (
                        <img key={item.id} src={thumbUrl(fittedImage(item.thumbnail || item.image), 120)} onError={imageFallback(item.thumbnail || item.image)} alt={item.name} title={item.name} loading="lazy" decoding="async" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="combo__foot">
                <span className="combo__number">#{palette.number}</span>
                {picks.length >= 2 && (
                  <button type="button" className="combo__look" onClick={() => onCreateLook(picks)}>
                    <MagicWand size={13} aria-hidden="true" /> לוק מהשילוב
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!shown.length && <p className="look-filters__empty combos__none">אין שילובים שמתאימים לסינון.</p>}
    </section>
  );
}
