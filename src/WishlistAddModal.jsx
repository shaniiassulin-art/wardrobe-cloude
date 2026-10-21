import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Heart, ImageSquare, MagicWand, Plus, Trash, X } from "@phosphor-icons/react";
import { fileToUploadDataUrl } from "./image-files.js";
import { PRICES } from "./prices.js";
import { saveWishlistPiece } from "./wishlist-api.js";

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
      update(photo.key, () => ({ status: "done", pieces: data.pieces }));
    } catch (err) {
      update(photo.key, () => ({ status: "error", error: err.message }));
    }
  };

  const pending = photos.filter((photo) => photo.status === "ready" || photo.status === "error");
  const analyzing = photos.some((photo) => photo.status === "analyzing");
  const analyzeAll = () => pending.forEach((photo) => analyze(photo));

  // The photo is saved once with its first piece; more pieces of it join the same entry
  const entries = useRef({});
  const save = async (photo, piece, index) => {
    update(photo.key, (current) => ({ saved: { ...current.saved, [index]: "saving" } }));
    try {
      const data = await saveWishlistPiece({ wardrobeId, entryId: entries.current[photo.key], imageDataUrl: photo.dataUrl, piece });
      entries.current[photo.key] = data.id;
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
