import { useState } from "react";
import { ArrowClockwise, Check, MagicWand, MagnifyingGlassPlus, Plus, Trash, X } from "@phosphor-icons/react";
import { ImageLightbox } from "./ImageLightbox.jsx";
import { WishlistAddModal } from "./WishlistAddModal.jsx";
import { PRICES } from "./prices.js";

const PART_LABELS = {
  upperbody: "חולצה",
  wholebody_up: "עליונית",
  lowerbody: "מכנסיים / חצאית",
  dress: "שמלה",
  shoes: "נעליים",
  accessories_up: "אקססורי",
};

// The Wishlist: one card per saved photo, with the pieces she wants from it
export function WishlistView({ items, wardrobeId, onChange, onRemoved }) {
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const open = items.find((entry) => entry.id === openId) || null;
  const addModal = adding && <WishlistAddModal wardrobeId={wardrobeId} onAdded={onChange} onClose={() => setAdding(false)} />;
  const addButton = (
    <button type="button" className="create-look-btn wishlist-add-btn" onClick={() => setAdding(true)}>
      <Plus size={15} aria-hidden="true" /> הוספת פריטים
    </button>
  );

  if (!items.length) {
    return (
      <div className="empty-wardrobe-container">
        <div className="empty-wardrobe-card">
          <h2 className="empty-wardrobe-title">ה-Wishlist ריק</h2>
          <p className="empty-wardrobe-text">אפשר להוסיף כאן צילומי מסך ותמונות של פריטים שאת רוצה, או לשמור פריטים מתמונת השראה בעמוד הלוקים.</p>
          {addButton}
        </div>
        {addModal}
      </div>
    );
  }

  return (
    <section className="wishlist-view" aria-label="Wishlist">
      <div className="wishlist-bar">{addButton}</div>
      <div className="gallery-grid wishlist-grid">
        {items.map((entry) => (
          <article key={entry.id} className="gallery-item wishlist-item">
            <button type="button" className="wishlist-item__img" onClick={() => setOpenId(entry.id)} aria-label="פתיחת התמונה">
              {entry.photo ? <img src={entry.photo} alt="" loading="lazy" decoding="async" /> : <span className="wishlist-item__swatch" aria-hidden="true" />}
              {entry.pieces.length > 1 && <span className="wishlist-item__count">{entry.pieces.length} פריטים</span>}
            </button>
            <ul className="wishlist-item__pieces">
              {entry.pieces.map((piece) => (
                <li key={piece.pid}>
                  {piece.color && <span className="inspo-dot" style={{ background: piece.color }} aria-hidden="true" />}
                  <span>{piece.name}{piece.colorName && <small> · {piece.colorName}</small>}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      {addModal}
      {open && <WishlistEntryModal entry={open} wardrobeId={wardrobeId} onChange={onChange} onRemoved={onRemoved} onClose={() => setOpenId(null)} />}
    </section>
  );
}

// One saved photo: zoom in and out, the pieces with their details, an AI catalog
// photo of a chosen piece at low or medium quality, and "bought" / remove per piece
function WishlistEntryModal({ entry, wardrobeId, onChange, onRemoved, onClose }) {
  const [zoomAt, setZoomAt] = useState(-1);
  const [making, setMaking] = useState(null); // `${pid}:${quality}`
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const gallery = [
    ...(entry.photo ? [{ src: entry.photo, alt: "תמונת ההשראה" }] : []),
    ...entry.pieces.filter((piece) => piece.aiImage).map((piece) => ({ src: piece.aiImage, alt: piece.name })),
  ];

  const make = async (piece, quality) => {
    setMaking(`${piece.pid}:${quality}`);
    setError("");
    try {
      const res = await fetch(`/api/import/wishlist/${entry.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": wardrobeId },
        body: JSON.stringify({ pieceId: piece.pid, quality }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "לא ניתן להכין תמונה כרגע");
      onChange?.(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setMaking(null);
    }
  };

  const removePiece = async (piece, bought) => {
    if (!bought && !window.confirm(`להסיר את "${piece.name}" מה-Wishlist?`)) return;
    setBusy(piece.pid);
    setError("");
    try {
      const res = await fetch(`/api/import/wishlist/${entry.id}/pieces/${piece.pid}`, { method: "DELETE", headers: { "x-wardrobe-id": wardrobeId } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "לא ניתן להסיר כרגע");
      if (data.deleted) { onRemoved?.(entry.id); onClose(); } else onChange?.(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="builder-modal-overlay look-builder-overlay" onMouseDown={(event) => event.target === event.currentTarget && !making && onClose()}>
      <div className="builder-modal look-builder wish-modal" role="dialog" aria-modal="true" aria-labelledby="wish-title">
        <header className="lb-header">
          <h2 id="wish-title">Wishlist</h2>
          <button className="lb-close" type="button" onClick={onClose} aria-label="סגירה"><X size={18} /></button>
        </header>
        <div className="lb-body">
          {entry.photo && (
            <button type="button" className="wish-view" onClick={() => setZoomAt(0)} aria-label="הגדלת התמונה">
              <img src={entry.photo} alt="תמונת ההשראה" />
              <span className="wish-view__zoom" aria-hidden="true"><MagnifyingGlassPlus size={16} /></span>
            </button>
          )}
          {entry.pieces.map((piece) => (
            <section key={piece.pid} className="lb-section wish-piece">
              <div className="wish-piece__head">
                <h3>
                  {piece.color && <span className="inspo-dot" style={{ background: piece.color }} aria-hidden="true" />}
                  {piece.name}
                </h3>
                <div className="wish-piece__actions">
                  <button type="button" className="wishlist-item__btn" disabled={busy === piece.pid} onClick={() => removePiece(piece, true)}>
                    <Check size={13} aria-hidden="true" /> קניתי
                  </button>
                  <button type="button" className="wishlist-item__btn is-icon" disabled={busy === piece.pid} onClick={() => removePiece(piece, false)} aria-label={`הסרת ${piece.name}`}>
                    <Trash size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <p className="wishlist-item__part">{[PART_LABELS[piece.part], piece.colorName].filter(Boolean).join(" · ")}</p>
              {piece.description && <p className="wish-desc">{piece.description}</p>}
              {piece.aiImage && (
                <button type="button" className="wish-ai" onClick={() => setZoomAt(gallery.findIndex((entryImage) => entryImage.src === piece.aiImage))} aria-label={`הגדלת תמונת ה-AI של ${piece.name}`}>
                  <img src={piece.aiImage} alt={piece.name} />
                </button>
              )}
              <div className="wish-make">
                {["low", "medium"].map((quality) => {
                  const on = making === `${piece.pid}:${quality}`;
                  return (
                    <button key={quality} type="button" className="lb-button" disabled={Boolean(making)} onClick={() => make(piece, quality)}>
                      {on ? <ArrowClockwise size={15} className="spin" /> : <MagicWand size={15} />}
                      <span>{on ? "מכין..." : `${piece.aiImage ? "שוב" : "תמונת AI"} · ${quality === "low" ? "נמוכה" : "בינונית"}`}</span>
                      {!on && <small>{quality === "low" ? PRICES.catalogLow : PRICES.catalogMedium}</small>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {error && <p className="lb-error" role="alert">{error}</p>}
        </div>
      </div>
      {zoomAt >= 0 && gallery.length > 0 && <ImageLightbox images={gallery} startIndex={Math.max(0, zoomAt)} onClose={() => setZoomAt(-1)} />}
    </div>
  );
}
