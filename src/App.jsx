import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, SlidersHorizontal } from "@phosphor-icons/react";
import { ArrowClockwise, ArrowCounterClockwise, ArrowsLeftRight, CaretDown, Check, CheckSquare, Copy, FloppyDisk, MagicWand, PencilSimple, Plus, Suitcase, Trash, User, X } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { fittedImage, imageFallback, thumbUrl, toBrowserImage } from "./image-files.js";
import { ImageLightbox } from "./ImageLightbox.jsx";
import { LuggageView, SuitcasePicker, newSuitcaseId } from "./Suitcases.jsx";
import { EMPTY_FILTERS, WardrobeFilters, matchesFilters } from "./WardrobeFilters.jsx";
import { PRICES, autoLooksPrice, lookOnModelPrice } from "./prices.js";
import { FitPicker } from "./FitPicker.jsx";
import { ArchiveView } from "./ArchiveView.jsx";
import { ChatGptHelper } from "./ChatGptHelper.jsx";
import { InspirationModal } from "./InspirationModal.jsx";
import { WishlistView } from "./WishlistView.jsx";
import { EMPTY_LOOK_FILTERS, LookFilters, eventLabel, lookEvents, matchesLookFilters } from "./LookFilters.jsx";
import { fitForPart, lengthOptions } from "./fit-options.js";
import { revealChildren, revealWords, startSmoothScroll, tiltHandlers, watchOverlays } from "./motion.js";

// Page heading whose words fade in from a soft blur
function AnimatedTitle({ text }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    revealWords(ref.current?.querySelectorAll(".animated-title__word"));
  }, [text]);
  return (
    <h1 className="animated-title" ref={ref} aria-label={text}>
      {text.split(" ").map((word, index) => <span key={`${word}-${index}`} className="animated-title__word" aria-hidden="true">{word}</span>)}
    </h1>
  );
}

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
  { id: "wishlist", label: "Wishlist" },
  { id: "archive", label: "ארכיון" },
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

// How an item's catalog photo was made
const QUALITY_LABELS = { low: "זול", medium: "בינוני", high: "איכות גבוהה", free: "חינמי" };
const qualityLabel = (value) => QUALITY_LABELS[value] || null;

// Examples shown in every "note to the AI" field
const AI_NOTE_HINT = "למשל: שמלת מקסי, בגד גוף, חולצה קצרה, ללבוש פתוח";

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
  const tilt = useMemo(() => tiltHandlers(), []);
  const type = TYPE_MAP[item.part]?.singular || "פריט מלתחה";
  const hasModeled = Boolean(item.modeledImage);

  return (
    <div className={`gallery-item${selected ? " selected" : ""}${checked ? " is-checked" : ""}${hasModeled ? " has-modeled" : ""}${showModeled ? " show-modeled" : ""}`}>
      <button
        className="gallery-item__main"
        type="button"
        {...tilt}
        onClick={() => (selectMode ? onToggleSelect(item.id) : onOpen(item.id))}
        aria-label={selectMode ? `בחירת ${item.name || type}` : `צפייה ב-${item.name || type}`}
        aria-pressed={selectMode ? checked : undefined}
        data-testid={`wardrobe-item-${item.id}`}
      >
        <OptimizedImage
          src={fittedImage(item.thumbnail || item.image)}
          // If the cropped version cannot load, fall back to the regular photo
          onError={imageFallback(item.thumbnail || item.image)}
          alt=""
          sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 260px"
          breakpoints={[160, 240, 320, 480, 640]}
        />
        {hasModeled && <img className="gallery-item__modeled" src={thumbUrl(item.modeledImage, 480)} onError={imageFallback(item.modeledImage)} alt="" loading="lazy" decoding="async" />}
        {selectMode && <span className="gallery-item__check" aria-hidden="true">{checked && <Check size={16} weight="bold" />}</span>}
      </button>
      {hasModeled && !selectMode && (
        <button type="button" className="gallery-item__swap" onClick={() => setShowModeled((value) => !value)} aria-pressed={showModeled}>
          {showModeled ? "הבגד" : "עליי"}
        </button>
      )}
      {item.name && <p className="gallery-item__name">{item.name}{item.brand && <span className="gallery-item__brand"> · {item.brand}</span>}</p>}
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
          {TYPES.filter((type) => !["all", "looks", "luggage", "archive", "wishlist"].includes(type.id)).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <FitPicker part={draft.part} fit={draft.fit} onChange={(fit) => setDraft((current) => ({ ...current, fit }))} />

      <label className="field">
        <span>מותג</span>
        <input
          value={draft.brand}
          onChange={(event) => setDraft((current) => ({ ...current, brand: event.target.value }))}
          placeholder="למשל: זארה"
          autoComplete="off"
        />
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

function ItemViewer({ item, modelRefUrl = null, suitcaseCount = 0, onPack, onCreateLook, onClose, onSave, onDelete, onModeledGenerated, onItemCreated }) {
  const [zoomSrc, setZoomSrc] = useState(null);
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", brand: item.brand || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], fit: fitForPart(item.fit, item.part) });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [generatingModeled, setGeneratingModeled] = useState(false);
  const [modeledError, setModeledError] = useState("");
  const [redoing, setRedoing] = useState(null);
  const [redoError, setRedoError] = useState("");
  const [redoPrompt, setRedoPrompt] = useState("");

  const [deciding, setDeciding] = useState(null);
  const [openBusy, setOpenBusy] = useState(null);
  const [openError, setOpenError] = useState("");

  // A one-time AI photo of this jacket lying open, used for free in flat lays
  const handleOpenVersion = async (quality) => {
    setOpenBusy(quality);
    setOpenError("");
    try {
      const res = await fetch(`/api/import/wardrobe/${item.id}/open-version`, {
        method: quality === "remove" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: quality === "remove" ? undefined : JSON.stringify({ quality }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "לא ניתן ליצור גרסה פתוחה כרגע");
      onModeledGenerated?.(data);
    } catch (err) {
      setOpenError(err.message || "לא ניתן ליצור גרסה פתוחה כרגע");
    } finally {
      setOpenBusy(null);
    }
  };

  // Use, keep as another item, or discard the new version
  const decideVersion = async (action) => {
    setDeciding(action);
    setRedoError("");
    try {
      const res = await fetch(`/api/import/wardrobe/${item.id}/version`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "לא ניתן לשמור את הבחירה כרגע");
      onModeledGenerated?.(data.item);
      if (data.created) onItemCreated?.(data.created);
    } catch (err) {
      setRedoError(err.message || "לא ניתן לשמור את הבחירה כרגע");
    } finally {
      setDeciding(null);
    }
  };

  // Create a new version of the catalog photo to compare with the current one
  const handleRedo = async (quality) => {
    setRedoing(quality);
    setRedoError("");
    try {
      const res = await fetch(`/api/import/wardrobe/${item.id}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality, prompt: redoPrompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "לא ניתן לעבד מחדש כרגע");
      onModeledGenerated?.(data);
      setActivePhotoTab("flat");
      setRedoPrompt("");
    } catch (err) {
      setRedoError(err.message || "לא ניתן לעבד מחדש כרגע");
    } finally {
      setRedoing(null);
    }
  };
  const [activePhotoTab, setActivePhotoTab] = useState("flat");
  const type = TYPE_MAP[item.part]?.singular || "פריט מלתחה";
  const hasModeledImage = Boolean(item.modeledImage);

  const [modeledPanelOpen, setModeledPanelOpen] = useState(false);
  const [modeledNote, setModeledNote] = useState("");

  const handleGenerateModeled = async () => {
    setGeneratingModeled(true);
    setModeledError("");
    try {
      const res = await fetch(`/api/import/wardrobe/${item.id}/modeled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: modeledNote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה ביצירת הדמיה על מודל");
      onModeledGenerated?.(data);
      setActivePhotoTab("modeled");
      setModeledPanelOpen(false);
      setModeledNote("");
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
      brand: (draft.brand || "").trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
      fit: JSON.stringify(fitForPart(draft.fit, draft.part)),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      brand: (item.brand || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
      fit: JSON.stringify(fitForPart(item.fit, item.part)),
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
    setDraft({ name: item.name || "", brand: item.brand || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], fit: fitForPart(item.fit, item.part) });
    setActivePhotoTab("flat");
    setModeledError("");
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", brand: item.brand || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], fit: fitForPart(item.fit, item.part) });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  // "idle" | "saving" | "saved" | "error": shown on the save button
  const [saveState, setSaveState] = useState("idle");
  const saveTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);
  const saveEditing = async () => {
    setSampling(null);
    setSaveState("saving");
    try {
      await onSave({ ...item, ...draft, fit: fitForPart(draft.fit, draft.part), name: draft.name.trim(), brand: (draft.brand || "").trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
      setSaveState("saved");
      setSampleStatus("השינויים נשמרו.");
    } catch {
      setSaveState("error");
    }
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => setSaveState("idle"), 2600);
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
          <p className="item-sheet__eyebrow">{[TYPE_MAP[draft.part]?.singular || "פריט", item.brand].filter(Boolean).join(" · ")}</p>
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
            <img src={thumbUrl(item.modeledImage, 1080)} onError={imageFallback(item.modeledImage)} alt={`${draft.name || type} עליי`} />
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
        <button type="button" className={modeledPanelOpen ? "is-on" : ""} onClick={() => setModeledPanelOpen((open) => !open)} disabled={generatingModeled} aria-expanded={modeledPanelOpen}>
          {generatingModeled ? <ArrowClockwise size={18} className="spin" aria-hidden="true" /> : <User size={18} aria-hidden="true" />}
          <span>{generatingModeled ? "יוצר..." : hasModeledImage ? "יצירה מחדש עליי" : "יצירה עליי"}</span>
        </button>
      </div>
      {modeledPanelOpen && (
        <div className="item-sheet__panel">
          <label className="item-sheet__label" htmlFor={`modeled-note-${item.id}`}>הערה ל-AI <span>אופציונלי</span></label>
          <textarea
            id={`modeled-note-${item.id}`}
            className="item-sheet__textarea"
            rows={2}
            value={modeledNote}
            onChange={(event) => setModeledNote(event.target.value)}
            placeholder={AI_NOTE_HINT}
          />
          <div className="item-sheet__redo-actions">
            <button type="button" className="primary-button" onClick={handleGenerateModeled} disabled={generatingModeled}>
              {generatingModeled ? <ArrowClockwise size={15} className="spin" aria-hidden="true" /> : <User size={15} aria-hidden="true" />}
              <span>{generatingModeled ? "יוצר..." : `${hasModeledImage ? "יצירה מחדש עליי" : "יצירה עליי"} (${PRICES.modeledItem})`}</span>
            </button>
            <button type="button" className="secondary-button" onClick={() => setModeledPanelOpen(false)} disabled={generatingModeled}>ביטול</button>
          </div>
          <p className="item-sheet__note">התמונה נשמרת אוטומטית לפריט{hasModeledImage ? " ומחליפה את התמונה הקודמת עלייך" : ""}. החיוב הוא על היצירה עצמה.</p>
          <ChatGptHelper
            getPrompt={async () => {
              const res = await fetch(`/api/import/wardrobe/${item.id}/prompt?note=${encodeURIComponent(modeledNote)}`);
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "לא ניתן להכין הנחיה");
              return data.prompt;
            }}
            photos={[
              ...(modelRefUrl ? [{ src: modelRefUrl, name: "התמונה שלי", filename: "me.png" }] : []),
              { src: item.image, thumb: thumbUrl(fittedImage(item.image), 160), name: draft.name || type, filename: `${draft.name || "garment"}.png` },
            ]}
            uploadLabel="העלאת התמונה עליי"
            onUpload={async (imageDataUrl) => {
              const res = await fetch(`/api/import/wardrobe/${item.id}/modeled-upload`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageDataUrl }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "ההעלאה נכשלה");
              onModeledGenerated?.(data);
              setActivePhotoTab("modeled");
              setModeledPanelOpen(false);
            }}
          />
        </div>
      )}
      {modeledError && <p className="item-sheet__error" role="alert">{modeledError}</p>}

      <section className="item-sheet__section item-sheet__redo" aria-labelledby="item-redo-title">
        <h3 id="item-redo-title">לא מרוצה מהתמונה?</h3>
        {item.pendingVersion ? (
          <div className="item-versions">
            <p className="item-sheet__note">נוצרה גרסה חדשה. בחרי מה לעשות איתה:</p>
            <div className="item-versions__compare">
              <figure>
                <button type="button" onClick={() => setZoomSrc(item.image)} aria-label="הגדלת התמונה הנוכחית"><img src={thumbUrl(item.image, 480)} onError={imageFallback(item.image)} alt="" /></button>
                <figcaption>הנוכחית{qualityLabel(item.catalogQuality) ? ` · ${qualityLabel(item.catalogQuality)}` : ""}</figcaption>
              </figure>
              <figure className="is-new">
                <button type="button" onClick={() => setZoomSrc(item.pendingVersion.image)} aria-label="הגדלת הגרסה החדשה"><img src={thumbUrl(item.pendingVersion.image, 480)} onError={imageFallback(item.pendingVersion.image)} alt="" /></button>
                <figcaption>החדשה · {qualityLabel(item.pendingVersion.quality)}</figcaption>
              </figure>
            </div>
            <div className="item-sheet__redo-actions">
              <button type="button" className="primary-button" disabled={Boolean(deciding)} onClick={() => decideVersion("use")}>
                <Check size={15} aria-hidden="true" /> {deciding === "use" ? "שומר..." : "להשתמש בחדשה"}
              </button>
              <button type="button" className="secondary-button" disabled={Boolean(deciding)} onClick={() => decideVersion("keep-both")}>
                <Plus size={15} aria-hidden="true" /> {deciding === "keep-both" ? "שומר..." : "לשמור כפריט נוסף"}
              </button>
              <button type="button" className="secondary-button" disabled={Boolean(deciding)} onClick={() => decideVersion("discard")}>
                <X size={15} aria-hidden="true" /> {deciding === "discard" ? "מוחק..." : "להשאיר את הנוכחית"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="item-sheet__note">{item.originalImage
              ? "תיווצר גרסה חדשה מהתמונה המקורית שהעלית. תוכלי להשוות ולבחור."
              : "לפריט הזה לא נשמרה תמונה מקורית, אז הגרסה החדשה תיווצר מהתמונה שבארון. תוכלי להשוות ולבחור."} החיוב הוא על היצירה, גם אם תשאירי את הנוכחית.</p>
            <label className="item-sheet__note-label" htmlFor={`redo-note-${item.id}`}>הערות ל-AI לתמונה החדשה <small>אופציונלי</small></label>
            <textarea
              id={`redo-note-${item.id}`}
              className="item-sheet__textarea"
              rows={3}
              value={redoPrompt}
              onChange={(event) => setRedoPrompt(event.target.value)}
              placeholder={AI_NOTE_HINT}
            />
            <div className="item-sheet__redo-actions">
              <button type="button" className="secondary-button" disabled={Boolean(redoing)} onClick={() => handleRedo("low")}>
                {redoing === "low" ? <ArrowClockwise size={15} className="spin" aria-hidden="true" /> : <MagicWand size={15} aria-hidden="true" />}
                <span>{redoing === "low" ? "מעבד..." : `עיבוד מחדש (${PRICES.catalogLow})`}</span>
              </button>
              <button type="button" className="primary-button" disabled={Boolean(redoing)} onClick={() => handleRedo("medium")}>
                {redoing === "medium" ? <ArrowClockwise size={15} className="spin" aria-hidden="true" /> : <MagicWand size={15} aria-hidden="true" />}
                <span>{redoing === "medium" ? "מעבד..." : `איכות בינונית (${PRICES.catalogMedium})`}</span>
              </button>
            </div>
          </>
        )}
        {redoError && <p className="item-sheet__error" role="alert">{redoError}</p>}
      </section>

      {(OUTER_PARTS.includes(draft.part) || (TOP_PARTS.includes(draft.part) && draft.fit?.buttoned)) && (
        <section className="item-sheet__section item-sheet__redo" aria-labelledby="item-open-title">
          <h3 id="item-open-title">{OUTER_PARTS.includes(draft.part) ? "ז'קט פתוח בפריסה" : "חולצה פתוחה בפריסה"}</h3>
          {item.openImage ? (
            <div className="item-open">
              <button type="button" className="item-open__thumb" onClick={() => setZoomSrc(item.openImage)} aria-label="הגדלת הגרסה הפתוחה">
                <img src={thumbUrl(item.openImage, 480)} onError={imageFallback(item.openImage)} alt="" />
              </button>
              <p className="item-sheet__note">בפריסות עם "ז'קט פתוח" תופיע התמונה הזאת, בלי עלות נוספת.</p>
            </div>
          ) : (
            <p className="item-sheet__note">בלי גרסה פתוחה, הפריסה חותכת את התמונה באמצע ופותחת אותה (חינם). גרסה מה-AI נראית אמיתית יותר. משלמים עליה פעם אחת, ואחר כך היא חינם בכל הפריסות.</p>
          )}
          <div className="item-sheet__redo-actions">
            <button type="button" className="secondary-button" disabled={Boolean(openBusy)} onClick={() => handleOpenVersion("low")}>
              {openBusy === "low" ? <ArrowClockwise size={15} className="spin" aria-hidden="true" /> : <MagicWand size={15} aria-hidden="true" />}
              <span>{openBusy === "low" ? "יוצר..." : `${item.openImage ? "יצירה מחדש" : "יצירת גרסה פתוחה"} (${PRICES.catalogLow})`}</span>
            </button>
            <button type="button" className="secondary-button" disabled={Boolean(openBusy)} onClick={() => handleOpenVersion("medium")}>
              {openBusy === "medium" ? <ArrowClockwise size={15} className="spin" aria-hidden="true" /> : <MagicWand size={15} aria-hidden="true" />}
              <span>{openBusy === "medium" ? "יוצר..." : `איכות בינונית (${PRICES.catalogMedium})`}</span>
            </button>
            {item.openImage && (
              <button type="button" className="secondary-button" disabled={Boolean(openBusy)} onClick={() => handleOpenVersion("remove")}>
                <Trash size={15} aria-hidden="true" /> <span>{openBusy === "remove" ? "מוחק..." : "הסרה"}</span>
              </button>
            )}
          </div>
          {openError && <p className="item-sheet__error" role="alert">{openError}</p>}
        </section>
      )}

      <section className="item-sheet__section" aria-labelledby="item-details-title">
        <h3 id="item-details-title">פרטי הפריט</h3>
        {qualityLabel(item.catalogQuality) && (
          <p className="item-sheet__made-with">תמונת הבגד נוצרה ב: <strong>{qualityLabel(item.catalogQuality)}</strong></p>
        )}
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
        <button className={`primary-button save-button is-${saveState}`} type="button" onClick={saveEditing} disabled={!isDirty || saveState === "saving"}>
          {saveState === "saving" ? <ArrowClockwise size={15} className="spin" aria-hidden="true" /> : <Check size={15} weight="bold" aria-hidden="true" />}
          {saveState === "saving" ? "שומר..." : saveState === "saved" ? "נשמר" : "שמירה"}
        </button>
      </footer>
      <p className={`save-toast is-${saveState}`} role="status" aria-live="polite">
        {saveState === "saved" ? "השינויים נשמרו" : saveState === "error" ? "השמירה נכשלה. נסי שוב." : ""}
      </p>
    </aside>
    </div>
    {zoomSrc && <ImageLightbox src={zoomSrc} alt={draft.name || type} onClose={() => setZoomSrc(null)} />}
    </div>
  );
}

// Full-size photo of a garment in a look, from the wardrobe when it is still there
const lookPieceImage = (garment, items = []) => {
  const item = items.find((entry) => entry.id === garment.id);
  return item?.image || garment.thumbnail;
};
// A look photographed on the user fills its card; a flat lay sits on the light card.
// Older looks did not record which kind they are, so the photo's corner colour
// (flat lays have a plain light background) decides.
// Flat lay backgrounds: the wardrobe card colour, and the near-white one used before
const FLATLAY_BGS = [[236, 229, 219], [248, 246, 242]];
const lookIsPhoto = (look) => look.mode === "modeled" ? true : look.mode === "flatlay" ? false : null;
function detectPhotoFromCorner(image) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, image.naturalWidth * 0.03 || 1, image.naturalHeight * 0.03 || 1, 0, 0, 4, 4);
    const [r, g, b] = context.getImageData(1, 1, 1, 1).data;
    return FLATLAY_BGS.every((bg) => Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 18);
  } catch {
    return false;
  }
}
function LookTileImage({ look, onPhoto }) {
  return (
    <OptimizedImage
      src={look.image}
      onError={imageFallback(look.image)}
      onLoad={(event) => { if (lookIsPhoto(look) === null) onPhoto(detectPhotoFromCorner(event.currentTarget)); }}
      alt=""
      sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 260px"
      breakpoints={[240, 320, 480, 640]}
    />
  );
}

const lookImages = (look, items = []) => [
  { src: thumbUrl(look.image, 1080), alt: look.name },
  ...(look.garments || []).map((garment) => ({ src: thumbUrl(lookPieceImage(garment, items), 1080), alt: garment.name })),
];

function LookViewerModal({ look, isPhoto = false, items = [], onClose, onDelete, onPack, onCreateOnMe, onEdit, suitcaseCount = 0 }) {
  const [deleting, setDeleting] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(null);

  const handleDelete = async () => {
    if (!window.confirm(`למחוק את הלוק "${look.name}"?`)) return;
    setDeleting(true);
    await onDelete(look.id);
    onClose();
  };

  return (
    <div className="builder-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && zoomIndex === null && onClose()}>
      <div className="builder-modal look-viewer">
        <header className="builder-header" style={{ marginBottom: "14px" }}>
          <div>
            <span style={{ fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontWeight: "600" }}>לוק שמור</span>
            <h2 style={{ margin: "4px 0 0", fontSize: "20px" }}>{look.name}</h2>
          </div>
          <button className="import-icon-button" type="button" onClick={onClose} aria-label="סגור">
            <X size={20} />
          </button>
        </header>

        <button type="button" className={`look-viewer__photo${(lookIsPhoto(look) ?? isPhoto) ? " is-photo" : ""}`} onClick={() => setZoomIndex(0)} aria-label="הגדלת תמונת הלוק">
          <img src={thumbUrl(look.image, 1080)} onError={imageFallback(look.image)} alt={look.name} />
        </button>

        {look.notes && (
          <div style={{ marginBottom: "16px", padding: "10px 14px", background: "rgba(25, 24, 22, 0.03)", border: "1px dashed var(--line)", borderRadius: "12px" }}>
            <span className="look-viewer__label" style={{ marginBottom: "4px" }}>הערות סטיילינג</span>
            <p style={{ margin: 0, fontSize: "13px", fontStyle: "italic", color: "var(--ink)" }}>"{look.notes}"</p>
          </div>
        )}

        {(lookEvents(look).length > 0 || (look.tags || []).length > 0) && (
          <div className="look-viewer__meta">
            {lookEvents(look).map((event) => <span key={event} className="look-viewer__event">{event}</span>)}
            {(look.tags || []).map((tag) => <span key={tag} className="look-viewer__tag">#{tag}</span>)}
          </div>
        )}

        {stylingSummary(look.styling) && (
          <div style={{ marginBottom: "14px", fontSize: "12px", color: "var(--muted)" }}>
            <span style={{ fontWeight: "600", color: "var(--ink)" }}>סידור:</span> {stylingSummary(look.styling)}
          </div>
        )}

        {look.setting && look.mode !== "flatlay" && look.setting !== "Custom wardrobe outfit" && (
          <div style={{ marginBottom: "14px", fontSize: "12px", color: "var(--muted)" }}>
            <span style={{ fontWeight: "600", color: "var(--ink)" }}>רקע:</span> {look.setting}
          </div>
        )}

        {!!look.garments?.length && (
          <>
            <span className="look-viewer__label">פריטים בלוק</span>
            <div className="look-viewer__pieces">
              {look.garments.map((g, index) => (
                <button key={g.id} type="button" className="look-piece" onClick={() => setZoomIndex(index + 1)} aria-label={`הגדלת ${g.name}`}>
                  <span className="look-piece__img">
                    <img src={thumbUrl(fittedImage(g.thumbnail), 240)} onError={imageFallback(g.thumbnail)} loading="lazy" alt="" />
                  </span>
                  <span className="look-piece__name">{g.name}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="look-viewer__footer">
          <button className="lv-btn is-danger" type="button" disabled={deleting} onClick={handleDelete} aria-label="מחיקת הלוק">
            <Trash size={15} /> <span>מחיקה</span>
          </button>
          <span className="lv-spacer" />
          {onCreateOnMe && !!look.garmentIds?.length && (
            <button className="lv-btn" type="button" onClick={() => onCreateOnMe(look)} aria-label={look.mode === "modeled" ? "ליצור שוב עליי" : "ליצור לוק עליי"}>
              <User size={15} /> <span>עליי</span>
            </button>
          )}
          {onPack && (
            <button className="lv-btn" type="button" onClick={onPack} aria-label={suitcaseCount ? `במזוודה (${suitcaseCount})` : "הוספה למזוודה"}>
              <Suitcase size={15} weight={suitcaseCount ? "fill" : "regular"} /> <span>{suitcaseCount ? `במזוודה ${suitcaseCount}` : "מזוודה"}</span>
            </button>
          )}
          {onEdit && !!look.garmentIds?.length
            ? <button className="lv-btn is-primary" type="button" onClick={() => onEdit(look)}><PencilSimple size={15} /> <span>עריכה</span></button>
            : <button className="lv-btn is-primary" type="button" onClick={onClose}>סגירה</button>}
        </div>
      </div>
      {zoomIndex !== null && <ImageLightbox images={lookImages(look, items)} startIndex={zoomIndex} onClose={() => setZoomIndex(null)} />}
    </div>
  );
}

const USD_TO_ILS = 3.6;
const formatUsd = (value) => `$${(Number(value) || 0).toFixed((Number(value) || 0) < 10 ? 2 : 1)}`;
const formatIls = (value) => `כ-${Math.round((Number(value) || 0) * USD_TO_ILS * 100) / 100} ₪`;
const formatDate = (iso) => { try { return new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" }); } catch { return ""; } };

// OpenAI balance and the past year's spending. OpenAI has no API for the balance,
// so it is typed in once from the billing page and charges since then are subtracted.
function AiSpendingSection() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch("/api/import/billing", { cache: "no-store" })
      .then(async (res) => {
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "לא ניתן לטעון את נתוני השימוש");
        setData(result);
        setError("");
      })
      .catch((err) => setError(err.message || "לא ניתן לטעון את נתוני השימוש"));
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveBalance = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/import/billing/balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balanceUsd: input === "" ? null : Number(input) }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "לא ניתן לשמור");
      setData(result);
      setEditing(false);
      setError("");
    } catch (err) {
      setError(err.message || "לא ניתן לשמור");
    } finally {
      setSaving(false);
    }
  };

  const actual = data?.actual;
  const balance = data?.balance;
  const year = actual?.configured && Number.isFinite(actual.yearUsd) ? actual.yearUsd : null;
  const remaining = balance ? Math.max(0, balance.remainingUsd) : null;

  return (
    <section className="account-section" aria-labelledby="account-ai-title">
      <h3 id="account-ai-title">שימוש ב-AI</h3>
      {!data && !error && <p className="account-hint">טוען...</p>}
      {data && (
        <>
          <div className="ai-spend-grid">
            <div className={`ai-spend-tile${remaining !== null && remaining < 1 ? " is-low" : ""}`}>
              <span className="ai-spend-tile__label">נשאר בחשבון</span>
              <strong>{remaining === null ? "—" : formatUsd(remaining)}</strong>
              <small>{remaining === null ? "צריך להזין יתרה" : `${formatIls(remaining)} · ${balance.source === "actual" ? "לפי OpenAI" : "הערכה"}`}</small>
            </div>
            <div className="ai-spend-tile">
              <span className="ai-spend-tile__label">נוצל בשנה האחרונה</span>
              <strong>{year === null ? "—" : formatUsd(year)}</strong>
              <small>{year === null ? (actual?.pending ? "יתעדכן בעוד כמה דקות" : "אין נתונים מ-OpenAI") : `${formatIls(year)} · לפי OpenAI`}</small>
            </div>
          </div>

          {editing ? (
            <form className="account-row" onSubmit={saveBalance}>
              <input className="account-input" type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" placeholder="למשל 10" value={input} onChange={(e) => setInput(e.target.value)} aria-label="היתרה הנוכחית בדולרים" autoFocus />
              <button className="secondary-button" type="submit" disabled={saving}>{saving ? "שומר..." : "שמירה"}</button>
              <button className="secondary-button" type="button" onClick={() => setEditing(false)}>ביטול</button>
            </form>
          ) : (
            <div className="account-row ai-spend-actions">
              <button className="secondary-button" type="button" onClick={() => { setInput(remaining === null ? "" : String(Number(remaining.toFixed(2)))); setEditing(true); }}>
                {balance ? "עדכון היתרה" : "הזנת היתרה"}
              </button>
              <a className="secondary-button" href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer">לעמוד החיוב ב-OpenAI</a>
            </div>
          )}
          <p className="account-hint">
            OpenAI לא נותנת לאתר לקרוא את היתרה, אז מעתיקים אותה פעם אחת מעמוד החיוב (Credit balance, בדולרים). מאז האתר מוריד ממנה את מה שנוצל.
            {balance ? ` היתרה עודכנה ב-${formatDate(balance.setAt)}.` : ""}
          </p>
          {!actual?.configured && <p className="account-hint">כדי לראות את מה שנוצל בשנה האחרונה צריך להוסיף ב-Netlify מפתח מנהל של OpenAI בשם OPENAI_ADMIN_KEY.</p>}
          {actual?.error && <p className="account-error" role="alert">{actual.error}</p>}
        </>
      )}
      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  );
}

// Body measurements: used for the proportions of flat lays and given to the AI
// so photos on the user keep her real shape
function BodySection({ user, onSaveUser }) {
  const initial = user?.body || {};
  const [values, setValues] = useState({ height: initial.height ?? "", bust: initial.bust ?? "", waist: initial.waist ?? "", hips: initial.hips ?? "" });
  const [state, setState] = useState("idle");
  useEffect(() => {
    const body = user?.body || {};
    setValues({ height: body.height ?? "", bust: body.bust ?? "", waist: body.waist ?? "", hips: body.hips ?? "" });
  }, [user?.body]);
  const changed = ["height", "bust", "waist", "hips"].some((key) => String(values[key] ?? "") !== String(initial[key] ?? ""));
  const save = async (event) => {
    event.preventDefault();
    setState("saving");
    try {
      await onSaveUser({ body: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "").map(([key, value]) => [key, Number(value)])) });
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("idle");
    }
  };
  const fields = [["height", "גובה"], ["bust", "חזה"], ["waist", "מותן"], ["hips", "ירכיים"]];
  return (
    <section className="account-section" aria-labelledby="account-body-title">
      <h3 id="account-body-title">מידות גוף</h3>
      <form onSubmit={save}>
        <div className="body-fields">
          {fields.map(([key, label]) => (
            <label key={key} className="body-field">
              <span>{label}</span>
              <input className="account-input" type="number" inputMode="numeric" min="0" dir="ltr" value={values[key]} onChange={(e) => setValues((current) => ({ ...current, [key]: e.target.value }))} placeholder="ס״מ" />
            </label>
          ))}
        </div>
        <div className="account-row">
          <button className="secondary-button" type="submit" disabled={!changed || state === "saving"}>
            {state === "saving" ? "שומר..." : state === "saved" ? <><Check size={14} /> נשמר</> : "שמירה"}
          </button>
        </div>
      </form>
      <p className="account-hint">בסנטימטרים. היחס בין החזה, המותן והירכיים קובע את רוחב החולצה והחגורה בפריסה, וכל המידות נשלחות ל-AI כדי שהתמונות עלייך ישמרו על הפרופורציות שלך.</p>
    </section>
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

        <BodySection user={user} onSaveUser={onSaveUser} />

        <AiSpendingSection />

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
                <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 160)} onError={imageFallback(item.thumbnail || item.image)} alt="" style={{ width: "20px", height: "20px", objectFit: "contain" }} />
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

const OUTER_PARTS = ["wholebody_up", "outerwear", "jacket"];
const TOP_PARTS = ["upperbody", "top"];
const BOTTOM_PARTS = ["lowerbody", "bottom"];
// "spread": every piece in its own place, none on another (the default).
// "body": laid like a body, with layers, in/out and open/closed choices.
const DEFAULT_FLATLAY_STYLING = { layout: "spread", jacket: "open", top: "out", shirt: "closed" };
const STYLING_LABELS = {
  layout: { spread: "כל פריט במקומו", body: "על הגוף" },
  jacket: { open: "ז'קט פתוח", front: "ז'קט שלם מלפנים", behind: "ז'קט שלם מאחור", closed: "ז'קט שלם מלפנים" },
  top: { out: "חולצה בחוץ", tucked: "חולצה בתוך המכנסיים" },
  shirt: { open: "מכופתרת פתוחה", closed: "מכופתרת סגורה" },
};
const stylingSummary = (styling) => Object.entries(styling || {}).map(([key, value]) => STYLING_LABELS[key]?.[value]).filter(Boolean).join(" · ");

// Loads the newest version of the site and its data, without closing the app:
// asks the service worker for an update, drops the cached page shell, reloads
function RefreshButton() {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker?.getRegistration?.();
      await registration?.update?.().catch(() => {});
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.includes("shell")).map((key) => caches.delete(key)));
      }
    } catch {}
    window.location.reload();
  };
  return (
    <button type="button" className="refresh-header-btn" onClick={refresh} disabled={busy} title="רענון: טעינת הגרסה והנתונים העדכניים" aria-label="רענון האתר">
      <ArrowClockwise size={18} className={busy ? "spin" : ""} aria-hidden="true" />
    </button>
  );
}

// Two-option switch used for the free flat-lay styling choices
function StylingChoice({ label, value, options, onChange, disabled }) {
  return (
    <div className="styling-choice">
      <span className="styling-choice__label">{label}</span>
      <div className="styling-choice__options" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? "is-on" : ""} disabled={disabled} onClick={() => onChange(option.id)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CustomOutfitModal({ items, modelRefUrl = null, onUpdateItem, initialItemIds = [], initialMode = "flatlay", initialNotes = "", initialStyling = null, editLook = null, onClose, onCreated }) {
  const [outfitMode, setOutfitMode] = useState(initialMode || "flatlay");
  const [selectedIds, setSelectedIds] = useState(() => [...initialItemIds]);
  const [outfitNotes, setOutfitNotes] = useState(initialNotes || "");
  // A look made before the choice existed was laid on the body
  const [styling, setStyling] = useState(() => ({ ...DEFAULT_FLATLAY_STYLING, ...(initialStyling ? { layout: "body", ...initialStyling } : {}) }));
  const [lookName, setLookName] = useState(editLook?.name || "");
  // The event (shown and filtered by) and the look's own tags
  const [lookEvent, setLookEvent] = useState(() => [...new Set((editLook?.occasion || []).filter((value) => value !== "casual").map(eventLabel))].join(", "));
  const [lookTagText, setLookTagText] = useState(() => (editLook?.tags || []).join(", "));
  // One category open at a time; all closed at first
  const [openCategory, setOpenCategory] = useState(null);
  // The picked piece whose length and fit are being edited here
  const [settingsId, setSettingsId] = useState(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completingAI, setCompletingAI] = useState(false);
  const [aiExplanation, setAiExplanation] = useState("");
  const [builderError, setBuilderError] = useState("");
  // Editing a saved look starts from its picture, so it can be saved again right away
  const [generatedLook, setGeneratedLook] = useState(() => (editLook ? { ...editLook, mode: editLook.mode || initialMode, usedStyling: editLook.styling || undefined, existing: true } : null));
  // Shows "the look is ready" over the preview for a moment after each creation
  const [justCreated, setJustCreated] = useState(0);
  const bodyRef = useRef(null);
  useEffect(() => {
    if (!justCreated) return undefined;
    const timer = setTimeout(() => setJustCreated(0), 2800);
    return () => clearTimeout(timer);
  }, [justCreated]);

  useEffect(() => {
    if (initialMode) setOutfitMode(initialMode);
  }, [initialMode]);

  const selectedItems = useMemo(() => {
    return selectedIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
  }, [selectedIds, items]);

  const hasOuter = selectedItems.some((item) => OUTER_PARTS.includes(item.part));
  const hasInnerTop = selectedItems.some((item) => TOP_PARTS.includes(item.part) || item.part === "dress" || item.part === "wholebody");
  const hasTop = selectedItems.some((item) => TOP_PARTS.includes(item.part));
  const hasBottom = selectedItems.some((item) => BOTTOM_PARTS.includes(item.part));
  const hasButtoned = selectedItems.some((item) => TOP_PARTS.includes(item.part) && item.fit?.buttoned);

  // Upper-body layers, from the body outwards, and how each outer one is laid
  const isUpper = (item) => TOP_PARTS.includes(item.part) || OUTER_PARTS.includes(item.part) || item.part === "dress" || item.part === "wholebody";
  const layerRank = (item) => (item.part === "dress" || item.part === "wholebody" ? 0 : OUTER_PARTS.includes(item.part) ? 3 : item.fit?.buttoned ? 2 : 1);
  const canOpenLayer = (item) => OUTER_PARTS.includes(item.part) || Boolean(item.fit?.buttoned);
  const defaultLayerStyle = (item) => (OUTER_PARTS.includes(item.part) ? "open" : "closed");
  const [layerOrder, setLayerOrder] = useState(() => initialStyling?.layers?.map((layer) => layer.id) || []);
  const [layerStyles, setLayerStyles] = useState(() => Object.fromEntries((initialStyling?.layers || []).map((layer) => [layer.id, layer.style])));
  const upperItems = useMemo(() => {
    const upper = selectedItems.filter(isUpper);
    const known = layerOrder.map((id) => upper.find((item) => item.id === id)).filter(Boolean);
    const added = upper.filter((item) => !layerOrder.includes(item.id)).sort((a, b) => layerRank(a) - layerRank(b));
    return [...known, ...added];
  }, [selectedItems, layerOrder]); // eslint-disable-line react-hooks/exhaustive-deps
  const layersPayload = upperItems.length >= 2
    ? upperItems.map((item, index) => ({ id: item.id, style: index === 0 ? "closed" : (layerStyles[item.id] || defaultLayerStyle(item)) }))
    : null;
  // Set when the arrangement changed after the flat lay was made
  const [pendingChanges, setPendingChanges] = useState(false);
  // Only the choices that apply to the pieces picked right now are sent
  const activeStyling = useMemo(() => {
    if (styling.layout !== "body") return { layout: "spread" };
    const next = { layout: "body" };
    if (hasOuter && hasInnerTop) next.jacket = styling.jacket;
    if ((hasTop || hasOuter) && hasBottom) next.top = styling.top;
    if (hasButtoned) next.shirt = styling.shirt;
    if (layersPayload) next.layers = layersPayload;
    return next;
  }, [styling, hasOuter, hasInnerTop, hasTop, hasBottom, hasButtoned, JSON.stringify(layersPayload)]); // eslint-disable-line react-hooks/exhaustive-deps

  // A look made on the model has already been paid for, so losing it unsaved wastes money
  const paidUnsaved = Boolean(generatedLook) && !generatedLook.existing && generatedLook.mode !== "flatlay" && !generatedLook.uploaded && !saving;
  const confirmDiscardPaid = (action = "לסגור") => !paidUnsaved || window.confirm(`הלוק עלייך כבר נוצר והיצירה עלתה ${lookOnModelPrice(selectedIds.length)}. אם ${action} בלי לשמור, הלוק יאבד והכסף לא יחזור. להמשיך בלי לשמור?`);
  const requestClose = () => { if (confirmDiscardPaid("תסגרי")) onClose(); };

  const toggleItem = (id) => {
    if (generatedLook) setPendingChanges(true);
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
    if (!confirmDiscardPaid("תנקי")) return;
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

  const inCategory = (item, categoryId) => {
    if (categoryId === "dress") return item.part === "dress" || item.part === "wholebody";
    if (categoryId === "wholebody_up") return OUTER_PARTS.includes(item.part);
    return item.part === categoryId;
  };

  const handleGenerate = async (stylingOverride) => {
    if (!selectedIds.length) {
      setBuilderError("אנא בחרו לפחות פריט אחד.");
      return;
    }
    if (outfitMode === "modeled" && generatedLook && !confirmDiscardPaid("תיצרי מחדש")) return;
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
          styling: outfitMode === "flatlay" ? (stylingOverride || activeStyling) : undefined,
          settingDirection: "a warm, natural daylight setting with minimalist architecture",
          save: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה ביצירת לוק");
      setGeneratedLook({ ...data, mode: data.mode || outfitMode, usedStyling: outfitMode === "flatlay" ? (stylingOverride || activeStyling) : undefined });
      setPendingChanges(false);
      setJustCreated(Date.now());
      requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
      if (!lookName.trim() && data.name) {
        setLookName(data.name);
      }
    } catch (err) {
      setBuilderError(err.message || "שגיאה ביצירת לוק");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async ({ asNew = false } = {}) => {
    if (!selectedIds.length) {
      setBuilderError("אנא בחרו לפחות פריט אחד.");
      return;
    }
    setSaving(editLook ? (asNew ? "new" : "update") : true);
    setBuilderError("");
    try {
      // Updating keeps the look's id and date; a new look gets its own id (and its own copy of the photo)
      const kept = editLook && !asNew ? { id: editLook.id, createdAt: editLook.createdAt } : {};
      const fresh = editLook && asNew
        ? { id: undefined, createdAt: undefined, copyImage: true, name: (lookName.trim() || editLook.name) === editLook.name ? `${editLook.name} 2` : lookName.trim() }
        : {};
      const payload = generatedLook
        ? {
            ...generatedLook,
            ...kept,
            existing: undefined,
            usedStyling: undefined,
            // A flat lay is laid out again on saving, so it follows the pieces picked now
            ...(outfitMode === "flatlay" ? { garmentIds: selectedIds } : {}),
            name: lookName.trim() || generatedLook.name,
            notes: outfitNotes.trim() || generatedLook.notes,
            mode: outfitMode,
            styling: outfitMode === "flatlay" ? (generatedLook?.usedStyling || activeStyling) : undefined,
            ...(generatedLook.uploaded ? { uploadedImage: generatedLook.image, image: undefined, uploaded: undefined, garmentIds: selectedIds } : {}),
            occasion: lookEvent.split(",").map((v) => v.trim()).filter(Boolean),
            tags: lookTagText.split(",").map((v) => v.trim().replace(/^#/, "")).filter(Boolean),
            ...fresh,
          }
        : {
            ...kept,
            name: lookName.trim() || undefined,
            garmentIds: selectedIds,
            notes: outfitNotes.trim() || undefined,
            mode: outfitMode,
            styling: outfitMode === "flatlay" ? (generatedLook?.usedStyling || activeStyling) : undefined,
            setting: "a warm, natural daylight setting with minimalist architecture",
            image: selectedItems[0]?.thumbnail || selectedItems[0]?.image || "",
            occasion: lookEvent.split(",").map((v) => v.trim()).filter(Boolean),
            tags: lookTagText.split(",").map((v) => v.trim().replace(/^#/, "")).filter(Boolean),
            ...fresh,
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
    { id: "upperbody", label: "חולצות" },
    { id: "lowerbody", label: "מכנסיים וחצאיות" },
    { id: "dress", label: "שמלות" },
    { id: "wholebody_up", label: "עליוניות" },
    { id: "shoes", label: "נעליים" },
    { id: "accessories_up", label: "אקססוריז" },
  ];
  const bodyChoices = styling.layout === "body" && ((hasOuter && hasInnerTop) || ((hasTop || hasOuter) && hasBottom) || hasButtoned || upperItems.length >= 2);
  const showStyling = outfitMode === "flatlay" && selectedItems.length > 0;
  const manyLayers = upperItems.length >= 2;
  // Arrangement changes are only shown when "שוב" is pressed
  const relayer = (order, styles) => {
    setLayerOrder(order);
    setLayerStyles(styles);
    if (generatedLook) setPendingChanges(true);
  };
  const moveLayer = (index, step) => {
    const order = upperItems.map((item) => item.id);
    const target = index + step;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    relayer(order, layerStyles);
  };
  const restyle = (key, value) => {
    setStyling((current) => ({ ...current, [key]: value }));
    if (generatedLook) setPendingChanges(true);
  };
  const switchMode = (mode) => {
    if (mode === outfitMode) return;
    if (mode === "flatlay" && !confirmDiscardPaid("תעברי לפריסה")) return;
    setOutfitMode(mode);
    setGeneratedLook(null);
  };
  const price = outfitMode === "flatlay" ? PRICES.free : lookOnModelPrice(selectedIds.length);

  return (
    <div className="builder-modal-overlay look-builder-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="builder-modal look-builder" role="dialog" aria-modal="true" aria-labelledby="look-builder-title">
        <header className="lb-header">
          <h2 id="look-builder-title">{editLook ? "עריכת לוק" : "לוק חדש"}</h2>
          <button className="lb-close" type="button" onClick={requestClose} aria-label="סגירה">
            <X size={18} />
          </button>
        </header>


        <div className="lb-body" ref={bodyRef}>
          <div className="lb-mode" role="radiogroup" aria-label="סוג הלוק">
            {[
              { id: "flatlay", name: "פריסה שטוחה", note: PRICES.free },
              { id: "modeled", name: "עליי", note: `AI · ${lookOnModelPrice(selectedIds.length)}` },
            ].map((option) => (
              <button key={option.id} type="button" role="radio" aria-checked={outfitMode === option.id} className={outfitMode === option.id ? "is-on" : ""} onClick={() => switchMode(option.id)}>
                <span className="lb-mode__name">{option.name}</span>
                <span className="lb-mode__note">{option.note}</span>
              </button>
            ))}
          </div>
          {generatedLook && (
            <section className="lb-preview" aria-label="תצוגה מקדימה">
              <img src={thumbUrl(generatedLook.image, 1080)} onError={imageFallback(generatedLook.image)} alt={generatedLook.name} />
              {generating && <span className="lb-preview__busy"><ArrowClockwise size={18} className="spin" /></span>}
              {!generating && justCreated > 0 && <span key={justCreated} className="lb-preview__done" role="status"><Check size={14} weight="bold" /> הלוק נוצר</span>}
            </section>
          )}
          {generatedLook && (
            <div className="lb-remake">
              <button className={`lb-button${pendingChanges ? " is-primary" : ""}`} type="button" disabled={generating || saving} onClick={() => handleGenerate()}>
                <ArrowClockwise size={15} className={generating ? "spin" : ""} />
                <span>{generating ? "יוצר..." : outfitMode === "flatlay" ? (pendingChanges ? "פריסה מחדש לפי השינויים" : "פריסה מחדש") : (pendingChanges ? "יצירה מחדש עליי לפי השינויים" : "יצירה מחדש עליי")}</span>
                {!generating && <small>{price}</small>}
              </button>
              {pendingChanges && !generating && <span className="lb-remake__note">יש שינויים שעוד לא מופיעים בתמונה</span>}
            </div>
          )}

          <section className="lb-section">
            <div className="lb-section__head">
              <h3>פריטים{selectedItems.length > 0 && <span className="lb-count">{selectedItems.length}</span>}</h3>
              <div className="lb-section__actions">
                <button type="button" className="lb-link" disabled={completingAI || generating} onClick={handleCompleteWithAI}>
                  {completingAI ? <ArrowClockwise size={13} className="spin" /> : <MagicWand size={13} />}
                  <span>{completingAI ? "משלים..." : "השלמה עם AI"}</span>
                  <small>{PRICES.textAI}</small>
                </button>
                {selectedItems.length > 0 && <button type="button" className="lb-link is-muted" onClick={clearAll}>ניקוי</button>}
              </div>
            </div>

            {aiExplanation && <p className="lb-hint">{aiExplanation}</p>}

            {(() => {
              const item = selectedItems.find((entry) => entry.id === settingsId);
              if (!item || !lengthOptions(item.part)) return null;
              return (
                <div className="lb-item-settings">
                  <div className="lb-item-settings__head">
                    <strong>{item.name}</strong>
                    <span>{settingsSaving ? "שומר..." : "נשמר לפריט"}</span>
                  </div>
                  <FitPicker
                    compact
                    part={item.part}
                    fit={fitForPart(item.fit, item.part)}
                    onChange={async (fit) => {
                      setSettingsSaving(true);
                      try {
                        await onUpdateItem?.({ ...item, fit });
                        // Shown in the flat lay when "שוב" is pressed
                        if (generatedLook && outfitMode === "flatlay") setPendingChanges(true);
                      } catch {
                        setBuilderError("לא ניתן לשמור את ההגדרה כרגע");
                      } finally {
                        setSettingsSaving(false);
                      }
                    }}
                  />
                </div>
              );
            })()}

            {selectedItems.length > 0 ? (
              <div className="lb-chips">
                {selectedItems.map((item) => (
                  <span key={item.id} className="lb-chip">
                    <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 160)} onError={imageFallback(item.thumbnail || item.image)} alt="" />
                    <span className="lb-chip__name">{item.name}</span>
                    {lengthOptions(item.part) && (
                      <button type="button" className={settingsId === item.id ? "is-on" : ""} onClick={() => setSettingsId(settingsId === item.id ? null : item.id)} aria-label={`הגדרות ${item.name}`} aria-expanded={settingsId === item.id}><SlidersHorizontal size={13} /></button>
                    )}
                    <button type="button" onClick={() => removeSelectedItem(item.id)} aria-label={`הסרת ${item.name}`}><X size={12} /></button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="lb-empty">בחרי פריטים מהארון</p>
            )}

            <div className="lb-cats">
              {categoryTabs.map((tab) => {
                const pieces = items.filter((item) => inCategory(item, tab.id));
                if (!pieces.length) return null;
                const open = openCategory === tab.id;
                const picked = pieces.filter((item) => selectedIds.includes(item.id)).length;
                return (
                  <div key={tab.id} className={`lb-cat${open ? " is-open" : ""}`}>
                    <button type="button" className="lb-cat__head" aria-expanded={open} onClick={() => setOpenCategory(open ? null : tab.id)}>
                      <span className="lb-cat__name">{tab.label}</span>
                      {picked > 0 && <span className="lb-cat__picked">{picked === 1 ? "נבחר 1" : `נבחרו ${picked}`}</span>}
                      <span className="lb-cat__count">{pieces.length}</span>
                      <CaretDown size={14} className="lb-cat__caret" aria-hidden="true" />
                    </button>
                    {open && (
                      <div className="lb-grid">
                        {pieces.map((item) => {
                          const isSelected = selectedIds.includes(item.id);
                          return (
                            <button key={item.id} type="button" className={`lb-tile${isSelected ? " is-on" : ""}`} aria-pressed={isSelected} onClick={() => toggleItem(item.id)}>
                              <span className="lb-tile__img">
                                <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 240)} onError={imageFallback(item.thumbnail || item.image)} loading="lazy" decoding="async" alt="" />
                                <span className="lb-tile__check" aria-hidden="true">{isSelected && <Check size={12} weight="bold" />}</span>
                              </span>
                              <span className="lb-tile__name">{item.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {showStyling && (
            <section className="lb-section">
              <div className="lb-section__head">
                <h3>סידור</h3>
                <span className="lb-tag">חינם, בלי AI</span>
              </div>
              <StylingChoice
                label="פריסה"
                value={styling.layout === "body" ? "body" : "spread"}
                disabled={generating}
                options={[{ id: "spread", label: "כל פריט במקומו" }, { id: "body", label: "על הגוף" }]}
                onChange={(value) => restyle("layout", value)}
              />
              {styling.layout !== "body" && <p className="lb-layers__hint">כל פריט שלם ובמקום משלו, ברווח מהשאר, לפי האורך והגזרה שהוגדרו לו</p>}
              {bodyChoices && manyLayers && (
                <div className="lb-layers">
                  {upperItems.map((item, index) => {
                    const style = index === 0 ? null : (layerStyles[item.id] || defaultLayerStyle(item));
                    // Open (fronts at the sides) or closed (laid half over the layer under it).
                    // What lies on what is decided by the order above.
                    const options = canOpenLayer(item) ? [{ id: "open", label: "פתוחה" }, { id: "closed", label: "סגורה" }] : [];
                    const shown = style === "open" && !canOpenLayer(item) ? "closed" : style === "open" ? "open" : "closed";
                    return (
                      <div key={item.id} className="lb-layer">
                        <div className="lb-layer__row">
                          <span className="lb-layer__num">{index + 1}</span>
                          <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 160)} onError={imageFallback(item.thumbnail || item.image)} alt="" />
                          <span className="lb-layer__name">{item.name}{index === 0 && <small> · הכי קרוב לגוף</small>}</span>
                          <button type="button" disabled={generating || index === 0} onClick={() => moveLayer(index, -1)} aria-label={`להזיז את ${item.name} פנימה`}><ArrowUp size={14} /></button>
                          <button type="button" disabled={generating || index === upperItems.length - 1} onClick={() => moveLayer(index, 1)} aria-label={`להזיז את ${item.name} החוצה`}><ArrowDown size={14} /></button>
                        </div>
                        {index > 0 && options.length > 0 && (
                          <div className="styling-choice__options lb-layer__styles" role="radiogroup" aria-label={`איך ${item.name} מונחת`}>
                            {options.map((option) => (
                              <button key={option.id} type="button" role="radio" aria-checked={shown === option.id} className={shown === option.id ? "is-on" : ""} disabled={generating}
                                onClick={() => relayer(upperItems.map((entry) => entry.id), { ...layerStyles, [item.id]: option.id })}>
                                {option.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {bodyChoices && !manyLayers && hasOuter && hasInnerTop && (
                <StylingChoice
                  label="ז'קט"
                  value={styling.jacket}
                  disabled={generating}
                  options={[{ id: "open", label: "פתוח" }, { id: "closed", label: "סגור" }]}
                  onChange={(value) => restyle("jacket", value)}
                />
              )}
              {bodyChoices && hasButtoned && !manyLayers && (
                <StylingChoice
                  label="חולצה מכופתרת"
                  value={styling.shirt}
                  disabled={generating}
                  options={[{ id: "closed", label: "סגורה" }, { id: "open", label: "פתוחה" }]}
                  onChange={(value) => restyle("shirt", value)}
                />
              )}
              {bodyChoices && (hasTop || hasOuter) && hasBottom && (
                <StylingChoice
                  label={upperItems && upperItems.length > 1 ? "שכבה ראשונה" : "חולצה"}
                  value={styling.top}
                  disabled={generating}
                  options={[{ id: "out", label: "בחוץ" }, { id: "tucked", label: "בפנים" }]}
                  onChange={(value) => restyle("top", value)}
                />
              )}
            </section>
          )}

          <section className="lb-section lb-fields">
            <label className="lb-label" htmlFor="look-builder-notes">{outfitMode === "flatlay" ? "הערות" : "הערה ל-AI"} <span>אופציונלי</span></label>
            <textarea
              id="look-builder-notes"
              className="lb-input"
              value={outfitNotes}
              onChange={(e) => setOutfitNotes(e.target.value)}
              placeholder={outfitMode === "flatlay" ? "נשמרות עם הלוק ועוברות ל-AI אם תיצרי אותו עלייך" : `${AI_NOTE_HINT}, להכניס את החולצה למכנסיים`}
              rows={2}
            />
            {outfitMode === "modeled" && selectedItems.length > 0 && (
              <ChatGptHelper
                getPrompt={async () => {
                  const res = await fetch("/api/import/outfits/prompt", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ garmentIds: selectedIds, notes: outfitNotes, name: lookName }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || "לא ניתן להכין הנחיה");
                  return data.prompt;
                }}
                photos={[
                  ...(modelRefUrl ? [{ src: modelRefUrl, name: "התמונה שלי", filename: "me.png" }] : []),
                  ...selectedItems.map((item) => ({ src: item.image, thumb: thumbUrl(fittedImage(item.thumbnail || item.image), 160), name: item.name, filename: `${item.name || "garment"}.png` })),
                ]}
                uploadLabel="העלאת הלוק שיצרתי"
                onUpload={async (imageDataUrl) => {
                  setGeneratedLook({ image: imageDataUrl, name: lookName.trim() || "", mode: "modeled", uploaded: true });
                  setJustCreated(Date.now());
                  requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
                }}
              />
            )}
            <label className="lb-label" htmlFor="look-builder-name">שם הלוק <span>אופציונלי</span></label>
            <input id="look-builder-name" className="lb-input" type="text" value={lookName} onChange={(e) => setLookName(e.target.value)} placeholder="יינתן שם קצר אוטומטית, למשל: ערב עם חברות" />
            <label className="lb-label" htmlFor="look-builder-event">אירוע <span>אופציונלי</span></label>
            <input id="look-builder-event" className="lb-input" type="text" value={lookEvent} onChange={(e) => setLookEvent(e.target.value)} placeholder="למשל: עבודה, חתונה, ערב עם חברות" />
            <div className="lb-suggest">
              {["יומיומי", "עבודה", "ערב", "סוף שבוע", "אירוע", "חופשה", "ספורט"].map((event) => (
                <button key={event} type="button" className={lookEvent.split(",").map((v) => v.trim()).includes(event) ? "is-on" : ""} onClick={() => setLookEvent((current) => {
                  const list = current.split(",").map((v) => v.trim()).filter(Boolean);
                  return (list.includes(event) ? list.filter((v) => v !== event) : [...list, event]).join(", ");
                })}>{event}</button>
              ))}
            </div>
            <label className="lb-label" htmlFor="look-builder-tags">תגיות <span>אופציונלי, מופרדות בפסיק</span></label>
            <input id="look-builder-tags" className="lb-input" type="text" value={lookTagText} onChange={(e) => setLookTagText(e.target.value)} placeholder="למשל: קיץ, אהוב, לים" />
          </section>
        </div>

        <footer className="lb-footer">
          {builderError && <p className="lb-error" role="alert">{builderError}</p>}
          {paidUnsaved && !builderError && <p className="lb-paid" role="status">הלוק כבר שולם. שמרי אותו כדי לא לאבד אותו.</p>}

          <div className="lb-footer__actions">
            {generatedLook && editLook ? null : generatedLook ? (
              <button className="lb-button is-primary" type="button" disabled={saving || generating} onClick={() => handleSave()}>
                <FloppyDisk size={15} />
                <span>{saving ? "שומר..." : "שמירה"}</span>
              </button>
            ) : (
              <button className="lb-button is-primary" type="button" disabled={!selectedIds.length || generating} onClick={() => handleGenerate()}>
                {generating && <ArrowClockwise size={15} className="spin" />}
                <span>{generating ? "יוצר..." : "יצירה"}</span>
                {!generating && <small>{price}</small>}
              </button>
            )}
          </div>
          {generatedLook && editLook && (
            <div className="lb-footer__save">
              <button className="lb-button" type="button" disabled={saving || generating} onClick={() => handleSave({ asNew: true })}>
                <Copy size={15} />
                <span>{saving === "new" ? "שומר..." : "שמירה כלוק חדש"}</span>
              </button>
              <button className="lb-button is-primary" type="button" disabled={saving || generating} onClick={() => handleSave()}>
                <FloppyDisk size={15} />
                <span>{saving === "update" ? "שומר..." : "עדכון הלוק"}</span>
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}

function AutoOutfitsModal({ onClose, onCreated }) {
  const [count, setCount] = useState(1);
  const [occasion, setOccasion] = useState("everyday");
  const [notes, setNotes] = useState("");
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
          notes: notes.trim() || undefined,
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
          <div>
            <h2>יצירה אוטומטית של לוקים</h2>
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--muted)" }}>ה-AI בוחר שילובים ומלביש אותם עלייך. הלוקים נשמרים אוטומטית.</p>
          </div>
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

        <div style={{ marginBottom: "20px" }}>
          <label htmlFor="auto-looks-note" style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "var(--muted)", marginBottom: "8px" }}>
            הערה ל-AI (אופציונלי)
          </label>
          <textarea
            id="auto-looks-note"
            className="item-sheet__textarea"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={AI_NOTE_HINT}
          />
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
            <span>{generating ? "יוצר לוקים..." : `צור לוקים (${autoLooksPrice(count)})`}</span>
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
  const isWardrobeView = !["looks", "luggage", "archive", "wishlist"].includes(activeType);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedLook, setSelectedLook] = useState(null);
  const [archived, setArchived] = useState([]);
  const [wishlist, setWishlist] = useState([]);
  const [lookFilters, setLookFilters] = useState(EMPTY_LOOK_FILTERS);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const visibleLooks = useMemo(() => outfits.filter((look) => matchesLookFilters(look, lookFilters, itemsById)), [outfits, lookFilters, itemsById]);
  // Look photos opened full screen from the looks page: { look, index }
  const [lookZoom, setLookZoom] = useState(null);
  // Looks found to be photos of the user (for older looks that did not record it)
  const [photoLooks, setPhotoLooks] = useState({});
  const [packingLookId, setPackingLookId] = useState(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [inspirationOpen, setInspirationOpen] = useState(false);
  const [builderMode, setBuilderMode] = useState("flatlay");
  const [autoModalOpen, setAutoModalOpen] = useState(false);
  const [builderInitialItems, setBuilderInitialItems] = useState([]);
  const [builderInitialExtras, setBuilderInitialExtras] = useState({});
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  // One selection at a time: wardrobe items, looks, suitcases, Wishlist or archive.
  // Opening a selection of another kind (or changing tab) closes the previous one.
  const [selectKind, setSelectKind] = useState(null);
  const [checkedIds, setCheckedIds] = useState([]);
  const selectMode = selectKind === "items";
  const setSelectMode = (on) => { setSelectKind(on ? "items" : null); setCheckedIds([]); };
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
  const paneRef = useRef(null);
  const [suitcases, setSuitcases] = useState([]);
  const [activeSuitcaseId, setActiveSuitcaseId] = useState(null);
  const [luggageFlatlayModalOpen, setLuggageFlatlayModalOpen] = useState(false);
  const [luggageFlatlayData, setLuggageFlatlayData] = useState(null);

  useEffect(() => {
    const stopScroll = startSmoothScroll();
    const stopOverlays = watchOverlays();
    return () => { stopScroll(); stopOverlays(); };
  }, []);

  // Tags are shown in Hebrew: translate any English ones once per wardrobe per visit
  const tagTranslationTried = useRef(new Set());
  useEffect(() => {
    if (tagTranslationTried.current.has(activeWardrobeId)) return;
    if (!items.some((item) => (item.tags || []).some((tag) => /[a-z]/i.test(tag)))) return;
    tagTranslationTried.current.add(activeWardrobeId);
    fetch(`/api/import/tags/translate?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "POST",
      headers: { "x-wardrobe-id": activeWardrobeId },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((result) => { if (result?.itemsChanged) fetchWardrobe(); })
      .catch(() => {});
  }, [items, activeWardrobeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cards rise into place when the wardrobe loads or the tab changes
  useLayoutEffect(() => {
    if (loading || !paneRef.current) return;
    revealChildren(paneRef.current.querySelectorAll(".gallery-grid, .luggage-packed-grid"));
  }, [activeType, loading]);

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

  const fetchArchive = useCallback(async () => {
    try {
      const res = await fetch(`/api/import/archive?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        headers: { "x-wardrobe-id": activeWardrobeId },
      });
      if (res.ok) {
        const data = await res.json();
        setArchived(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, [activeWardrobeId]);

  const fetchWishlist = useCallback(async () => {
    try {
      const res = await fetch(`/api/import/wishlist?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        headers: { "x-wardrobe-id": activeWardrobeId },
      });
      if (res.ok) {
        const data = await res.json();
        setWishlist(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, [activeWardrobeId]);

  // Older flat lays are laid out again on the wardrobe card colour, a few at a time
  const flatlayRefresh = useRef(false);
  useEffect(() => {
    if (flatlayRefresh.current || !outfits.length) return;
    flatlayRefresh.current = true;
    (async () => {
      let changed = false;
      let failures = 0;
      for (let round = 0; round < 120; round++) {
        try {
          const res = await fetch(`/api/import/outfits/refresh-flatlays?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, { method: "POST", headers: { "x-wardrobe-id": activeWardrobeId } });
          if (!res.ok) { if (++failures > 3) break; continue; }
          const data = await res.json();
          if (data.refreshed) changed = true;
          // Show the looks done so far every few rounds
          if (changed && round % 4 === 3) fetchOutfits();
          if (!data.remaining) break;
        } catch { if (++failures > 3) break; }
      }
      if (changed) fetchOutfits();
    })();
  }, [outfits.length, activeWardrobeId, fetchOutfits]);

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
    fetchArchive();
    fetchWishlist();

    // Auto-sync across devices: poll while visible and whenever the tab becomes active.
    // Kept infrequent because every request counts toward the hosting quota.
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fetchWardrobe();
      fetchSuitcases();
      fetchOutfits();
    }, 60000);

    // Coming back to the tab syncs at most once every 30 seconds
    let lastSync = Date.now();
    const onSync = () => {
      if (Date.now() - lastSync < 30000) return;
      lastSync = Date.now();
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
  }, [activeWardrobeId, fetchWardrobe, fetchSuitcases, fetchOutfits, fetchUserProfile, fetchWardrobesList, fetchArchive, fetchWishlist]);

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
    if (!isWardrobeView) return [];
    const filtered = (activeType === "all"
      ? items
      : items.filter((item) => {
          if (activeType === "dress") return item.part === "dress" || item.part === "wholebody";
          if (activeType === "wholebody_up") return item.part === "wholebody_up" || item.part === "outerwear" || item.part === "jacket";
          return item.part === activeType;
        })).filter((item) => matchesFilters(item, filters));
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items, filters]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
    setSelectKind(null);
    setCheckedIds([]);
  };

  const saveSuitcase = (suitcase) => {
    const saved = { ...suitcase, garmentIds: [...new Set(suitcase.garmentIds || [])], outfitIds: [...new Set(suitcase.outfitIds || [])] };
    setSuitcases((current) => current.some((s) => s.id === saved.id) ? current.map((s) => (s.id === saved.id ? saved : s)) : [...current, saved]);
    fetch(`/api/import/suitcases?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
      body: JSON.stringify(saved),
    }).catch(() => setError("לא ניתן לשמור את המזוודה כרגע."));
  };

  const createSuitcase = (title, ids = [], field = "garmentIds") => {
    const suitcase = { id: newSuitcaseId(), title, garmentIds: [], outfitIds: [], [field]: ids, createdAt: new Date().toISOString() };
    saveSuitcase(suitcase);
    setActiveSuitcaseId(suitcase.id);
    return suitcase;
  };

  // field is "garmentIds" for wardrobe items or "outfitIds" for saved looks
  const addToSuitcase = (id, itemIds, field = "garmentIds") => {
    const suitcase = suitcases.find((s) => s.id === id);
    if (suitcase) saveSuitcase({ ...suitcase, [field]: [...(suitcase[field] || []), ...itemIds] });
  };

  const removeFromSuitcase = (id, itemIds, field = "garmentIds") => {
    const suitcase = suitcases.find((s) => s.id === id);
    if (suitcase) saveSuitcase({ ...suitcase, [field]: (suitcase[field] || []).filter((x) => !itemIds.includes(x)) });
  };

  const toggleInSuitcase = (id, itemId, field = "garmentIds") => {
    const suitcase = suitcases.find((s) => s.id === id);
    if (!suitcase) return;
    if (suitcase[field]?.includes(itemId)) removeFromSuitcase(id, [itemId], field);
    else addToSuitcase(id, [itemId], field);
  };

  const deleteSuitcase = (id) => {
    setSuitcases((current) => current.filter((s) => s.id !== id));
    if (activeSuitcaseId === id) setActiveSuitcaseId(null);
    fetch(`/api/import/suitcases/${encodeURIComponent(id)}?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "DELETE",
      headers: { "x-wardrobe-id": activeWardrobeId },
    }).catch(() => {});
  };

  const openLookBuilder = (itemIds, mode = "flatlay", extras = {}) => {
    setBuilderInitialItems(itemIds);
    setBuilderInitialExtras(extras);
    setBuilderMode(mode);
    setBuilderOpen(true);
  };

  const toggleChecked = (id) => setCheckedIds((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  const exitSelectMode = () => { setSelectKind(null); setCheckedIds([]); };
  const viewSelectKind = activeType === "looks" ? "looks" : activeType === "luggage" ? "suitcases" : activeType === "wishlist" ? "wishlist" : activeType === "archive" ? "archive" : "items";
  const startSelect = () => { setCheckedIds([]); setSelectKind(viewSelectKind); };

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

  // Throws when the server did not save, so the item window can say so
  const saveItem = async (updatedItem) => {
    setItems((current) => current.map((item) => (item.id === updatedItem.id ? updatedItem : item)));
    const response = await fetch(`/api/import/wardrobe/${updatedItem.id}?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
      body: JSON.stringify(updatedItem),
    });
    if (!response.ok) throw new Error("save failed");
    try {
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
      fetchArchive();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  // Several items at once, from the selection bar. They go to the archive.
  const archiveSelected = async (ids) => {
    if (!ids.length) return;
    if (!window.confirm(ids.length === 1 ? "להעביר את הפריט לארכיון?" : `להעביר ${ids.length} פריטים לארכיון?`)) return;
    setItems((current) => current.filter((item) => !ids.includes(item.id)));
    exitSelectMode();
    try {
      const res = await fetch(`/api/import/wardrobe/archive?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("לא ניתן למחוק כרגע");
    } catch (requestError) {
      setError(requestError.message);
    }
    fetchWardrobe();
    fetchArchive();
  };

  const restoreArchived = async (ids) => {
    const res = await fetch(`/api/import/archive/restore?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) setError("לא ניתן להחזיר כרגע");
    await Promise.all([fetchWardrobe(), fetchArchive()]);
  };

  const purgeArchived = async (ids) => {
    const res = await fetch(`/api/import/archive/purge?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wardrobe-id": activeWardrobeId },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) setError("לא ניתן למחוק כרגע");
    await fetchArchive();
  };

  // Deletes what is selected in the current selection (looks, suitcases, Wishlist photos, archive for good)
  const deleteChecked = async () => {
    const ids = [...checkedIds];
    if (!ids.length) return;
    const noun = { looks: ids.length === 1 ? "הלוק" : `${ids.length} לוקים`, suitcases: ids.length === 1 ? "המזוודה" : `${ids.length} מזוודות`, wishlist: ids.length === 1 ? "התמונה מה-Wishlist" : `${ids.length} תמונות מה-Wishlist`, archive: ids.length === 1 ? "הפריט לצמיתות" : `${ids.length} פריטים לצמיתות` }[selectKind];
    if (!window.confirm(`למחוק את ${noun}? אי אפשר לבטל את זה.`)) return;
    if (selectKind === "looks") await Promise.all(ids.map((id) => deleteOutfit(id)));
    if (selectKind === "suitcases") ids.forEach((id) => deleteSuitcase(id));
    if (selectKind === "wishlist") {
      await Promise.all(ids.map((id) => fetch(`/api/import/wishlist/${id}?wardrobeId=${encodeURIComponent(activeWardrobeId)}`, { method: "DELETE", headers: { "x-wardrobe-id": activeWardrobeId } }).catch(() => {})));
      setWishlist((current) => current.filter((entry) => !ids.includes(entry.id)));
    }
    if (selectKind === "archive") await purgeArchived(ids);
    exitSelectMode();
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
    setItems((current) => current.some((item) => item.id === newItem.id) ? current.map((item) => item.id === newItem.id ? { ...item, ...newItem } : item) : [...current, newItem]);
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => item.id === id ? { ...item, modeledImage } : item));
  }, []);

  return (
    <div className={`app-shell${selectedItem ? " has-selection" : ""}`}>
      <div className="ambient-bg" aria-hidden="true" />
      <main className="gallery-pane" ref={paneRef}>
        <header className="gallery-header">
          <AnimatedTitle text={currentUser?.name ? `המלתחה של ${currentUser.name.split(" ")[0]}` : "המלתחה שלי"} />
          <div className="gallery-meta-row">
            <p className="piece-count">
              {activeType === "looks"
                ? `${outfits.length} ${outfits.length === 1 ? "לוק" : "לוקים"}`
                : activeType === "luggage"
                ? `${suitcases.length} ${suitcases.length === 1 ? "מזוודה" : "מזוודות"}`
                : activeType === "archive"
                ? `${archived.length} בארכיון`
                : activeType === "wishlist"
                ? `${wishlist.length} ${wishlist.length === 1 ? "פריט" : "פריטים"} לקנות`
                : `${items.length} ${items.length === 1 ? "פריט" : "פריטים"}`}
            </p>
            <div className="header-actions">
              <RefreshButton />
              <button
                type="button"
                className="user-account-header-btn"
                onClick={() => setUserModalOpen(true)}
                title="הארון שלי: שם, תמונת מודל, טלפון וארונות נוספים"
                aria-label={`הארון שלי: ${currentUser?.name || "שני אסולין"}`}
              >
                <span className="user-account-avatar">
                  {currentUser?.name ? currentUser.name.slice(0, 1) : "ש"}
                </span>
                <span className="user-account-text" style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", lineHeight: "1.15", textAlign: "right" }}>
                  <span style={{ fontSize: "12px", fontWeight: "600", color: "var(--ink)" }}>{currentUser?.name || "שני אסולין"}</span>
                  <span style={{ fontSize: "10px", color: "var(--muted)" }}>הארון שלי</span>
                </span>
                <CaretDown className="user-account-caret" size={11} weight="bold" style={{ opacity: 0.6, marginInlineStart: "2px" }} />
                <span className="user-sync-indicator" title="מסונכרן עם השרת בזמן אמת" />
              </button>

              {((isWardrobeView && items.length > 0) || (activeType === "looks" && outfits.length > 0) || (activeType === "luggage" && suitcases.length > 0) || (activeType === "wishlist" && wishlist.length > 0) || (activeType === "archive" && archived.length > 0)) && (
                <button
                  type="button"
                  className={`secondary-header-btn select-toggle${selectKind === viewSelectKind ? " is-active" : ""}`}
                  onClick={() => (selectKind === viewSelectKind ? exitSelectMode() : startSelect())}
                  aria-pressed={selectKind === viewSelectKind}
                >
                  <CheckSquare size={16} aria-hidden="true" />
                  <span className="label-long">{selectKind === viewSelectKind ? "סיום בחירה" : "בחירה"}</span>
                  <span className="label-short">{selectKind === viewSelectKind ? "סיום" : "בחירה"}</span>
                </button>
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
                aria-label={hasModelRef ? "החלפת תמונת מודל" : "העלאת תמונת מודל"}
              >
                {uploadingModelRef ? (
                  <ArrowClockwise size={16} className="spin" />
                ) : modelRefUrl ? (
                  <img src={modelRefUrl} alt="" className="model-ref-avatar" />
                ) : (
                  <User size={16} weight="regular" />
                )}
                <span className="model-ref-text">{uploadingModelRef ? "מעלה תמונה..." : hasModelRef ? "תמונת מודל ✓" : "העלאת תמונת מודל"}</span>
              </button>
            </div>
          </div>
          <nav className="category-nav" aria-label="סינון לפי קטגוריה">
            {TYPES.filter((type) => (type.id !== "archive" || archived.length > 0 || activeType === "archive") && true).map((type) => (
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
          {activeType === "looks" && (
            <div className="looks-actions">
              <button type="button" className="create-look-btn" onClick={() => openLookBuilder([], "flatlay")}>
                <span className="label-long">לוק ללא מודל (פריסה שטוחה)</span>
                <span className="label-short">פריסה שטוחה</span>
              </button>
              <button type="button" className="secondary-header-btn" onClick={() => openLookBuilder([], "modeled")}>
                <span>לוק על מודל</span>
              </button>
              <button type="button" className="secondary-header-btn" onClick={() => setInspirationOpen(true)}>
                <span className="label-long">השראה מתמונה</span>
                <span className="label-short">השראה</span>
              </button>
              <button type="button" className="create-auto-btn" onClick={() => setAutoModalOpen(true)}>
                <span className="label-long">יצירה אוטומטית</span>
                <span className="label-short">אוטומטי</span>
              </button>
            </div>
          )}
          {isWardrobeView && !!items.length && (
            <WardrobeFilters items={items} filters={filters} onChange={setFilters} />
          )}
        </header>

        {error && <p className="status error">{error}</p>}
        {!error && loading && <p className="status">טוען מלתחה...</p>}

        {/* LOOKS VIEW */}
        {activeType === "looks" && !loading && (
          <>
            {outfits.length > 0 && <LookFilters looks={outfits} items={items} filters={lookFilters} onChange={setLookFilters} />}
            {outfits.length > 0 && !visibleLooks.length && (
              <div className="empty-wardrobe-container">
                <div className="empty-wardrobe-card">
                  <h2 className="empty-wardrobe-title">אין לוקים שמתאימים לסינון</h2>
                  <button type="button" className="secondary-button" onClick={() => setLookFilters(EMPTY_LOOK_FILTERS)}>ניקוי הסינון</button>
                </div>
              </div>
            )}
            {outfits.length > 0 ? (
              <section className="gallery-grid looks-gallery" aria-label="לוקים">
                {visibleLooks.map((look) => (
                  <div key={look.id} className={`gallery-item look-tile${(lookIsPhoto(look) ?? photoLooks[look.id]) ? " is-photo" : ""}${selectKind === "looks" && checkedIds.includes(look.id) ? " is-checked" : ""}`}>
                    <button type="button" className="gallery-item__main" onClick={() => (selectKind === "looks" ? toggleChecked(look.id) : setSelectedLook(look))} aria-label={selectKind === "looks" ? `בחירת ${look.name}` : `צפייה בלוק ${look.name}`} aria-pressed={selectKind === "looks" ? checkedIds.includes(look.id) : undefined}>
                      <LookTileImage look={look} onPhoto={(isPhoto) => setPhotoLooks((current) => current[look.id] === isPhoto ? current : { ...current, [look.id]: isPhoto })} />
                      {selectKind === "looks" && <span className="gallery-item__check" aria-hidden="true">{checkedIds.includes(look.id) && <Check size={16} weight="bold" />}</span>}
                    </button>
                  </div>
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
            outfits={outfits}
            onOpenLook={setSelectedLook}
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
            selecting={selectKind === "suitcases"}
            checkedIds={checkedIds}
            onToggleCheck={toggleChecked}
          />
        )}

        {activeType === "wishlist" && (
          <WishlistView items={wishlist} wardrobeId={activeWardrobeId} selecting={selectKind === "wishlist"} checkedIds={checkedIds} onToggleCheck={toggleChecked} onChange={(entry) => setWishlist((current) => current.some((other) => other.id === entry.id) ? current.map((other) => other.id === entry.id ? entry : other) : [entry, ...current])} onRemoved={(id) => setWishlist((current) => current.filter((other) => other.id !== id))} />
        )}
        {activeType === "archive" && (
          <ArchiveView items={archived} selecting={selectKind === "archive"} checkedIds={checkedIds} onToggleCheck={toggleChecked} onRestore={restoreArchived} />
        )}

        {/* WARDROBE ITEMS VIEW */}
        {isWardrobeView && !error && !loading && !items.length && (
          <div className="empty-wardrobe-container">
            <div className="empty-wardrobe-card">
              <h2 className="empty-wardrobe-title">המלתחה ריקה</h2>
              <p className="empty-wardrobe-text">
                העלו תמונות של פריטי לבוש כדי להתחיל לבנות את המלתחה.
              </p>
            </div>
          </div>
        )}

        {isWardrobeView && !!items.length && !visibleItems.length && (
          <div className="empty-wardrobe-container">
            <div className="empty-wardrobe-card">
              <h2 className="empty-wardrobe-title">אין פריטים שמתאימים</h2>
              <p className="empty-wardrobe-text">נסי להסיר חלק מהסינון או לבחור קטגוריה אחרת.</p>
              <button type="button" className="secondary-button" onClick={() => setFilters(EMPTY_FILTERS)}>ניקוי הסינון</button>
            </div>
          </div>
        )}

        {isWardrobeView && !!items.length && (
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

      {selectKind && selectKind !== "items" && (
        <div className="selection-bar" role="region" aria-label="פעולות על מה שנבחר">
          <span className="selection-bar__count">
            {checkedIds.length ? `נבחרו ${checkedIds.length}` : { looks: "בחרי לוקים", suitcases: "בחרי מזוודות", wishlist: "בחרי תמונות מה-Wishlist", archive: "בחרי פריטים מהארכיון" }[selectKind]}
          </span>
          <div className="selection-bar__actions">
            <button type="button" className="secondary-button" onClick={() => {
              const all = { looks: visibleLooks, suitcases, wishlist, archive: archived }[selectKind] || [];
              setCheckedIds(checkedIds.length === all.length ? [] : all.map((entry) => entry.id));
            }}>
              {checkedIds.length && checkedIds.length === ({ looks: visibleLooks, suitcases, wishlist, archive: archived }[selectKind] || []).length ? "ביטול הבחירה" : "בחירת הכל"}
            </button>
            {selectKind === "archive" && (
              <button type="button" className="secondary-button" disabled={!checkedIds.length} onClick={async () => { await restoreArchived(checkedIds); exitSelectMode(); }}>
                <ArrowCounterClockwise size={15} aria-hidden="true" /> החזרה לארון
              </button>
            )}
            <button type="button" className="secondary-button selection-bar__delete" disabled={!checkedIds.length} onClick={() => deleteChecked()}>
              <Trash size={15} aria-hidden="true" /> {selectKind === "archive" ? "מחיקה לצמיתות" : "מחיקה"}
            </button>
            <button type="button" className="import-icon-button" onClick={exitSelectMode} aria-label="ביטול הבחירה"><X size={18} /></button>
          </div>
        </div>
      )}

      {selectMode && (
        <div className="selection-bar" role="region" aria-label="פעולות על הפריטים שנבחרו">
          <span className="selection-bar__count">{checkedIds.length ? `נבחרו ${checkedIds.length}` : "בחרי פריטים מהארון"}</span>
          <div className="selection-bar__actions">
            <button type="button" className="primary-button" disabled={!checkedIds.length} onClick={() => { openLookBuilder(checkedIds, "flatlay"); exitSelectMode(); }}>
              <MagicWand size={15} aria-hidden="true" /> לוק בפריסה (חינם)
            </button>
            <button type="button" className="secondary-button" disabled={!checkedIds.length} onClick={() => { openLookBuilder(checkedIds, "modeled"); exitSelectMode(); }}>
              <User size={15} aria-hidden="true" /> לוק עליי (AI)
            </button>
            <button type="button" className="secondary-button" disabled={!checkedIds.length} onClick={() => setPackingIds(checkedIds)}>
              <Suitcase size={15} aria-hidden="true" /> למזוודה
            </button>
            <button type="button" className="secondary-button selection-bar__delete" disabled={!checkedIds.length} onClick={() => archiveSelected(checkedIds)}>
              <Trash size={15} aria-hidden="true" /> מחיקה
            </button>
            <button type="button" className="import-icon-button" onClick={exitSelectMode} aria-label="ביטול הבחירה"><X size={18} /></button>
          </div>
        </div>
      )}

      {packingLookId && (
        <SuitcasePicker
          suitcases={suitcases}
          itemIds={[packingLookId]}
          field="outfitIds"
          onAdd={(id, ids) => addToSuitcase(id, ids, "outfitIds")}
          onRemove={(id, ids) => removeFromSuitcase(id, ids, "outfitIds")}
          onCreate={(title, ids) => createSuitcase(title, ids, "outfitIds")}
          onClose={() => setPackingLookId(null)}
        />
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
          modelRefUrl={modelRefUrl}
          suitcaseCount={suitcases.filter((s) => s.garmentIds?.includes(selectedItem.id)).length}
          onPack={(id) => setPackingIds([id])}
          onCreateLook={(id) => { setSelectedId(null); openLookBuilder([id], "flatlay"); }}
          onClose={() => setSelectedId(null)}
          onSave={saveItem}
          onDelete={deleteItem}
          onModeledGenerated={(updatedItem) => {
            setItems((current) => current.map((i) => i.id === updatedItem.id ? updatedItem : i));
          }}
          onItemCreated={(newItem) => setItems((current) => [...current, newItem])}
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

      {inspirationOpen && (
        <InspirationModal
          items={items}
          wardrobeId={activeWardrobeId}
          onClose={() => setInspirationOpen(false)}
          onCreateLook={(ids) => { setInspirationOpen(false); openLookBuilder(ids, "flatlay"); }}
          onWishlistAdded={(entry) => setWishlist((current) => current.some((other) => other.id === entry.id) ? current.map((other) => other.id === entry.id ? entry : other) : [entry, ...current])}
        />
      )}
      {builderOpen && (
        <CustomOutfitModal
          items={items}
          onUpdateItem={saveItem}
          modelRefUrl={modelRefUrl}
          initialItemIds={builderInitialItems}
          initialMode={builderMode}
          initialNotes={builderInitialExtras.notes}
          initialStyling={builderInitialExtras.styling}
          editLook={builderInitialExtras.editLook || null}
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
          isPhoto={Boolean(photoLooks[selectedLook.id])}
          items={items}
          onClose={() => setSelectedLook(null)}
          onDelete={deleteOutfit}
          suitcaseCount={suitcases.filter((s) => s.outfitIds?.includes(selectedLook.id)).length}
          onPack={() => setPackingLookId(selectedLook.id)}
          onCreateOnMe={(look) => {
            const ids = (look.garmentIds || []).filter((id) => items.some((item) => item.id === id));
            setSelectedLook(null);
            openLookBuilder(ids, "modeled", { notes: [look.notes, stylingSummary(look.styling)].filter(Boolean).join(". ") });
          }}
          onEdit={(look) => {
            const ids = (look.garmentIds || []).filter((id) => items.some((item) => item.id === id));
            setSelectedLook(null);
            openLookBuilder(ids, look.mode === "modeled" || (look.mode !== "flatlay" && photoLooks[look.id]) ? "modeled" : "flatlay", { notes: look.notes || "", styling: look.styling || null, editLook: look });
          }}
        />
      )}

      {lookZoom && <ImageLightbox images={lookImages(lookZoom.look, items)} startIndex={lookZoom.index} onClose={() => setLookZoom(null)} />}

      <WardrobeImportFlow key={activeWardrobeId} hidden={activeType === "looks" || activeType === "archive" || activeType === "wishlist" || Boolean(selectKind) || Boolean(selectedItem) || builderOpen || inspirationOpen || autoModalOpen || Boolean(selectedLook) || userModalOpen || Boolean(packingIds) || Boolean(packingLookId) || luggageFlatlayModalOpen} onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} />
    </div>
  );
}
