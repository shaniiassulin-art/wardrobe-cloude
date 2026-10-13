import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, ArrowsLeftRight, CaretDown, Check, CheckSquare, Copy, FloppyDisk, MagicWand, Plus, Suitcase, Trash, User, X } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { toBrowserImage } from "./image-files.js";
import { ImageLightbox } from "./ImageLightbox.jsx";
import { LuggageView, SuitcasePicker, newSuitcaseId } from "./Suitcases.jsx";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";
const ACTIVE_WARDROBE_KEY = "active_wardrobe_id";

const TYPES = [
  { id: "all", label: "הכל" },
  { id: "looks", label: "לוקים", singular: "לוק" },
  { id: "luggage", label: "מזוודות", singular: "פריט מזוודה" },
  { id: "upperbody", label: "חולצות", singular: "חולצה" },
  { id: "lowerbody", label: "מכנסיים", singular: "מכנסיים" },
  { id: "dress", label: "שמלות", singular: "שמלה" },
  { id: "wholebody_up", label: "עליוניות", singular: "עליונית" },
  { id: "shoes", label: "נעליים", singular: "נעליים" },
  { id: "accessories_up", label: "אקססוריז", singular: "אקססורי" },
];

const OUTFIT_SLOTS = [
  { key: "top", label: "Top", hebrew: "חולצה / עליון", icon: "👕", parts: ["upperbody", "top"], placeholder: "Add Top" },
  { key: "bottom", label: "Bottom", hebrew: "מכנסיים / חצאית", icon: "👖", parts: ["lowerbody", "bottom"], placeholder: "Add Bottom" },
  { key: "dress", label: "Dress", hebrew: "שמלה / פריט שלם", icon: "👗", parts: ["dress", "wholebody"], placeholder: "Add Dress" },
  { key: "outerwear", label: "Outerwear", hebrew: "ז'קט / עליונית", icon: "🧥", parts: ["wholebody_up", "outerwear", "jacket"], placeholder: "Add Outerwear" },
  { key: "shoes", label: "Shoes", hebrew: "נעליים", icon: "👟", parts: ["shoes", "footwear"], placeholder: "Add Shoes" },
  { key: "accessories", label: "Accessories", hebrew: "אקססוריז", icon: "🕶️", parts: ["accessories_up", "accessories", "accessory"], placeholder: "Add Accessory" },
];

function getItemSlotKey(item) {
  if (!item) return "top";
  const part = (item.part || "").toLowerCase();
  for (const slot of OUTFIT_SLOTS) {
    if (slot.parts.includes(part)) return slot.key;
  }
  return "top";
}

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));


function readEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}


function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function removePersistedEdit(id) {
  const edits = readEdits();
  delete edits[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function readDeletedItems() {
  try {
    const value = JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistDeletedItem(id) {
  const deleted = readDeletedItems();
  deleted.add(id);
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...deleted]));
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

// Wardrobe card. Hovering (or the small switch on touch screens) shows the photo
// of the garment on the user when one exists. In select mode a tap toggles it.
function GalleryItem({ item, selected, selectMode, checked, onOpen, onToggleSelect }) {
  const [showModeled, setShowModeled] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "פריט מלתחה";
  const hasModeled = Boolean(item.modeledImage);

  return (
    <div className={`gallery-item${selected ? " selected" : ""}${checked ? " is-checked" : ""}${hasModeled ? " has-modeled" : ""}${showModeled ? " show-modeled" : ""}`}>
      <button
        className="gallery-item__main"
        type="button"
        onClick={() => (selectMode ? onToggleSelect(item.id) : onOpen(item.id))}
        aria-label={selectMode ? `בחירת ${item.name || type}` : `צפייה ב-${item.name || type}`}
        aria-pressed={selectMode ? checked : undefined}
        data-testid={`wardrobe-item-${item.id}`}
      >
        <OptimizedImage
          src={item.thumbnail || item.image}
          alt=""
          sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 260px"
          breakpoints={[160, 240, 320, 480, 640]}
        />
        {hasModeled && <img className="gallery-item__modeled" src={item.modeledImage} alt="" loading="lazy" />}
        {selectMode && <span className="gallery-item__check" aria-hidden="true">{checked && <Check size={16} weight="bold" />}</span>}
      </button>
      {hasModeled && !selectMode && (
        <button type="button" className="gallery-item__swap" onClick={() => setShowModeled((value) => !value)} aria-pressed={showModeled}>
          {showModeled ? "הבגד" : "עליי"}
        </button>
      )}
      {item.name && <p className="gallery-item__name">{item.name}</p>}
    </div>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`הסר ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="הוסף מאפיין"
          aria-label="הוסף מאפיין"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="הוסף">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>אופציונלי</small>
        </div>
        <button className="add-secondary-button" type="button" onClick={onAdd}>הוסף צבע משני</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>הסר</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`בחר ${label}`}
        />
        <span className="selected-color-copy">
          <small>נבחר</small>
          <strong>{value || "מותאם"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>הצעות מהתמונה</span>
      </div>
      <div className="palette" aria-label={`הצעות ${label} מהתמונה`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`בחר ${color}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "בטל דגימה" : "דגום מהתמונה"}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>שם הפריט</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || "פריט מלתחה"}
        />
      </label>

      <label className="field">
        <span>קטגוריה</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(2).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>צבעים</legend>
        <div className="colors-editor">
          <ColorControl
            label="צבע ראשי"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="צבע משני"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        {sampling && <p className="color-help" aria-live="polite">לחצו על הבגד לדגימת צבע.</p>}
      </fieldset>

      <div className="field details-field">
        <span>מאפיינים</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function ItemViewer({ item, suitcaseCount = 0, onPack, onCreateLook, onClose, onSave, onDelete, onModeledGenerated }) {
  const [zoomSrc, setZoomSrc] = useState(null);
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [generatingModeled, setGeneratingModeled] = useState(false);
  const [modeledError, setModeledError] = useState("");
  const [activePhotoTab, setActivePhotoTab] = useState("flat");
  const type = TYPE_MAP[item.part]?.singular || "פריט מלתחה";
  const hasModeledImage = Boolean(item.modeledImage);

  const handleGenerateModeled = async () => {
    setGeneratingModeled(true);
    setModeledError("");
    try {
      const res = await fetch(`/api/import/wardrobe/${item.id}/modeled`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה ביצירת הדמיה על מודל");
      onModeledGenerated?.(data);
      setActivePhotoTab("modeled");
    } catch (err) {
      setModeledError(err.message || "שגיאה ביצירת תמונה");
    } finally {
      setGeneratingModeled(false);
    }
  };
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (sampling) setSampling(null);
        else requestClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [requestClose, sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setActivePhotoTab("flat");
    setModeledError("");
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus("השינויים נשמרו.");
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling) { setZoomSrc(item.image); return; }
    if (!samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("האזור שקוף – נסו לדגום ישירות מהבגד.");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`נדגם ${color} כצבע ${sampling === "secondary" ? "משני" : "ראשי"}.`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${sampling ? " sampling" : ""}`}
    >
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`פריט נבחר`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">לחצו על הבגד לדגימה</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer item-sheet${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="פריט מלתחה נבחר">
      <header className="item-sheet__header">
        <div>
          <p className="item-sheet__eyebrow">{TYPE_MAP[draft.part]?.singular || "פריט"}</p>
          <h2>{draft.name || type}</h2>
        </div>
        <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="סגור" ref={closeButtonRef}>
          <X size={20} weight="light" aria-hidden="true" />
        </button>
      </header>

      <div className="item-sheet__media">
        {hasModeledImage && (
          <div className="item-sheet__switch" role="group" aria-label="איזו תמונה להציג">
            <button type="button" className={activePhotoTab === "flat" ? "is-active" : ""} aria-pressed={activePhotoTab === "flat"} onClick={() => setActivePhotoTab("flat")}>הבגד</button>
            <button type="button" className={activePhotoTab === "modeled" ? "is-active" : ""} aria-pressed={activePhotoTab === "modeled"} onClick={() => setActivePhotoTab("modeled")}>עליי</button>
          </div>
        )}
        {hasModeledImage && activePhotoTab === "modeled" ? (
          <button type="button" className="item-sheet__modeled" onClick={() => setZoomSrc(item.modeledImage)} aria-label="הגדלת התמונה">
            <img src={item.modeledImage} alt={`${draft.name || type} עליי`} />
          </button>
        ) : (
          garmentArtwork
        )}
        {!sampling && <p className="item-sheet__hint">לחיצה על התמונה מגדילה אותה</p>}
      </div>

      <div className="item-sheet__actions">
        <button type="button" className={suitcaseCount ? "is-on" : ""} onClick={() => onPack?.(item.id)}>
          <Suitcase size={18} weight={suitcaseCount ? "fill" : "regular"} aria-hidden="true" />
          <span>{suitcaseCount ? `במזוודה (${suitcaseCount})` : "הוספה למזוודה"}</span>
        </button>
        <button type="button" onClick={() => onCreateLook?.(item.id)}>
          <MagicWand size={18} aria-hidden="true" />
          <span>לוק עם הפריט</span>
        </button>
        <button type="button" onClick={handleGenerateModeled} disabled={generatingModeled}>
          {generatingModeled ? <ArrowClockwise size={18} className="spin" aria-hidden="true" /> : <User size={18} aria-hidden="true" />}
          <span>{generatingModeled ? "יוצר..." : hasModeledImage ? "יצירה מחדש עליי" : "יצירה עליי"}</span>
        </button>
      </div>
      {modeledError && <p className="item-sheet__error" role="alert">{modeledError}</p>}

      <section className="item-sheet__section" aria-labelledby="item-details-title">
        <h3 id="item-details-title">פרטי הפריט</h3>
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />
      </section>

      {closeBlocked && <p className="unsaved-notice" role="status">יש לשמור או לבטל שינויים לפני סגירה.</p>}

      <footer className="item-sheet__footer">
        <button className="delete-button" type="button" onClick={() => onDelete(item.id)}>
          <Trash size={15} weight="regular" aria-hidden="true" /> מחיקה
        </button>
        <span className="action-spacer" />
        <button className="secondary-button" type="button" onClick={cancelEditing}>ביטול</button>
        <button className="primary-button" type="button" onClick={saveEditing} disabled={!isDirty}>
          <Check size={15} weight="bold" aria-hidden="true" /> שמירה
        </button>
      </footer>
    </aside>
    </div>
    {zoomSrc && <ImageLightbox src={zoomSrc} alt={draft.name || type} onClose={() => setZoomSrc(null)} />}
    </div>
  );
}

function LookViewerModal({ look, onClose, onDelete }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    await onDelete(look.id);
    onClose();
  };

  return (
    <div className="builder-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="builder-modal" style={{ maxWidth: "580px", padding: "26px" }}>
        <header className="builder-header" style={{ marginBottom: "18px" }}>
          <div>
            <span style={{ fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontWeight: "600" }}>לוק שמור</span>
            <h2 style={{ margin: "4px 0 0", fontSize: "20px" }}>{look.name}</h2>
          </div>
          <button className="import-icon-button" type="button" onClick={onClose} aria-label="סגור">
            <X size={20} />
          </button>
        </header>

        <div style={{ width: "100%", maxHeight: "72vh", overflowY: "auto", borderRadius: "4px", marginBottom: "16px", border: "1px solid var(--line)", background: "#f8f6f2", display: "flex", alignItems: "center", justifyContent: "center", padding: "8px" }}>
          <img src={look.image} alt={look.name} style={{ maxWidth: "100%", height: "auto", maxHeight: "68vh", objectFit: "contain", borderRadius: "2px" }} />
        </div>

        {look.notes && (
          <div style={{ marginBottom: "16px", padding: "10px 14px", background: "rgba(25, 24, 22, 0.03)", border: "1px dashed var(--line)", borderRadius: "4px" }}>
            <span style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "var(--muted)", marginBottom: "4px" }}>
              הערות סטיילינג
            </span>
            <p style={{ margin: 0, fontSize: "13px", fontStyle: "italic", color: "var(--ink)" }}>"{look.notes}"</p>
          </div>
        )}

        {look.setting && (
          <div style={{ marginBottom: "14px", fontSize: "12px", color: "var(--muted)" }}>
            <span style={{ fontWeight: "600", color: "var(--ink)" }}>רקע:</span> {look.setting}
          </div>
        )}

        {!!look.garments?.length && (
          <div style={{ marginBottom: "16px" }}>
            <span style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "var(--muted)", marginBottom: "8px" }}>פריטים בלוק</span>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              {look.garments.map((g) => (
                <div key={g.id} style={{ display: "flex", alignItems: "center", gap: "6px", border: "1px solid var(--line)", padding: "4px 8px", borderRadius: "3px", fontSize: "12px" }}>
                  <img src={g.thumbnail} alt="" style={{ width: "24px", height: "24px", objectFit: "contain" }} />
                  <span>{g.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--line)", paddingTop: "16px", marginTop: "16px" }}>
          <button className="delete-button" type="button" disabled={deleting} onClick={handleDelete}>
            <Trash size={15} /> מחיקת לוק
          </button>
          <button className="primary-button" type="button" onClick={onClose}>סגור</button>
        </div>
      </div>
    </div>
  );
}

function UserAccountModal({
  user,
  stats,
  activeWardrobeId = "user-shani",
  wardrobesList = [],
  hasModelRef = false,
  modelRefUrl = null,
  onUploadModelRef,
  uploadingModelRef = false,
  onSaveUser,
  onSwitchWardrobe,
  onConnectOrNewWardrobe,
  onDeleteWardrobe,
  onClose,
}) {
  const [name, setName] = useState(user?.name || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [moreOpen, setMoreOpen] = useState(activeWardrobeId !== "user-shani");
  const modelInputRef = useRef(null);
  const otherWardrobes = wardrobesList.filter((w) => w.id !== activeWardrobeId);

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user]);

  const siteUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const base = window.location.origin + window.location.pathname;
    return !activeWardrobeId || activeWardrobeId === "user-shani" ? base : `${base}?wardrobe=${encodeURIComponent(activeWardrobeId)}`;
  }, [activeWardrobeId]);

  const nameChanged = name.trim() && name.trim() !== (user?.name || "");

  const handleSaveName = async (event) => {
    event.preventDefault();
    if (!nameChanged) return;
    setSaving(true);
    try {
      await onSaveUser({ name: name.trim() });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {} finally {
      setSaving(false);
    }
  };

  const handleCopyLink = () => {
    navigator?.clipboard?.writeText?.(siteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleCreateWardrobe = async (event) => {
    event.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError("");
    try {
      await onConnectOrNewWardrobe({ name: newName.trim() });
      setNewName("");
    } catch (err) {
      setCreateError(err.message || "לא ניתן ליצור ארון כרגע");
    } finally {
      setCreating(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/import/logout", { method: "POST" }).catch(() => {});
    window.location.reload();
  };

  return (
    <div className="builder-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="builder-modal user-account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <header className="builder-header">
          <h2 id="account-title">הארון שלי</h2>
          <button className="import-icon-button" type="button" onClick={onClose} aria-label="סגור">
            <X size={20} />
          </button>
        </header>

        {/* 1. Who this wardrobe belongs to */}
        <section className="account-section" aria-labelledby="account-name-title">
          <h3 id="account-name-title">שם הארון</h3>
          <form className="account-row" onSubmit={handleSaveName}>
            <input
              className="account-input"
              type="text"
              aria-label="שם הארון"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <button className="secondary-button" type="submit" disabled={saving || !nameChanged}>
              {saving ? "שומר..." : saved ? <><Check size={14} /> נשמר</> : "שמירה"}
            </button>
          </form>
          <p className="account-stats">
            {stats.itemCount} פריטים · {stats.looksCount} לוקים · {stats.packedCount} מזוודות
          </p>
        </section>

        {/* 2. Model photo */}
        <section className="account-section" aria-labelledby="account-model-title">
          <h3 id="account-model-title">תמונת מודל</h3>
          <div className="account-row">
            <div className="account-model-thumb">
              {modelRefUrl ? <img src={modelRefUrl} alt="תמונת המודל הנוכחית" /> : <User size={22} aria-hidden="true" />}
            </div>
            <p className="account-hint">
              {hasModelRef
                ? "התמונה שעליה מלבישים את הבגדים והלוקים."
                : "העלי תמונת גוף מלא שלך, כדי שאפשר יהיה להלביש עלייך את הבגדים."}
            </p>
            <input
              ref={modelInputRef}
              type="file"
              accept="image/*,.heic,.heif"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUploadModelRef?.(file);
                e.target.value = "";
              }}
            />
            <button className="secondary-button" type="button" onClick={() => modelInputRef.current?.click()} disabled={uploadingModelRef}>
              {uploadingModelRef ? "מעלה..." : hasModelRef ? "החלפה" : "העלאה"}
            </button>
          </div>
        </section>

        {/* 3. Phone */}
        <section className="account-section" aria-labelledby="account-phone-title">
          <h3 id="account-phone-title">פתיחה בטלפון</h3>
          <ol className="account-steps">
            <li>פתחי בטלפון את הקישור של האתר.</li>
            <li>היכנסי עם הסיסמה של האתר.</li>
            <li>בתפריט השיתוף של הדפדפן בחרי "הוספה למסך הבית".</li>
          </ol>
          <button type="button" className="secondary-button" onClick={handleCopyLink}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? "הקישור הועתק" : "העתקת הקישור"}</span>
          </button>
        </section>

        {/* 4. Extra wardrobes (rarely needed, so collapsed) */}
        <details className="account-section account-more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
          <summary>ארונות נוספים</summary>
          <p className="account-hint">
            ארון נוסף הוא מלתחה נפרדת באותו אתר, למשל לבת משפחה. לכל ארון יש בגדים, לוקים ותמונת מודל משלו.
            כל מי שיודע את סיסמת האתר יכול לפתוח את כל הארונות.
          </p>

          {otherWardrobes.length > 0 && (
            <ul className="account-wardrobes">
              {otherWardrobes.map((w) => (
                <li key={w.id}>
                  <span className="account-wardrobe-name">
                    {w.name || w.id}
                    <span className="account-hint"> · {w.itemCount ?? 0} פריטים</span>
                  </span>
                  <button type="button" className="secondary-button" onClick={() => onSwitchWardrobe(w.id)}>
                    <ArrowsLeftRight size={14} /> מעבר
                  </button>
                  {!w.isDefault && (
                    <button
                      type="button"
                      className="import-icon-button"
                      aria-label={`מחיקת הארון ${w.name || w.id}`}
                      onClick={() => {
                        if (window.confirm(`למחוק את הארון "${w.name || w.id}" וכל מה שבו? אי אפשר לבטל את זה.`)) onDeleteWardrobe(w.id);
                      }}
                    >
                      <Trash size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form className="account-row" onSubmit={handleCreateWardrobe}>
            <input
              className="account-input"
              type="text"
              aria-label="שם לארון חדש"
              placeholder="שם לארון חדש"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="secondary-button" type="submit" disabled={creating || !newName.trim()}>
              <Plus size={14} /> {creating ? "יוצר..." : "יצירה"}
            </button>
          </form>
          {createError && <p className="account-error" role="alert">{createError}</p>}
        </details>

        <footer className="account-footer">
          <button type="button" className="delete-button" onClick={handleLogout}>התנתקות</button>
        </footer>
      </div>
    </div>
  );
}

function SuitcaseFlatlayModal({ data, onClose, onSaveAsOutfit }) {
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveAsOutfit(data);
      onClose();
    } catch {} finally {
      setSaving(false);
    }
  };

  return (
    <div className="builder-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="builder-modal" style={{ maxWidth: "620px", padding: "26px" }}>
        <header className="builder-header" style={{ marginBottom: "16px" }}>
          <div>
            <span style={{ fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent)", fontWeight: "600" }}>
              פריסת מזוודה
            </span>
            <h2 style={{ margin: "4px 0 0", fontSize: "20px" }}>{data.title || "פריסת פריטים למזוודה"}</h2>
          </div>
          <button className="import-icon-button" type="button" onClick={onClose} aria-label="סגור">
            <X size={20} />
          </button>
        </header>

        <div style={{ width: "100%", maxHeight: "72vh", overflowY: "auto", borderRadius: "4px", marginBottom: "16px", border: "1px solid var(--line)", background: "#f8f6f2", display: "flex", alignItems: "center", justifyContent: "center", padding: "8px" }}>
          <img src={data.image} alt={data.title} style={{ maxWidth: "100%", height: "auto", maxHeight: "68vh", objectFit: "contain", borderRadius: "2px" }} />
        </div>

        <div style={{ marginBottom: "16px" }}>
          <span style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "var(--muted)", marginBottom: "6px" }}>
            פריטים שנפרסו במזוודה ({data.items?.length || 0})
          </span>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {data.items?.map((item) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "5px", background: "var(--paper)", border: "1px solid var(--line)", padding: "3px 8px", borderRadius: "3px", fontSize: "12px" }}>
                <img src={item.thumbnail || item.image} alt="" style={{ width: "20px", height: "20px", objectFit: "contain" }} />
                <span>{item.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", borderTop: "1px solid var(--line)", paddingTop: "14px" }}>
          <button className="secondary-button" type="button" onClick={onClose}>
            סגור
          </button>
          <button className="primary-button" type="button" disabled={saving} onClick={handleSave} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <FloppyDisk size={16} />
            <span>{saving ? "שומר..." : "שמירה כלוק מזוודה"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function CustomOutfitModal({ items, initialItemIds = [], initialMode = "flatlay", onClose, onCreated }) {
  const [outfitMode, setOutfitMode] = useState(initialMode || "flatlay");
  const [selectedIds, setSelectedIds] = useState(() => [...initialItemIds]);
  const [outfitNotes, setOutfitNotes] = useState("");
  const [lookName, setLookName] = useState("");
  const [activeFilterTab, setActiveFilterTab] = useState("all");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completingAI, setCompletingAI] = useState(false);
  const [aiExplanation, setAiExplanation] = useState("");
  const [builderError, setBuilderError] = useState("");
  const [generatedLook, setGeneratedLook] = useState(null);

  useEffect(() => {
    if (initialMode) setOutfitMode(initialMode);
  }, [initialMode]);

  const selectedItems = useMemo(() => {
    return selectedIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
  }, [selectedIds, items]);

  const toggleItem = (id) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
    setBuilderError("");
    setAiExplanation("");
  };

  const removeSelectedItem = (id) => {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  };

  const clearAll = () => {
    setSelectedIds([]);
    setGeneratedLook(null);
    setBuilderError("");
    setAiExplanation("");
  };

  const handleCompleteWithAI = async () => {
    setCompletingAI(true);
    setBuilderError("");
    setAiExplanation("");
    try {
      const res = await fetch("/api/import/outfits/ai-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedGarmentIds: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בהשלמת הלוק");
      if (data.recommendedGarmentIds?.length) {
        setSelectedIds((prev) => {
          const next = [...prev];
          for (const id of data.recommendedGarmentIds) {
            if (!next.includes(id)) next.push(id);
          }
          return next;
        });
        setAiExplanation(data.explanation || "נבחרו פריטים מתאימים מהמלתחה.");
      } else {
        setAiExplanation(data.explanation || "הבחירה שלך מאוזנת.");
      }
    } catch (err) {
      setBuilderError(err.message || "לא ניתן להשלים את הלוק כרגע");
    } finally {
      setCompletingAI(false);
    }
  };

  const displayedWardrobeItems = useMemo(() => {
    if (activeFilterTab === "all") return items;
    return items.filter((item) => {
      if (activeFilterTab === "dress") return item.part === "dress" || item.part === "wholebody";
      if (activeFilterTab === "wholebody_up") return item.part === "wholebody_up" || item.part === "outerwear" || item.part === "jacket";
      return item.part === activeFilterTab;
    });
  }, [items, activeFilterTab]);

  const handleGenerate = async () => {
    if (!selectedIds.length) {
      setBuilderError("אנא בחרו לפחות פריט אחד.");
      return;
    }
    setGenerating(true);
    setBuilderError("");
    try {
      const res = await fetch("/api/import/outfits/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lookName.trim() || undefined,
          garmentIds: selectedIds,
          notes: outfitNotes.trim() || undefined,
          mode: outfitMode,
          noModel: outfitMode === "flatlay",
          settingDirection: "a warm, natural daylight setting with minimalist architecture",
          save: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה ביצירת לוק");
      setGeneratedLook(data);
      if (!lookName.trim() && data.name) {
        setLookName(data.name);
      }
    } catch (err) {
      setBuilderError(err.message || "שגיאה ביצירת לוק");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!selectedIds.length) {
      setBuilderError("אנא בחרו לפחות פריט אחד.");
      return;
    }
    setSaving(true);
    setBuilderError("");
    try {
      const payload = generatedLook
        ? {
            ...generatedLook,
            name: lookName.trim() || generatedLook.name,
            notes: outfitNotes.trim() || generatedLook.notes,
            mode: outfitMode,
          }
        : {
            name: lookName.trim() || selectedItems.map((i) => i.name).join(" + "),
            garmentIds: selectedIds,
            notes: outfitNotes.trim() || undefined,
            mode: outfitMode,
            setting: "a warm, natural daylight setting with minimalist architecture",
            image: selectedItems[0]?.thumbnail || selectedItems[0]?.image || "",
          };

      const res = await fetch("/api/import/outfits/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outfit: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בשמירת לוק");
      onCreated?.(data);
      onClose();
    } catch (err) {
      setBuilderError(err.message || "שגיאה בשמירת לוק");
    } finally {
      setSaving(false);
    }
  };

  const categoryTabs = [
    { id: "all", label: "הכל" },
    { id: "upperbody", label: "חולצות" },
    { id: "lowerbody", label: "מכנסיים" },
    { id: "dress", label: "שמלות" },
    { id: "wholebody_up", label: "עליוניות" },
    { id: "shoes", label: "נעליים" },
    { id: "accessories_up", label: "אקססוריז" },
  ];

  return (
    <div className="builder-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="builder-modal custom-outfit-modal">
        <header className="builder-header">
          <div>
            <h2>יצירת לוק אישי</h2>
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--muted)" }}>
              {outfitMode === "flatlay" ? "פריסה אנכית ללא מודל: חולצה, מתחת מכנסיים, ומתחת נעליים" : "הדמיית הלוק כפי שנלבש על גבי המודל"}
            </p>
          </div>
          <button className="import-icon-button" type="button" onClick={onClose} aria-label="סגור">
            <X size={20} />
          </button>
        </header>

        {/* MODE SELECTOR */}
        <div className="outfit-mode-selector">
          <button
            type="button"
            className={`outfit-mode-tab${outfitMode === "flatlay" ? " active" : ""}`}
            onClick={() => {
              setOutfitMode("flatlay");
              setGeneratedLook(null);
            }}
          >
            <strong>לוק ללא מודל (פריסה שטוחה)</strong>
            <span>חולצה ומתחת מכנסיים ומתחת נעליים – כמו על גוף אבל בלי אדם</span>
          </button>
          <button
            type="button"
            className={`outfit-mode-tab${outfitMode === "modeled" ? " active" : ""}`}
            onClick={() => {
              setOutfitMode("modeled");
              setGeneratedLook(null);
            }}
          >
            <strong>לוק על מודל</strong>
            <span>הדמיה מעוצבת של הפריטים על גבי המודל</span>
          </button>
        </div>

        {/* SELECTED PIECES TRAY */}
        <section style={{ marginBottom: "16px", padding: "12px 14px", background: "rgba(25, 24, 22, 0.02)", border: "1px solid var(--line)", borderRadius: "4px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: selectedItems.length ? "8px" : "0", flexWrap: "wrap", gap: "8px" }}>
            <span style={{ fontSize: "11px", fontWeight: "600", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink)" }}>
              פריטים שנבחרו ({selectedItems.length})
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                className="secondary-button"
                disabled={completingAI || generating}
                onClick={handleCompleteWithAI}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  fontSize: "12px",
                  padding: "4px 10px",
                  borderRadius: "14px",
                  border: "1px solid var(--accent)",
                  color: "var(--accent)",
                  background: "rgba(110, 48, 46, 0.05)",
                }}
              >
                {completingAI ? <ArrowClockwise size={13} className="spin" /> : <MagicWand size={13} />}
                <span>{completingAI ? "משלים..." : "השלם עם AI"}</span>
              </button>

              {selectedItems.length > 0 && (
                <button
                  type="button"
                  style={{ background: "none", border: "none", fontSize: "11px", color: "var(--muted)", cursor: "pointer", textDecoration: "underline" }}
                  onClick={clearAll}
                >
                  נקה הכל
                </button>
              )}
            </div>
          </div>

          {aiExplanation && (
            <div style={{ marginBottom: "8px", padding: "6px 10px", background: "rgba(110, 48, 46, 0.06)", borderRight: "3px solid var(--accent)", borderRadius: "2px", fontSize: "12px", color: "var(--ink)" }}>
              {aiExplanation}
            </div>
          )}

          {selectedItems.length > 0 && (
            <div className="selected-pieces-tray">
              {selectedItems.map((item) => (
                <div key={item.id} className="selected-piece-badge">
                  <img src={item.thumbnail || item.image} alt={item.name} />
                  <div>
                    <strong style={{ display: "block", fontSize: "12px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {item.name}
                    </strong>
                    <span style={{ fontSize: "10px", color: "var(--muted)" }}>{TYPE_MAP[item.part]?.singular || item.part}</span>
                  </div>
                  <button type="button" onClick={() => removeSelectedItem(item.id)} aria-label={`הסר ${item.name}`}>
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* OUTFIT NOTES */}
        <section style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--ink)", marginBottom: "6px" }}>
            הערות סטיילינג (אופציונלי)
          </label>
          <textarea
            value={outfitNotes}
            onChange={(e) => setOutfitNotes(e.target.value)}
            placeholder="לדוגמה: להשאיר את הז'קט פתוח, להכניס חולצה למכנסיים..."
            rows={2}
            style={{ width: "100%", padding: "8px 10px", fontSize: "13px", border: "1px solid var(--line)", borderRadius: "3px", background: "transparent", color: "var(--ink)", resize: "vertical", fontFamily: "inherit" }}
          />
        </section>

        {/* GENERATED PREVIEW */}
        {generatedLook && (
          <div className="generated-look-card">
            <div className="generated-look-photo-wrap">
              <img className="generated-look-photo" src={generatedLook.image} alt={generatedLook.name} />
            </div>
            <div className="generated-look-info">
              <div>
                <span style={{ fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--accent)" }}>
                  תצוגה מקדימה
                </span>
                <h3 style={{ margin: "4px 0 6px", fontSize: "17px" }}>{generatedLook.name}</h3>
                {outfitNotes && (
                  <p style={{ fontSize: "12px", fontStyle: "italic", color: "var(--muted)", margin: "0 0 8px" }}>
                    הערות: "{outfitNotes}"
                  </p>
                )}
                <div>
                  <span style={{ display: "block", fontSize: "10px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", marginBottom: "6px" }}>
                    פריטים ({selectedItems.length})
                  </span>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {selectedItems.map((g) => (
                      <div key={g.id} style={{ display: "flex", alignItems: "center", gap: "5px", background: "var(--paper)", border: "1px solid var(--line)", padding: "3px 6px", borderRadius: "3px", fontSize: "11px" }}>
                        <img src={g.thumbnail || g.image} alt="" style={{ width: "18px", height: "18px", objectFit: "contain" }} />
                        <span>{g.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VISUAL WARDROBE GALLERY */}
        <section className="builder-section">
          {/* Filter tabs */}
          <div className="builder-filter-tabs">
            {categoryTabs.map((tab) => {
              const count = tab.id === "all"
                ? items.length
                : items.filter((i) => {
                    if (tab.id === "dress") return i.part === "dress" || i.part === "wholebody";
                    if (tab.id === "wholebody_up") return i.part === "wholebody_up" || i.part === "outerwear" || i.part === "jacket";
                    return i.part === tab.id;
                  }).length;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`builder-filter-tab${activeFilterTab === tab.id ? " active" : ""}`}
                  onClick={() => setActiveFilterTab(tab.id)}
                >
                  {tab.label} ({count})
                </button>
              );
            })}
          </div>

          {displayedWardrobeItems.length ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: "10px", maxHeight: "240px", overflowY: "auto", padding: "4px" }}>
              {displayedWardrobeItems.map((item) => {
                const isSelected = selectedIds.includes(item.id);

                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`builder-item-choice${isSelected ? " is-selected" : ""}`}
                    onClick={() => toggleItem(item.id)}
                    style={{
                      width: "100%",
                      height: "125px",
                      position: "relative",
                      border: isSelected ? "2px solid var(--accent)" : "1px solid var(--line)",
                      background: isSelected ? "rgba(110, 48, 46, 0.06)" : "transparent",
                    }}
                  >
                    {isSelected && (
                      <span style={{ position: "absolute", top: "5px", left: "5px", background: "var(--accent)", color: "white", borderRadius: "50%", width: "18px", height: "18px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: "bold" }}>
                        ✓
                      </span>
                    )}
                    <span style={{ position: "absolute", top: "5px", right: "5px", fontSize: "10px", background: "rgba(25, 24, 22, 0.05)", padding: "1px 5px", borderRadius: "2px", color: "var(--muted)" }}>
                      {TYPE_MAP[item.part]?.singular || item.part}
                    </span>
                    <img src={item.thumbnail || item.image} alt={item.name} style={{ width: "56px", height: "56px", objectFit: "contain", marginTop: "14px", marginBottom: "4px" }} />
                    <span style={{ fontSize: "11px", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: "1.2", padding: "0 2px" }}>
                      {item.name}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p style={{ fontSize: "12px", color: "var(--muted)", margin: "16px 0", textAlign: "center" }}>
              אין פריטים בקטגוריה זו.
            </p>
          )}
        </section>

        {/* OPTIONAL NAME */}
        <div style={{ marginTop: "12px" }}>
          <input
            type="text"
            value={lookName}
            onChange={(e) => setLookName(e.target.value)}
            placeholder="שם הלוק (אופציונלי)"
            style={{ width: "100%", padding: "7px 10px", fontSize: "13px", border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", borderRadius: "3px" }}
          />
        </div>

        {builderError && <p style={{ color: "var(--accent)", fontSize: "13px", margin: "10px 0 0" }}>{builderError}</p>}

        {/* ACTIONS - SINGLE OCCURRENCE, NO STARS */}
        <div className="builder-actions" style={{ marginTop: "18px" }}>
          <button className="secondary-button" type="button" disabled={generating || saving} onClick={onClose}>
            ביטול
          </button>
          {!generatedLook ? (
            <button
              className="primary-button"
              type="button"
              disabled={!selectedIds.length || generating}
              onClick={handleGenerate}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
            >
              {generating && <ArrowClockwise size={16} className="spin" />}
              <span>{generating ? "יוצר לוק..." : outfitMode === "flatlay" ? "צור פריסת לוק (ללא מודל)" : "צור לוק על מודל"}</span>
            </button>
          ) : (
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={generating || saving}
                onClick={handleGenerate}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                {generating && <ArrowClockwise size={16} className="spin" />}
                <span>{generating ? "יוצר..." : "צור מחדש"}</span>
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={saving || generating}
                onClick={handleSave}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                <FloppyDisk size={16} />
                <span>{saving ? "שומר..." : "שמור לוק"}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AutoOutfitsModal({ onClose, onCreated }) {
  const [count, setCount] = useState(1);
  const [occasion, setOccasion] = useState("everyday");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const handleAutoGenerate = async () => {
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/import/outfits/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count,
          occasion,
          settingDirection: "a quiet warm-stone courtyard with restrained greenery",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה ביצירת לוקים");
      onCreated?.(Array.isArray(data) ? data : [data]);
      onClose();
    } catch (err) {
      setError(err.message || "שגיאה ביצירת לוקים");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="builder-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="builder-modal" style={{ maxWidth: "460px" }}>
        <header className="builder-header">
          <h2>יצירה אוטומטית של לוקים</h2>
          <button className="import-icon-button" type="button" onClick={onClose} aria-label="סגור">
            <X size={20} />
          </button>
        </header>

        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--muted)", marginBottom: "8px" }}>
            מספר לוקים
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            {[1, 2, 3, 4].map((num) => (
              <button
                key={num}
                type="button"
                className={`secondary-button${count === num ? " is-active" : ""}`}
                style={{
                  flex: 1,
                  padding: "8px",
                  justifyContent: "center",
                  borderColor: count === num ? "var(--ink)" : "var(--line)",
                  background: count === num ? "var(--ink)" : "transparent",
                  color: count === num ? "var(--paper)" : "var(--ink)",
                  fontWeight: count === num ? "600" : "normal",
                }}
                onClick={() => setCount(num)}
              >
                {num}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: "20px" }}>
          <label style={{ display: "block", fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--muted)", marginBottom: "8px" }}>
            סגנון (אופציונלי)
          </label>
          <select
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", fontSize: "13px", border: "1px solid var(--line)", background: "var(--paper)", color: "var(--ink)", borderRadius: "3px" }}
          >
            <option value="everyday">יומיומי</option>
            <option value="smart-casual">סמארט קז'ואל</option>
            <option value="weekend">סוף שבוע</option>
            <option value="night-out">ערב</option>
          </select>
        </div>

        {error && <p style={{ color: "var(--accent)", fontSize: "13px", margin: "0 0 16px" }}>{error}</p>}

        <div className="builder-actions">
          <button className="secondary-button" type="button" disabled={generating} onClick={onClose}>
            ביטול
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={generating}
            onClick={handleAutoGenerate}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            {generating && <ArrowClockwise size={16} className="spin" />}
            <span>{generating ? "יוצר לוקים..." : "צור לוקים"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [items, setItems] = useState([]);
  const [outfits, setOutfits] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [selectedLook, setSelectedLook] = useState(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderMode, setBuilderMode] = useState("flatlay");
  const [autoModalOpen, setAutoModalOpen] = useState(false);
  const [builderInitialItems, setBuilderInitialItems] = useState([]);
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState([]);
  const [packingIds, setPackingIds] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hasModelRef, setHasModelRef] = useState(false);
  const [modelRefUrl, setModelRefUrl] = useState(null);
  const [uploadingModelRef, setUploadingModelRef] = useState(false);
  const modelFileInputRef = useRef(null);

  // Multi-wardrobe state
  const [activeWardrobeId, setActiveWardrobeId] = useState(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("wardrobe") || params.get("wardrobeId");
      if (fromUrl) {
        localStorage.setItem(ACTIVE_WARDROBE_KEY, fromUrl);
        return fromUrl;
      }
      const cached = localStorage.getItem(ACTIVE_WARDROBE_KEY);
      if (cached) return cached;
    }
    return "user-shani";
  });
  const [wardrobesList, setWardrobesList] = useState([]);

  // Personal user profile & account state
  const [currentUser, setCurrentUser] = useState({
    id: "user-shani",
    name: "שני אסולין",
    email: "shaniiassulin@gmail.com",
    avatar: null,
  });
  const [userModalOpen, setUserModalOpen] = useState(false);

  // Suitcases (one per event or trip), saved on the server
  const [suitcases, setSuitcases] = useState([]);
  const [activeSuitcaseId, setActiveSuitcaseId] = useState(null);
  const [luggageFlatlayModalOpen, setLuggageFlatlayModalOpen] = useState(false);
  const [luggageFlatlayData, setLuggageFlatlayData] = useState(null);

  const fetchWardrobesList = useCallback(async () => {
    try {
      const res = await fetch("/api/import/wardrobes");
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) setWardrobesList(list);
      }
    } catch {}
  }, []);

  const fetchWardrobe = useCallback(async () => {
    try {
      const response = await fetch(`/api/import/wardrobe?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        cache: "no-store",
        headers: { "x-wardrobe-id": activeWardrobeId },
      });
      if (!response.ok) throw new Error("Could not load the wardrobe.");
      const loadedItems = await response.json();
      if (Array.isArray(loadedItems)) {
        setItems(loadedItems);
      }
      setError("");
    } catch (requestError) {
      // transient network error, keep current items
    } finally {
      setLoading(false);
    }
  }, [activeWardrobeId]);

  const fetchSuitcases = useCallback(async () => {
    try {
      const r = await fetch(`/api/import/suitcases?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        headers: { "x-wardrobe-id": activeWardrobeId },
      });
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list)) {
          setSuitcases([...list].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))));
        }
      }
    } catch {}
  }, [activeWardrobeId]);

  const fetchOutfits = useCallback(async () => {
    try {
      const res = await fetch(`/api/import/outfits?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        headers: { "x-wardrobe-id": activeWardrobeId },
      });
      if (res.ok) {
        const data = await res.json();
        setOutfits(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, [activeWardrobeId]);

  const fetchUserProfile = useCallback(async () => {
    try {
      const res = await fetch(`/api/import/user?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        headers: { "x-wardrobe-id": activeWardrobeId },
      });
      if (res.ok) {
        const u = await res.json();
        if (u?.name) setCurrentUser(u);
      }
    } catch {}
  }, [activeWardrobeId]);

  useEffect(() => {
    fetchWardrobesList();
  }, [fetchWardrobesList]);

  useEffect(() => {
    // Initial fetch for the active wardrobe
    fetchWardrobe();
    fetchSuitcases();
    fetchOutfits();
    fetchUserProfile();

    // Auto-sync across devices: poll while visible and whenever the tab becomes active.
    // Kept infrequent because every request counts toward the hosting quota.
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fetchWardrobe();
      fetchSuitcases();
      fetchOutfits();
    }, 20000);

    const onSync = () => {
      fetchWardrobe();
      fetchSuitcases();
      fetchOutfits();
      fetchUserProfile();
      fetchWardrobesList();
    };

    window.addEventListener("focus", onSync);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onSync();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onSync);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeWardrobeId, fetchWardrobe, fetchSuitcases, fetchOutfits, fetchUserProfile, fetchWardrobesList]);

  const handleSwitchWardrobe = useCallback((newId) => {
    if (!newId || newId === activeWardrobeId) return;
    setActiveWardrobeId(newId);
    if (typeof window !== "undefined") {
      localStorage.setItem(ACTIVE_WARDROBE_KEY, newId);
      const url = new URL(window.location);
      if (newId === "user-shani") {
        url.searchParams.delete("wardrobe");
        url.searchParams.delete("wardrobeId");
      } else {
        url.searchParams.set("wardrobe", newId);
      }
      window.history.replaceState({}, "", url);
    }
  }, [activeWardrobeId]);

  const handleConnectOrNewWardrobe = useCallback(async ({ email, name }) => {
    const res = await fetch("/api/import/wardrobes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name }),
    });
    const data = await res.json();
    if (!res.ok || !data.wardrobe?.id) {
      throw new Error(data.error || "שגיאה בחיבור לארון");
    }
    const newId = data.wardrobe.id;
    setActiveWardrobeId(newId);
    if (typeof window !== "undefined") {
      localStorage.setItem(ACTIVE_WARDROBE_KEY, newId);
      const url = new URL(window.location);
      url.searchParams.set("wardrobe", newId);
      window.history.replaceState({}, "", url);
    }
    await fetchWardrobesList();
    return data.wardrobe;
  }, [fetchWardrobesList]);

  const handleDeleteWardrobe = useCallback(async (idToDelete) => {
    const res = await fetch(`/api/import/wardrobes/${encodeURIComponent(idToDelete)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      await fetchWardrobesList();
      if (activeWardrobeId === idToDelete) {
        handleSwitchWardrobe("user-shani");
      }
    }
  }, [activeWardrobeId, fetchWardrobesList, handleSwitchWardrobe]);

  useEffect(() => {
    fetch(`/api/import/config?wardrobe=${encodeURIComponent(activeWardrobeId)}`, {
      headers: { "x-wardrobe-id": activeWardrobeId },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.hasModelReference) {
          setHasModelRef(true);
          setModelRefUrl(`/api/import/model-reference?t=${Date.now()}&wardrobe=${encodeURIComponent(activeWardrobeId)}`);
        } else {
          setHasModelRef(false);
          setModelRefUrl(null);
        }
      })
      .catch(() => {});
  }, [activeWardrobeId]);

  const compressImageForUpload = async (file, maxDimension = 1200, quality = 0.82) => {
    if (!file) throw new Error("לא נבחר קובץ תמונה");

    // Method 1: Modern createImageBitmap (fast on mobile, automatic EXIF orientation, low memory)
    if (typeof window !== "undefined" && typeof window.createImageBitmap === "function") {
      try {
        const bitmap = await window.createImageBitmap(file);
        let { width, height } = bitmap;
        if (width && height) {
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0, width, height);
            const dataUrl = canvas.toDataURL("image/jpeg", quality);
            if (dataUrl && dataUrl.startsWith("data:image/jpeg")) {
              return dataUrl;
            }
          }
        }
      } catch (bitmapErr) {
        console.warn("createImageBitmap failed, falling back to Image:", bitmapErr);
      }
    }

    // Method 2: HTML Image element
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          try {
            if (width > maxDimension || height > maxDimension) {
              if (width > height) {
                height = Math.round((height * maxDimension) / width);
                width = maxDimension;
              } else {
                width = Math.round((width * maxDimension) / height);
                height = maxDimension;
              }
            }
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(img, 0, 0, width, height);
              const result = canvas.toDataURL("image/jpeg", quality);
              URL.revokeObjectURL(url);
              resolve(result);
              return;
            }
          } catch (e) {
            console.warn("Canvas draw failed:", e);
          }
          URL.revokeObjectURL(url);
          fallbackFileReader(file).then(resolve).catch(reject);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          fallbackFileReader(file).then(resolve).catch(reject);
        };
        img.src = url;
      });
      if (dataUrl) return dataUrl;
    } catch {
      // Fall through to fallback
    }

    // Method 3: Direct FileReader fallback
    return fallbackFileReader(file);
  };

  const fallbackFileReader = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("שגיאה בקריאת תוכן הקובץ"));
        }
      };
      reader.onerror = () => reject(new Error("לא ניתן לקרוא קובץ תמונה זה במכשיר"));
      reader.readAsDataURL(file);
    });
  };

  const handleUploadModelRef = async (file) => {
    if (!file) return;
    setUploadingModelRef(true);
    setError("");
    try {
      if (file.size > 35 * 1024 * 1024) {
        throw new Error("קובץ התמונה גדול מדי (מעל 35MB). מומלץ לבחור תמונה רגילה מהגלריה.");
      }
      const imageDataUrl = await compressImageForUpload(await toBrowserImage(file), 1200, 0.82);
      const res = await fetch("/api/import/model-reference", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wardrobe-id": activeWardrobeId,
        },
        body: JSON.stringify({ imageDataUrl }),
      });
      let data = {};
      const responseText = await res.text();
      try {
        data = JSON.parse(responseText);
      } catch {
        data = {};
      }
      if (res.ok) {
        setHasModelRef(true);
        setModelRefUrl(`/api/import/model-reference?t=${Date.now()}&wardrobe=${encodeURIComponent(activeWardrobeId)}`);
        fetchWardrobe();
      } else {
        setError(data.error || "שגיאה בהעלאת תמונת מודל. נסו שוב או בחרו תמונה אחרת.");
      }
    } catch (err) {
      console.error("Upload model error:", err);
      const msg = err?.message || "";
      const isPatternError = msg.includes("pattern") || msg.includes("מחרוזת");
      if (isPatternError) {
        setError("מערכת ההפעלה של הנייד חסמה את הפורמט של התמונה. מומלץ לבחור תמונה רגילה מהגלריה (JPG/PNG).");
      } else {
        setError(msg || "שגיאה בהעלאת תמונת מודל");
      }
    } finally {
      setUploadingModelRef(false);
    }
  };

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    if (activeType === "looks" || activeType === "luggage") return [];
    const filtered = activeType === "all"
      ? items
      : items.filter((item) => {
          if (activeType === "dress") return item.part === "dress" || item.part === "wholebody";
          if (activeType === "wholebody_up") return item.part === "wholebody_up" || item.part === "outerwear" || item.part === "jacket";
          return item.part === activeType;
        });
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
  };

  const saveSuitcase = (suitcase) => {
    const saved = { ...suitcase, garmentIds: [...new Set(suitcase.garmentIds || [])] };
    setSuitcases((current) => current.some((s) => s.id === saved.id) ? current.map((s) => (s.id === saved.id ? saved : s)) : [...current, saved]);
    fetch(`/api/import/suitcases?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
      body: JSON.stringify(saved),
    }).catch(() => setError("לא ניתן לשמור את המזוודה כרגע."));
  };

  const createSuitcase = (title, garmentIds = []) => {
    const suitcase = { id: newSuitcaseId(), title, garmentIds, createdAt: new Date().toISOString() };
    saveSuitcase(suitcase);
    setActiveSuitcaseId(suitcase.id);
    return suitcase;
  };

  const addToSuitcase = (id, itemIds) => {
    const suitcase = suitcases.find((s) => s.id === id);
    if (suitcase) saveSuitcase({ ...suitcase, garmentIds: [...(suitcase.garmentIds || []), ...itemIds] });
  };

  const removeFromSuitcase = (id, itemIds) => {
    const suitcase = suitcases.find((s) => s.id === id);
    if (suitcase) saveSuitcase({ ...suitcase, garmentIds: (suitcase.garmentIds || []).filter((x) => !itemIds.includes(x)) });
  };

  const toggleInSuitcase = (id, itemId) => {
    const suitcase = suitcases.find((s) => s.id === id);
    if (!suitcase) return;
    if (suitcase.garmentIds?.includes(itemId)) removeFromSuitcase(id, [itemId]);
    else addToSuitcase(id, [itemId]);
  };

  const deleteSuitcase = (id) => {
    setSuitcases((current) => current.filter((s) => s.id !== id));
    if (activeSuitcaseId === id) setActiveSuitcaseId(null);
    fetch(`/api/import/suitcases/${encodeURIComponent(id)}?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "DELETE",
      headers: { "x-wardrobe-id": activeWardrobeId },
    }).catch(() => {});
  };

  const openLookBuilder = (itemIds, mode = "flatlay") => {
    setBuilderInitialItems(itemIds);
    setBuilderMode(mode);
    setBuilderOpen(true);
  };

  const toggleChecked = (id) => setCheckedIds((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  const exitSelectMode = () => { setSelectMode(false); setCheckedIds([]); };

  const handleLuggageFlatlay = async (packedPieces, suitcase) => {
    if (!packedPieces.length) return;
    try {
      const res = await fetch(`/api/import/outfits/preview-flatlay?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
        body: JSON.stringify({ garmentIds: packedPieces.map((i) => i.id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה ביצירת פריסה");
      setLuggageFlatlayData({
        title: suitcase?.title ? `פריסת המזוודה: ${suitcase.title}` : "פריסת מלתחה למזוודה",
        image: data.image,
        items: packedPieces,
      });
      setLuggageFlatlayModalOpen(true);
    } catch (err) {
      setError(err.message || "שגיאה ביצירת פריסת מזוודה");
    }
  };

  const handleSaveLuggageOutfit = async (flatlayData) => {
    const payload = {
      name: flatlayData.title?.replace("פריסת המזוודה: ", "") || "לוק ארוז למזוודה",
      garmentIds: flatlayData.items.map((i) => i.id),
      mode: "flatlay",
      image: flatlayData.image,
      notes: "לוק של כל הפריטים הארוזים במזוודה לנסיעה",
    };
    const res = await fetch(`/api/import/outfits/save?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
      body: JSON.stringify({ outfit: payload }),
    });
    if (res.ok) {
      const created = await res.json();
      setOutfits((current) => [created, ...current]);
    }
  };

  const handleSaveUser = async (profileData) => {
    const res = await fetch(`/api/import/user?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
      body: JSON.stringify(profileData),
    });
    if (res.ok) {
      const updated = await res.json();
      setCurrentUser(updated);
      fetchWardrobesList();
    }
  };

  const saveItem = async (updatedItem) => {
    setItems((current) => current.map((item) => (item.id === updatedItem.id ? updatedItem : item)));
    try {
      await fetch(`/api/import/wardrobe/${updatedItem.id}?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
        body: JSON.stringify(updatedItem),
      });
      await fetch(`/api/import/user/sync?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
        body: JSON.stringify({ lastUpdatedItem: updatedItem.id }),
      });
      fetchWardrobe();
    } catch {}
  };

  const deleteItem = async (id) => {
    setItems((current) => current.filter((item) => item.id !== id));
    setSelectedId(null);
    try {
      await fetch(`/api/import/wardrobe/${id}?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        method: "DELETE",
        headers: { "x-wardrobe-id": activeWardrobeId },
      });
      await fetch(`/api/import/user/sync?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
        body: JSON.stringify({ lastDeletedItem: id }),
      });
      fetchWardrobe();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const deleteOutfit = async (id) => {
    try {
      await fetch(`/api/import/outfits/${id}?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        method: "DELETE",
        headers: { "x-wardrobe-id": activeWardrobeId },
      });
      setOutfits((current) => current.filter((o) => o.id !== id));
    } catch {}
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => item.id === id ? { ...item, modeledImage } : item));
  }, []);

  return (
    <div className={`app-shell${selectedItem ? " has-selection" : ""}`}>
      <main className="gallery-pane">
        <header className="gallery-header">
          <div className="gallery-meta-row">
            <p className="piece-count">
              {activeType === "looks"
                ? `${outfits.length} ${outfits.length === 1 ? "לוק" : "לוקים"}`
                : activeType === "luggage"
                ? `${suitcases.length} ${suitcases.length === 1 ? "מזוודה" : "מזוודות"}`
                : `${items.length} ${items.length === 1 ? "פריט" : "פריטים"}`}
            </p>
            <div className="header-actions">
              <button
                type="button"
                className="user-account-header-btn"
                onClick={() => setUserModalOpen(true)}
                title="הארון שלי: שם, תמונת מודל, טלפון וארונות נוספים"
              >
                <span className="user-account-avatar">
                  {currentUser?.name ? currentUser.name.slice(0, 1) : "ש"}
                </span>
                <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", lineHeight: "1.15", textAlign: "right" }}>
                  <span style={{ fontSize: "12px", fontWeight: "600", color: "var(--ink)" }}>{currentUser?.name || "שני אסולין"}</span>
                  <span style={{ fontSize: "10px", color: "var(--muted)" }}>הארון שלי</span>
                </span>
                <CaretDown size={11} weight="bold" style={{ opacity: 0.6, marginInlineStart: "2px" }} />
                <span className="user-sync-indicator" title="מסונכרן עם השרת בזמן אמת" />
              </button>

              {activeType !== "looks" && activeType !== "luggage" && items.length > 0 && (
                <button
                  type="button"
                  className={`secondary-header-btn select-toggle${selectMode ? " is-active" : ""}`}
                  onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                  aria-pressed={selectMode}
                >
                  <CheckSquare size={16} aria-hidden="true" />
                  <span>{selectMode ? "סיום בחירה" : "בחירת פריטים"}</span>
                </button>
              )}

              {activeType === "looks" && (
                <>
                  <button
                    type="button"
                    className="create-look-btn"
                    onClick={() => openLookBuilder([], "flatlay")}
                  >
                    <span>לוק ללא מודל (פריסה שטוחה)</span>
                  </button>

                  <button
                    type="button"
                    className="secondary-header-btn"
                    onClick={() => openLookBuilder([], "modeled")}
                  >
                    <span>לוק על מודל</span>
                  </button>

                  <button
                    type="button"
                    className="create-auto-btn"
                    onClick={() => setAutoModalOpen(true)}
                  >
                    <span>יצירה אוטומטית</span>
                  </button>
                </>
              )}

              <input
                ref={modelFileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/jpg,image/heic,image/heif,image/*"
                hidden
                disabled={uploadingModelRef}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUploadModelRef(file);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className={`model-ref-btn${hasModelRef ? " is-active" : ""}`}
                disabled={uploadingModelRef}
                onClick={() => modelFileInputRef.current?.click()}
                title={hasModelRef ? "לחצי להחלפת תמונת מודל" : "העלאת תמונת מודל"}
              >
                {uploadingModelRef ? (
                  <ArrowClockwise size={16} className="spin" />
                ) : modelRefUrl ? (
                  <img src={modelRefUrl} alt="" className="model-ref-avatar" />
                ) : (
                  <User size={16} weight="regular" />
                )}
                <span>{uploadingModelRef ? "מעלה תמונה..." : hasModelRef ? "תמונת מודל ✓" : "העלאת תמונת מודל"}</span>
              </button>
            </div>
          </div>
          <nav className="category-nav" aria-label="סינון לפי קטגוריה">
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={activeType === type.id ? "active" : ""}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
              >
                {type.label}
              </button>
            ))}
          </nav>
        </header>

        {error && <p className="status error">{error}</p>}
        {!error && loading && <p className="status">טוען מלתחה...</p>}

        {/* LOOKS VIEW */}
        {activeType === "looks" && !loading && (
          <>
            {outfits.length > 0 ? (
              <section className="looks-grid" aria-label="לוקים מדוגמנים">
                {outfits.map((look) => (
                  <article
                    key={look.id}
                    className="look-card"
                    onClick={() => setSelectedLook(look)}
                  >
                    <div className="look-card__image-wrap">
                      <img className="look-card__image" src={look.image} alt={look.name} />
                    </div>
                    <div className="look-card__body">
                      <h3 className="look-card__title">{look.name}</h3>
                      {!!look.garments?.length && (
                        <div className="look-card__garments">
                          {look.garments.map((g) => (
                            <img key={g.id} className="look-card__garment-thumb" src={g.thumbnail} alt="" title={g.name} />
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </section>
            ) : (
              <div className="empty-wardrobe-container">
                <div className="empty-wardrobe-card">
                  <h2 className="empty-wardrobe-title">אין עדיין לוקים</h2>
                  <p className="empty-wardrobe-text">
                    השתמשו בכפתורים למעלה ליצירת לוק אישי או יצירה אוטומטית.
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        {/* LUGGAGE VIEW */}
        {activeType === "luggage" && (
          <LuggageView
            items={items}
            suitcases={suitcases}
            activeId={activeSuitcaseId}
            onSelect={setActiveSuitcaseId}
            onCreate={createSuitcase}
            onRename={(id, title) => { const suitcase = suitcases.find((s) => s.id === id); if (suitcase) saveSuitcase({ ...suitcase, title }); }}
            onDelete={deleteSuitcase}
            onToggleItem={toggleInSuitcase}
            onGenerateFlatlay={handleLuggageFlatlay}
            onOpenItem={setSelectedId}
            typeLabel={(part) => TYPE_MAP[part]?.singular || part}
          />
        )}

        {/* WARDROBE ITEMS VIEW */}
        {activeType !== "looks" && activeType !== "luggage" && !error && !loading && !items.length && (
          <div className="empty-wardrobe-container">
            <div className="empty-wardrobe-card">
              <h2 className="empty-wardrobe-title">המלתחה ריקה</h2>
              <p className="empty-wardrobe-text">
                העלו תמונות של פריטי לבוש כדי להתחיל לבנות את המלתחה.
              </p>
            </div>
          </div>
        )}

        {activeType !== "looks" && activeType !== "luggage" && !!items.length && (
          <section className="gallery-grid" aria-label={`פריטי מלתחה`}>
            {visibleItems.map((item) => (
              <GalleryItem
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                selectMode={selectMode}
                checked={checkedIds.includes(item.id)}
                onOpen={setSelectedId}
                onToggleSelect={toggleChecked}
              />
            ))}
          </section>
        )}
      </main>

      {selectMode && (
        <div className="selection-bar" role="region" aria-label="פעולות על הפריטים שנבחרו">
          <span className="selection-bar__count">{checkedIds.length ? `נבחרו ${checkedIds.length}` : "בחרי פריטים מהארון"}</span>
          <div className="selection-bar__actions">
            <button type="button" className="primary-button" disabled={!checkedIds.length} onClick={() => { openLookBuilder(checkedIds, "flatlay"); exitSelectMode(); }}>
              <MagicWand size={15} aria-hidden="true" /> לוק בפריסה
            </button>
            <button type="button" className="secondary-button" disabled={!checkedIds.length} onClick={() => { openLookBuilder(checkedIds, "modeled"); exitSelectMode(); }}>
              <User size={15} aria-hidden="true" /> לוק עליי (AI)
            </button>
            <button type="button" className="secondary-button" disabled={!checkedIds.length} onClick={() => setPackingIds(checkedIds)}>
              <Suitcase size={15} aria-hidden="true" /> למזוודה
            </button>
            <button type="button" className="import-icon-button" onClick={exitSelectMode} aria-label="ביטול הבחירה"><X size={18} /></button>
          </div>
        </div>
      )}

      {packingIds && (
        <SuitcasePicker
          suitcases={suitcases}
          itemIds={packingIds}
          onAdd={(id, ids) => addToSuitcase(id, ids)}
          onRemove={(id, ids) => removeFromSuitcase(id, ids)}
          onCreate={(title, ids) => createSuitcase(title, ids)}
          onClose={() => { setPackingIds(null); if (selectMode) exitSelectMode(); }}
        />
      )}

      {selectedItem && (
        <ItemViewer
          item={selectedItem}
          suitcaseCount={suitcases.filter((s) => s.garmentIds?.includes(selectedItem.id)).length}
          onPack={(id) => setPackingIds([id])}
          onCreateLook={(id) => { setSelectedId(null); openLookBuilder([id], "flatlay"); }}
          onClose={() => setSelectedId(null)}
          onSave={saveItem}
          onDelete={deleteItem}
          onModeledGenerated={(updatedItem) => {
            setItems((current) => current.map((i) => i.id === updatedItem.id ? updatedItem : i));
          }}
        />
      )}

      {userModalOpen && (
        <UserAccountModal
          user={currentUser}
          stats={{ itemCount: items.length, looksCount: outfits.length, packedCount: suitcases.length }}
          activeWardrobeId={activeWardrobeId}
          wardrobesList={wardrobesList}
          hasModelRef={hasModelRef}
          modelRefUrl={modelRefUrl}
          onUploadModelRef={handleUploadModelRef}
          uploadingModelRef={uploadingModelRef}
          onSaveUser={handleSaveUser}
          onSwitchWardrobe={handleSwitchWardrobe}
          onConnectOrNewWardrobe={handleConnectOrNewWardrobe}
          onDeleteWardrobe={handleDeleteWardrobe}
          onClose={() => setUserModalOpen(false)}
        />
      )}

      {luggageFlatlayModalOpen && luggageFlatlayData && (
        <SuitcaseFlatlayModal
          data={luggageFlatlayData}
          onClose={() => setLuggageFlatlayModalOpen(false)}
          onSaveAsOutfit={handleSaveLuggageOutfit}
        />
      )}

      {builderOpen && (
        <CustomOutfitModal
          items={items}
          initialItemIds={builderInitialItems}
          initialMode={builderMode}
          onClose={() => {
            setBuilderOpen(false);
            setBuilderInitialItems([]);
          }}
          onCreated={(newOutfit) => {
            setOutfits((current) => [newOutfit, ...current.filter((o) => o.id !== newOutfit.id)]);
            setActiveType("looks");
          }}
        />
      )}

      {autoModalOpen && (
        <AutoOutfitsModal
          onClose={() => setAutoModalOpen(false)}
          onCreated={(newOutfits) => {
            const list = Array.isArray(newOutfits) ? newOutfits : [newOutfits];
            setOutfits((current) => {
              const ids = new Set(list.map((o) => o.id));
              return [...list, ...current.filter((o) => !ids.has(o.id))];
            });
            setActiveType("looks");
          }}
        />
      )}

      {selectedLook && (
        <LookViewerModal
          look={selectedLook}
          onClose={() => setSelectedLook(null)}
          onDelete={deleteOutfit}
        />
      )}

      <WardrobeImportFlow key={activeWardrobeId} hidden={activeType === "looks" || selectMode || Boolean(selectedItem)} onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} />
    </div>
  );
}
