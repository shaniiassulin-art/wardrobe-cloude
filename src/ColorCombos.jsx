import { useMemo, useRef, useState } from "react";
import { Camera, MagicWand, X } from "@phosphor-icons/react";
import { COLOR_FAMILIES, colorFamily } from "./colors.js";
import { CLOSE, deltaE, hexToLab } from "./color-match.js";
import { WADA_COLORS, WADA_PALETTES } from "./wada-palettes.js";
import { fittedImage, imageFallback, thumbUrl } from "./image-files.js";

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

// The colour of a spot on a photo: the median of a small patch, so a thread,
// a shadow or a highlight does not change the result
function sampleColor(canvas, x, y, radius) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const left = Math.max(0, Math.round(x - radius));
  const top = Math.max(0, Math.round(y - radius));
  const size = Math.max(1, Math.round(radius * 2));
  const { data } = context.getImageData(left, top, Math.min(size, canvas.width - left), Math.min(size, canvas.height - top));
  const channels = [[], [], []];
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) channels[c].push(data[i + c]);
  const median = (list) => { const sorted = list.sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] || 0; };
  return toHex(median(channels[0]), median(channels[1]), median(channels[2]));
}

const COLORS = WADA_COLORS.map(([name, hex]) => ({ name, hex, lab: hexToLab(hex), family: colorFamily(hex) }));
// The book's colours for filtering: near-identical ones (ΔE under 8) become one
// swatch, grouped by family and ordered light to dark
const SHADES = (() => {
  const groups = [];
  COLORS.forEach((color, index) => {
    const group = groups.find((entry) => entry.members.every((i) => deltaE(COLORS[i].lab, color.lab) < 8));
    if (group) group.members.push(index); else groups.push({ members: [index] });
  });
  return groups.map((group, id) => ({ id, members: group.members, hex: COLORS[group.members[0]].hex, name: group.members.map((i) => COLORS[i].name).join(" / "), family: COLORS[group.members[0]].family, lab: COLORS[group.members[0]].lab }));
})();
const SHADE_OF = new Map(SHADES.flatMap((shade) => shade.members.map((i) => [COLORS[i], shade.id])));
const SHADE_ROWS = COLOR_FAMILIES
  .map((family) => ({ ...family, shades: SHADES.filter((shade) => shade.family === family.id).sort((a, b) => b.lab[0] - a.lab[0]) }))
  .filter((row) => row.shades.length);

const PALETTES = WADA_PALETTES.map(([number, indexes]) => ({ number, colors: indexes.map((i) => COLORS[i]) }));

// Every recommended combination from Sanzo Wada's "A Dictionary of Colour
// Combinations", filtered by a colour or by a piece from the wardrobe, with the
// wardrobe pieces that match each colour and a quick way to make a look of them
export function ColorCombos({ items, onCreateLook }) {
  const [shadeId, setShadeId] = useState(null);
  const [pieceId, setPieceId] = useState(null);
  const [size, setSize] = useState(0);
  const [onlyMine, setOnlyMine] = useState(false);
  // A garment photographed with the camera: its colour, picked by touching it
  const [scan, setScan] = useState(null); // { photo, hex, x, y }
  const [scanned, setScanned] = useState(null); // the colour used for filtering
  const fileRef = useRef(null);
  const canvasRef = useRef(null);
  const openPhoto = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      canvasRef.current = canvas;
      // Starts from the middle of the photo, where the garment usually is
      const x = canvas.width / 2;
      const y = canvas.height / 2;
      setScan({ photo: canvas.toDataURL("image/jpeg", 0.85), hex: sampleColor(canvas, x, y, Math.min(canvas.width, canvas.height) * 0.08), x: 0.5, y: 0.5 });
      URL.revokeObjectURL(url);
    };
    image.src = url;
  };
  const pickAt = (event) => {
    const canvas = canvasRef.current;
    if (!canvas || !scan) return;
    const box = event.currentTarget.getBoundingClientRect();
    const fx = (event.clientX - box.left) / box.width;
    const fy = (event.clientY - box.top) / box.height;
    setScan({ ...scan, x: fx, y: fy, hex: sampleColor(canvas, fx * canvas.width, fy * canvas.height, Math.min(canvas.width, canvas.height) * 0.03) });
  };
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
    .filter((palette) => shadeId === null || palette.colors.some((color) => SHADE_OF.get(color) === shadeId))
    .filter((palette) => !piece || palette.colors.some((color) => Math.min(deltaE(piece.lab, color.lab), deltaE(piece.lab2, color.lab)) <= CLOSE))
    .filter((palette) => !scanned || palette.colors.some((color) => deltaE(scanned.lab, color.lab) <= CLOSE))
    .map((palette) => ({ ...palette, matches: palette.colors.map(matchesFor) }))
    .filter((palette) => !onlyMine || palette.matches.filter((list) => list.length).length >= Math.min(2, palette.colors.length)),
  [shadeId, piece, scanned, size, onlyMine, pieces]); // eslint-disable-line react-hooks/exhaustive-deps

  const shade = shadeId === null ? null : SHADES[shadeId];
  const active = Boolean(shade || piece || scanned || size || onlyMine);

  return (
    <section className="combos" aria-label="שילובי צבעים">
      <div className="combos__intro">
        <h2>שילובי צבעים</h2>
        <p>348 השילובים של "מילון שילובי הצבעים" מאת סאנזו ואדה, יפן, 1933, הספר שמעצבי אופנה חוזרים אליו עד היום. "לוק מהשילוב" פותח הרכבת לוק עם הבגדים שלך בגוונים של השילוב.</p>
      </div>

      <div className="combos__filters">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { openPhoto(event.target.files?.[0]); event.target.value = ""; }} />
        {!scan && (
          <div className="combos__row">
            <button type="button" className="combos__scan-btn" onClick={() => fileRef.current?.click()}>
              <Camera size={17} aria-hidden="true" /> סריקת בגד מהארון
            </button>
            {scanned && (
              <button type="button" className="filter-chip is-on" onClick={() => setScanned(null)}>
                <span className="filter-chip__dot" style={{ background: scanned.hex }} />הצבע שנסרק<X size={11} aria-label="הסרה" />
              </button>
            )}
          </div>
        )}
        {scan && (
          <div className="combos__scan">
            <p className="combos__scan-hint">געי בבגד בתמונה כדי לבחור את הצבע שלו</p>
            <div className="combos__scan-photo" onClick={pickAt} role="button" tabIndex={0} aria-label="בחירת הצבע בתמונה">
              <img src={scan.photo} alt="הבגד שצולם" />
              <span className="combos__scan-mark" style={{ left: `${scan.x * 100}%`, top: `${scan.y * 100}%`, background: scan.hex }} aria-hidden="true" />
            </div>
            <div className="combos__scan-actions">
              <span className="combos__scan-swatch" style={{ background: scan.hex }} aria-hidden="true" />
              <button type="button" className="combo__look" onClick={() => { setScanned({ hex: scan.hex, lab: hexToLab(scan.hex) }); setPieceId(null); setShadeId(null); setScan(null); }}>
                <MagicWand size={13} aria-hidden="true" /> שילובים לצבע הזה
              </button>
              <button type="button" className="filter-chip" onClick={() => fileRef.current?.click()}>תמונה אחרת</button>
              <button type="button" className="filter-chip" onClick={() => setScan(null)}>ביטול</button>
            </div>
            <p className="combos__scan-note">כדאי לצלם באור יום, בלי פלאש. תאורה חמה או צל משנים את הגוון.</p>
          </div>
        )}
        <div className="combos__shades" role="group" aria-label="סינון לפי צבע מהספר">
          {SHADE_ROWS.map((row) => (
            <div key={row.id} className="combos__shade-row">
              <span className="combos__shade-label">{row.label}</span>
              <div className="combos__shade-list">
                {row.shades.map((entry) => (
                  <button key={entry.id} type="button" className={`combos__shade${shadeId === entry.id ? " is-on" : ""}`} style={{ background: entry.hex }} title={entry.name} aria-label={entry.name} aria-pressed={shadeId === entry.id} onClick={() => { setShadeId(shadeId === entry.id ? null : entry.id); setPieceId(null); setScanned(null); }} />
                ))}
              </div>
            </div>
          ))}
        </div>
        {shade && (
          <div className="combos__row">
            <button type="button" className="filter-chip is-on" onClick={() => setShadeId(null)}>
              <span className="filter-chip__dot" style={{ background: shade.hex }} />{shade.name}<X size={11} aria-label="הסרה" />
            </button>
          </div>
        )}
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
            <button type="button" className="wardrobe-filters__clear" onClick={() => { setShadeId(null); setPieceId(null); setScanned(null); setSize(0); setOnlyMine(false); }}>
              <X size={13} aria-hidden="true" /> ניקוי
            </button>
          )}
        </div>
        <p className="combos__count">{shown.length} שילובים</p>
      </div>

      <div className="combos__grid">
        {shown.map((palette) => {
          const owned = palette.matches.filter((list) => list.length).length;
          return (
            <article key={palette.number} className="combo">
              <div className="combo__swatches">
                {palette.colors.map((color, index) => (
                  <span key={index} className={`combo__swatch${shade && SHADE_OF.get(color) === shadeId ? " is-picked" : ""}`} style={{ background: color.hex }} title={color.name} />
                ))}
              </div>
              <div className="combo__foot">
                <span className="combo__number">#{palette.number}</span>
                {owned > 0 && (
                  <button type="button" className="combo__look" onClick={() => onCreateLook({ number: palette.number, colors: palette.colors.map((color) => ({ hex: color.hex, name: color.name })) })}>
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
