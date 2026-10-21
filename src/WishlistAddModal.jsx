import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Heart, ImageSquare, MagicWand, Plus, Trash, X } from "@phosphor-icons/react";
import { fileToUploadDataUrl } from "./image-files.js";
import { PRICES } from "./prices.js";

// A small preview of one piece, cut out of the photo in the browser
async function cropPreview(dataUrl, box, max = 320) {
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = reject;
    element.src = dataUrl;
  });
  const pad = 0.12;
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  const x0 = box ? Math.max(0, (box.x / 1000 - (box.width / 1000) * pad) * W) : 0;
  const y0 = box ? Math.max(0, (box.y / 1000 - (box.height / 1000) * pad) * H) : 0;
  const x1 = box ? Math.min(W, ((box.x + box.width) / 1000 + (box.width / 1000) * pad) * W) : W;
  const y1 = box ? Math.min(H, ((box.y + box.height) / 1000 + (box.height / 1000) * pad) * H) : H;
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(image, x0, y0, w, h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

let photoCounter = 0;

// Add screenshots or photos of pieces to the Wishlist: the AI names each piece with
// its exact color and description, and a piece is saved only when she taps "add"
export function WishlistAddModal({ wardrobeId, onAdded, onClose }) {
  const [photos, setPhotos] = useState([]);
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  const update = (key, change) => setPhotos((current) => current.map((photo) => photo.key === key ? { ...photo, ...change(photo) } : photo));

  const addFiles = async (files) => {
    setError("");
    for (const file of [...files]) {
      if (!(file.type?.startsWith("image/") || /\.(heic|heif)$/i.test(file.name || ""))) continue;
      try {
        const dataUrl = await fileToUploadDataUrl(file, 2048, 0.93);
        photoCounter += 1;
        setPhotos((current) => [...current, { key: `p${photoCounter}`, dataUrl, status: "ready", pieces: [], saved: {} }]);
      } catch (err) {
        setError(err.message || "לא ניתן לפתוח את התמונה.");
      }
    }
  };

  useEffect(() => {
    const onPaste = (event) => {
      const files = [...(event.clipboardData?.files || [])].filter((entry) => entry.type.startsWith("image/"));
      if (files.length) { event.preventDefault(); addFiles(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const analyze = async (photo) => {
    update(photo.key, () => ({ status: "analyzing", error: "" }));
    try {
      const res = await fetch("/api/import/wishlist/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": wardrobeId },
        body: JSON.stringify({ imageDataUrl: photo.dataUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "לא ניתן לזהות את הפריטים כרגע");
      const pieces = await Promise.all(data.pieces.map(async (piece) => ({ ...piece, preview: await cropPreview(photo.dataUrl, piece.box).catch(() => photo.dataUrl) })));
      update(photo.key, () => ({ status: "done", pieces }));
    } catch (err) {
      update(photo.key, () => ({ status: "error", error: err.message }));
    }
  };

  const pending = photos.filter((photo) => photo.status === "ready" || photo.status === "error");
  const analyzing = photos.some((photo) => photo.status === "analyzing");
  const analyzeAll = () => pending.forEach((photo) => analyze(photo));

  const save = async (photo, piece, index) => {
    update(photo.key, (current) => ({ saved: { ...current.saved, [index]: "saving" } }));
    try {
      const res = await fetch("/api/import/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": wardrobeId },
        body: JSON.stringify({ name: piece.name, part: piece.part, color: piece.color, colorName: piece.colorName, description: piece.description, box: piece.box, imageDataUrl: photo.dataUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "לא ניתן להוסיף ל-Wishlist כרגע");
      update(photo.key, (current) => ({ saved: { ...current.saved, [index]: "saved" } }));
      onAdded?.(data);
    } catch (err) {
      update(photo.key, (current) => ({ saved: { ...current.saved, [index]: undefined } }));
      setError(err.message);
    }
  };

  return (
    <div className="builder-modal-overlay look-builder-overlay" onMouseDown={(event) => event.target === event.currentTarget && !analyzing && onClose()}>
      <div className="builder-modal look-builder wish-add" role="dialog" aria-modal="true" aria-labelledby="wish-add-title">
        <header className="lb-header">
          <h2 id="wish-add-title">הוספה ל-Wishlist</h2>
          <button className="lb-close" type="button" onClick={onClose} aria-label="סגירה"><X size={18} /></button>
        </header>
        <div className="lb-body">
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(event) => { addFiles(event.target.files || []); event.target.value = ""; }} />
          {!photos.length ? (
            <section className="lb-section">
              <button type="button" className="inspo-drop" onClick={() => fileRef.current?.click()}>
                <ImageSquare size={30} />
                <strong>צילומי מסך ותמונות של פריטים</strong>
                <span>מחנות, מפינטרסט או מכל מקום. אפשר כמה תמונות ביחד, וגם להדביק תמונה שהעתקת.</span>
              </button>
            </section>
          ) : (
            photos.map((photo) => (
              <section key={photo.key} className="lb-section wish-add__photo">
                <div className="wish-add__head">
                  <img src={photo.dataUrl} alt="" />
                  <div className="wish-add__status">
                    {photo.status === "ready" && <span>מוכנה לזיהוי</span>}
                    {photo.status === "analyzing" && <span><ArrowClockwise size={13} className="spin" /> מזהה פריטים...</span>}
                    {photo.status === "done" && <span>{photo.pieces.length ? `${photo.pieces.length} ${photo.pieces.length === 1 ? "פריט" : "פריטים"} בתמונה` : "לא זוהו פריטים בתמונה"}</span>}
                    {photo.status === "error" && <span className="lb-error">{photo.error}</span>}
                  </div>
                  {photo.status !== "analyzing" && (
                    <button type="button" className="wishlist-item__btn is-icon" onClick={() => setPhotos((current) => current.filter((entry) => entry.key !== photo.key))} aria-label="הסרת התמונה">
                      <Trash size={13} />
                    </button>
                  )}
                </div>
                {photo.pieces.map((piece, index) => (
                  <div key={index} className="wish-add__piece">
                    <img src={piece.preview} alt="" />
                    <div className="wish-add__text">
                      <strong>
                        {piece.color && <span className="inspo-dot" style={{ background: piece.color }} aria-hidden="true" />}
                        {piece.name}
                      </strong>
                      {piece.colorName && <small>{piece.colorName}</small>}
                      {piece.description && <p>{piece.description}</p>}
                      <button type="button" className={`inspo-wish${photo.saved[index] === "saved" ? " is-saved" : ""}`} disabled={Boolean(photo.saved[index])} onClick={() => save(photo, piece, index)}>
                        <Heart size={14} weight={photo.saved[index] === "saved" ? "fill" : "regular"} />
                        <span>{photo.saved[index] === "saved" ? "נוסף ל-Wishlist" : photo.saved[index] === "saving" ? "מוסיף..." : "הוספה ל-Wishlist"}</span>
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            ))
          )}
          {photos.length > 0 && (
            <button type="button" className="lb-link wish-add__more" onClick={() => fileRef.current?.click()}>
              <Plus size={13} /> עוד תמונות
            </button>
          )}
        </div>
        <footer className="lb-footer">
          {error && <p className="lb-error" role="alert">{error}</p>}
          <div className="lb-footer__actions">
            <button className="lb-button is-ghost" type="button" disabled={analyzing} onClick={onClose}>סגירה</button>
            <button className="lb-button is-primary" type="button" disabled={!pending.length || analyzing} onClick={analyzeAll}>
              {analyzing ? <ArrowClockwise size={15} className="spin" /> : <MagicWand size={15} />}
              <span>{analyzing ? "מזהה..." : pending.length > 1 ? `זיהוי הפריטים (${pending.length} תמונות)` : "זיהוי הפריטים"}</span>
              {!analyzing && <small>{PRICES.inspiration}{pending.length > 1 ? " לתמונה" : ""}</small>}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
