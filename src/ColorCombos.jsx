import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, Camera, CaretDown, Heart, ImageSquare, MagicWand, Plus, Sparkle, X } from "@phosphor-icons/react";
import { COLOR_FAMILIES, colorFamily } from "./colors.js";
import { CLOSE, deltaE, hexToLab } from "./color-match.js";
import { WADA_COLORS, WADA_PALETTES } from "./wada-palettes.js";

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
// Combinations", filtered by a colour of the book or a scanned garment, with the
// wardrobe pieces that match each colour and a quick way to make a look of them
// Favourite combinations, kept on the server with the profile (so on every device)
function useComboFavorites(wardrobeId) {
  const [favorites, setFavorites] = useState([]);
  const latest = useRef([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/import/combo-favorites", { headers: { "x-wardrobe-id": wardrobeId } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (alive && Array.isArray(data?.favorites)) { latest.current = data.favorites; setFavorites(data.favorites); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [wardrobeId]);
  const toggle = (number) => {
    const before = latest.current;
    const next = before.includes(number) ? before.filter((n) => n !== number) : [...before, number];
    latest.current = next;
    setFavorites(next);
    fetch("/api/import/combo-favorites", { method: "PUT", headers: { "Content-Type": "application/json", "x-wardrobe-id": wardrobeId }, body: JSON.stringify({ favorites: next }) })
      .then((res) => { if (!res.ok) throw new Error(); })
      .catch(() => { latest.current = before; setFavorites(before); });
  };
  return [favorites, toggle];
}

function HeartButton({ on, onClick, className = "" }) {
  return (
    <button type="button" className={`combo__heart${on ? " is-on" : ""} ${className}`} aria-pressed={on} aria-label={on ? "הסרה מהמועדפים" : "הוספה למועדפים"} onClick={onClick}>
      <Heart size={17} weight={on ? "fill" : "regular"} />
    </button>
  );
}

export function ColorCombos({ items, wardrobeId = "user-shani", onCreateLook }) {
  const [favorites, toggleFavorite] = useComboFavorites(wardrobeId);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [shadeId, setShadeId] = useState(null);
  const [shadesOpen, setShadesOpen] = useState(false);
  const [dailyOpen, setDailyOpen] = useState(false);
  const [pieceId, setPieceId] = useState(null);
  const [size, setSize] = useState(0);
  // A garment photo (camera or gallery): its colour, picked by touching it
  const [scan, setScan] = useState(null); // { photo, hex, x, y }
  // Colours sampled from one or more photos; combinations are found for them together
  const [samples, setSamples] = useState([]); // [{ id, hex, lab }]
  const fileRef = useRef(null);
  const galleryRef = useRef(null);
  const addSample = (hex) => setSamples((current) => (current.some((sample) => sample.hex === hex) ? current : [...current, { id: `${hex}-${Date.now()}`, hex, lab: hexToLab(hex) }]));
  const removeSample = (id) => setSamples((current) => current.filter((sample) => sample.id !== id));
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

  const candidates = useMemo(() => PALETTES
    .filter((palette) => !onlyFavorites || favorites.includes(palette.number))
    .filter((palette) => !size || palette.colors.length === size)
    .filter((palette) => shadeId === null || palette.colors.some((color) => SHADE_OF.get(color) === shadeId))
    .filter((palette) => !piece || palette.colors.some((color) => Math.min(deltaE(piece.lab, color.lab), deltaE(piece.lab2, color.lab)) <= CLOSE))
    .map((palette) => {
      // The colour of the combination closest to each sampled colour, when close enough
      const sampledAt = samples.map((sample) => {
        let best = -1;
        palette.colors.forEach((color, index) => { if (deltaE(sample.lab, color.lab) <= CLOSE && (best < 0 || deltaE(sample.lab, color.lab) < deltaE(sample.lab, palette.colors[best].lab))) best = index; });
        return best;
      });
      return { ...palette, sampledAt, sampled: sampledAt.filter((index) => index >= 0).length, matches: palette.colors.map(matchesFor) };
    }),
  [shadeId, piece, samples, size, pieces, onlyFavorites, favorites]); // eslint-disable-line react-hooks/exhaustive-deps
  // With sampled colours: the combinations that have all of them, or if there are
  // none, the ones that have the most of them
  const bestSampled = samples.length ? Math.max(0, ...candidates.map((palette) => palette.sampled)) : 0;
  const shown = samples.length ? candidates.filter((palette) => bestSampled > 0 && palette.sampled === bestSampled) : candidates;

  const shade = shadeId === null ? null : SHADES[shadeId];
  const active = Boolean(shade || piece || samples.length || size || onlyFavorites);

  return (
    <section className="combos" aria-label="שילובי צבעים">
      <div className="combos__intro">
        <h2>שילובי צבעים</h2>
        <p>348 שילובים מספר הצבעים היפני של סאנזו ואדה. דגמי צבעים מתמונות של בגדים כדי למצוא שילובים, ו"לוק מהשילוב" יציע לך בגדים בצבעים שלו.</p>
        <button type="button" className="combos__daily-btn" onClick={() => setDailyOpen(true)}>
          <Sparkle size={16} aria-hidden="true" /> השילוב היומי
        </button>
      </div>

      <div className="combos__filters">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { openPhoto(event.target.files?.[0]); event.target.value = ""; }} />
        <input ref={galleryRef} type="file" accept="image/*" hidden onChange={(event) => { openPhoto(event.target.files?.[0]); event.target.value = ""; }} />
        {!scan && !samples.length && (
          <div className="combos__scan-start">
            <div className="combos__row">
              <button type="button" className="combos__scan-btn" onClick={() => fileRef.current?.click()}>
                <Camera size={17} aria-hidden="true" /> צילום בגד
              </button>
              <button type="button" className="combos__scan-btn is-light" onClick={() => galleryRef.current?.click()}>
                <ImageSquare size={17} aria-hidden="true" /> מהגלריה
              </button>
            </div>
          </div>
        )}
        {scan && (
          <div className="combos__scan">
            <p className="combos__scan-hint">געי בצבע בתמונה, ואז "הוספת הצבע". אפשר לדגום כמה צבעים מאותה תמונה.</p>
            <div className="combos__scan-photo" onClick={pickAt} role="button" tabIndex={0} aria-label="בחירת הצבע בתמונה">
              <img src={scan.photo} alt="התמונה לדגימה" />
              <span className="combos__scan-mark" style={{ left: `${scan.x * 100}%`, top: `${scan.y * 100}%`, background: scan.hex }} aria-hidden="true" />
            </div>
            <div className="combos__scan-actions">
              <span className="combos__scan-swatch" style={{ background: scan.hex }} aria-hidden="true" />
              <button type="button" className="combo__look" disabled={samples.some((sample) => sample.hex === scan.hex)} onClick={() => { addSample(scan.hex); setPieceId(null); setShadeId(null); }}>
                <Plus size={13} aria-hidden="true" /> {samples.some((sample) => sample.hex === scan.hex) ? "נוסף" : "הוספת הצבע"}
              </button>
            </div>
            {samples.length > 0 && (
              <div className="combos__samples" aria-label="הצבעים שדגמת">
                {samples.map((sample) => (
                  <button key={sample.id} type="button" className="combos__sample" style={{ background: sample.hex }} onClick={() => removeSample(sample.id)} aria-label="הסרת הצבע"><X size={11} weight="bold" /></button>
                ))}
              </div>
            )}
            <div className="combos__scan-actions">
              <button type="button" className="filter-chip" onClick={() => fileRef.current?.click()}><Camera size={13} aria-hidden="true" /> צילום נוסף</button>
              <button type="button" className="filter-chip" onClick={() => galleryRef.current?.click()}><ImageSquare size={13} aria-hidden="true" /> תמונה מהגלריה</button>
              <button type="button" className="combos__scan-done" onClick={() => setScan(null)}>{samples.length ? `הצגת שילובים (${samples.length} ${samples.length === 1 ? "צבע" : "צבעים"})` : "ביטול"}</button>
            </div>
            <p className="combos__scan-note">כדאי לצלם באור יום, בלי פלאש. תאורה חמה או צל משנים את הגוון.</p>
          </div>
        )}
        {!scan && samples.length > 0 && (
          <div className="combos__scanned">
            <div className="combos__scanned-top">
              <p>
                <strong>{samples.length === 1 ? "שילובים לצבע שדגמת" : `שילובים ל-${samples.length} הצבעים שדגמת`}</strong>
                <span>
                  {bestSampled === samples.length || samples.length === 1
                    ? (samples.length === 1 ? "הצבע הקרוב אליו מסומן בכל שילוב בנקודה לבנה" : "בכל שילוב יש את כל הצבעים שדגמת, מסומנים בנקודה לבנה")
                    : bestSampled > 0 ? `אין שילוב עם כל הצבעים. אלה השילובים עם ${bestSampled} מהם` : "אין בספר שילוב עם הצבעים האלה"}
                </span>
              </p>
              <button type="button" className="lb-close combos__scanned-x" onClick={() => setSamples([])} aria-label="ניקוי הדגימות"><X size={14} /></button>
            </div>
            <div className="combos__samples">
              {samples.map((sample) => (
                <button key={sample.id} type="button" className="combos__sample" style={{ background: sample.hex }} onClick={() => removeSample(sample.id)} aria-label="הסרת הצבע"><X size={11} weight="bold" /></button>
              ))}
              <button type="button" className="filter-chip" onClick={() => fileRef.current?.click()}><Camera size={13} aria-hidden="true" /> עוד צבע</button>
              <button type="button" className="filter-chip" onClick={() => galleryRef.current?.click()}><ImageSquare size={13} aria-hidden="true" /> מהגלריה</button>
            </div>
          </div>
        )}
        <button type="button" className={`wardrobe-filters__toggle combos__shades-toggle${shade ? " is-active" : ""}`} aria-expanded={shadesOpen} onClick={() => setShadesOpen((value) => !value)}>
          {shade ? <span className="filter-chip__dot" style={{ background: shade.hex }} aria-hidden="true" /> : <span className="combos__shades-dots" aria-hidden="true">{["#c0392b", "#f1c40f", "#3e8e41", "#2f5d9c"].map((hex) => <span key={hex} style={{ background: hex }} />)}</span>}
          <span>{shade ? shade.name : "סינון לפי צבע"}</span>
          <CaretDown size={13} className="combos__shades-caret" aria-hidden="true" />
        </button>
        {shadesOpen && <div className="combos__shades" role="group" aria-label="סינון לפי צבע מהספר">
          {SHADE_ROWS.map((row) => (
            <div key={row.id} className="combos__shade-row">
              <span className="combos__shade-label">{row.label}</span>
              <div className="combos__shade-list">
                {row.shades.map((entry) => (
                  <button key={entry.id} type="button" className={`combos__shade${shadeId === entry.id ? " is-on" : ""}`} style={{ background: entry.hex }} title={entry.name} aria-label={entry.members.length > 1 ? `${entry.name} (${entry.members.length} גוונים קרובים)` : entry.name} aria-pressed={shadeId === entry.id} onClick={() => { setShadeId(shadeId === entry.id ? null : entry.id); setPieceId(null); setSamples([]); setShadesOpen(false); }}>
                    {entry.members.length > 1 && <span className={entry.lab[0] > 62 ? "is-dark" : ""}>+{entry.members.length - 1}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>}
        <div className="combos__row">
          {[[0, "הכל"], [2, "2 צבעים"], [3, "3 צבעים"], [4, "4 צבעים"]].map(([value, label]) => (
            <button key={value} type="button" className={`filter-chip${size === value ? " is-on" : ""}`} aria-pressed={size === value} onClick={() => setSize(value)}>{label}</button>
          ))}
          <button type="button" className={`filter-chip combos__fav-chip${onlyFavorites ? " is-on" : ""}`} aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites((value) => !value)}>
            <Heart size={13} weight={onlyFavorites ? "fill" : "regular"} aria-hidden="true" /> מועדפים{favorites.length > 0 && <small>{favorites.length}</small>}
          </button>
          {active && (
            <button type="button" className="wardrobe-filters__clear" onClick={() => { setShadeId(null); setPieceId(null); setSamples([]); setSize(0); setOnlyFavorites(false); }}>
              <X size={13} aria-hidden="true" /> ניקוי
            </button>
          )}
        </div>
        <p className="combos__count">{shown.length} שילובים</p>
      </div>

      <div className="combos__grid">
        {shown.map((palette) => {
          const owned = palette.matches.filter((list) => list.length).length;
          const sampledColors = new Set(palette.sampledAt.filter((index) => index >= 0));
          return (
            <article key={palette.number} className="combo">
              <div className="combo__swatches">
                {palette.colors.map((color, index) => (
                  <span key={index} className={`combo__swatch${(shade && SHADE_OF.get(color) === shadeId) || sampledColors.has(index) ? " is-picked" : ""}`} style={{ background: color.hex }} title={color.name} />
                ))}
              </div>
              <div className="combo__foot">
                <span className="combo__number">#{palette.number}</span>
                <HeartButton on={favorites.includes(palette.number)} onClick={() => toggleFavorite(palette.number)} />
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
      {!shown.length && <p className="look-filters__empty combos__none">{onlyFavorites && !favorites.length ? "עוד אין שילובים מועדפים. אפשר לסמן שילוב בלב." : "אין שילובים שמתאימים לסינון."}</p>}
      {dailyOpen && <DailyCombo favorites={favorites} onToggleFavorite={toggleFavorite} canLook={(palette) => palette.colors.some((color) => matchesFor(color).length > 0)} onClose={() => setDailyOpen(false)} onCreateLook={(palette) => { setDailyOpen(false); onCreateLook(palette); }} />}
    </section>
  );
}

const SIZE_KEY = "daily-combo-size";
const readSize = () => { try { return Number(localStorage.getItem(SIZE_KEY)) || 3; } catch { return 3; } };
// The same combination all day, a different one each day (per number of colours)
const dayIndex = (count) => {
  const day = new Date().toLocaleDateString("en-CA");
  let hash = 0;
  for (const char of day) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % count;
};

// One combination of the day, with 2, 3 or 4 colours, and "ערבוב" for another
function DailyCombo({ favorites, onToggleFavorite, canLook, onClose, onCreateLook }) {
  const [size, setSize] = useState(readSize);
  const pool = useMemo(() => PALETTES.filter((palette) => palette.colors.length === size), [size]);
  const [shuffled, setShuffled] = useState(null); // a palette number, after "ערבוב"
  const palette = (shuffled !== null && pool.find((entry) => entry.number === shuffled)) || pool[dayIndex(pool.length)];
  const chooseSize = (value) => {
    setSize(value);
    setShuffled(null);
    try { localStorage.setItem(SIZE_KEY, String(value)); } catch { /* not kept */ }
  };
  const shuffle = () => {
    const others = pool.filter((entry) => entry.number !== palette.number);
    setShuffled(others[Math.floor(Math.random() * others.length)].number);
  };
  return (
    <div className="builder-modal-overlay look-builder-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="builder-modal look-builder daily-combo" role="dialog" aria-modal="true" aria-labelledby="daily-title">
        <header className="lb-header">
          <h2 id="daily-title">{shuffled === null ? "השילוב היומי" : "שילוב אחר"}</h2>
          <button className="lb-close" type="button" onClick={onClose} aria-label="סגירה"><X size={18} /></button>
        </header>
        <div className="lb-body">
          <div className="styling-choice__options daily-combo__sizes" role="radiogroup" aria-label="מספר הצבעים">
            {[2, 3, 4].map((value) => (
              <button key={value} type="button" role="radio" aria-checked={size === value} className={size === value ? "is-on" : ""} onClick={() => chooseSize(value)}>{value} צבעים</button>
            ))}
          </div>
          <div key={palette.number} className="daily-combo__colors">
            {palette.colors.map((color, index) => (
              <div key={index} className="daily-combo__color" style={{ background: color.hex }}>
                <span className={color.lab[0] > 62 ? "is-dark" : ""}>{color.name}<small>{color.hex.toUpperCase()}</small></span>
              </div>
            ))}
          </div>
          <div className="daily-combo__meta">
            <p className="daily-combo__number">שילוב #{palette.number} מתוך {pool.length} שילובים של {size} צבעים</p>
            <HeartButton on={favorites.includes(palette.number)} onClick={() => onToggleFavorite(palette.number)} className="is-big" />
          </div>
        </div>
        <footer className="lb-footer">
          <div className="lb-footer__actions">
            <button className="lb-button" type="button" onClick={shuffle}><ArrowsClockwise size={15} /> ערבוב</button>
            {canLook(palette) && <button className="lb-button is-primary" type="button" onClick={() => onCreateLook({ number: palette.number, colors: palette.colors.map((color) => ({ hex: color.hex, name: color.name })) })}>
              <MagicWand size={15} /> לוק מהשילוב
            </button>}
          </div>
        </footer>
      </div>
    </div>
  );
}
