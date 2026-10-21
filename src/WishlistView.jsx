import { useState } from "react";
import { ArrowClockwise, Check, MagicWand, Trash, X } from "@phosphor-icons/react";
import { ImageLightbox } from "./ImageLightbox.jsx";
import { PRICES } from "./prices.js";

const PART_LABELS = {
  upperbody: "חולצה",
  wholebody_up: "עליונית",
  lowerbody: "מכנסיים / חצאית",
  dress: "שמלה",
  shoes: "נעליים",
  accessories_up: "אקססורי",
};

// Pieces missing from the wardrobe, saved from inspiration photos
export function WishlistView({ items, wardrobeId, onRemove, onUpdate }) {
  const [busy, setBusy] = useState(null);
  const [openId, setOpenId] = useState(null);
  const open = items.find((item) => item.id === openId) || null;

  const remove = async (item, bought) => {
    if (!bought && !window.confirm(`להסיר את "${item.name}" מה-Wishlist?`)) return;
    setBusy(item.id);
    try { await onRemove(item.id); } finally { setBusy(null); }
  };

  if (!items.length) {
    return (
      <div className="empty-wardrobe-container">
        <div className="empty-wardrobe-card">
          <h2 className="empty-wardrobe-title">ה-Wishlist ריק</h2>
          <p className="empty-wardrobe-text">כשתעלי תמונת השראה בעמוד הלוקים, אפשר לשמור כאן פריטים שאין לך בארון, עם תמונה ותיאור מדויק.</p>
        </div>
      </div>
    );
  }

  return (
    <section className="wishlist-view" aria-label="Wishlist">
      <div className="gallery-grid wishlist-grid">
        {items.map((item) => {
          const cover = item.aiImage || item.image || item.photo;
          return (
            <article key={item.id} className="gallery-item wishlist-item">
              <button type="button" className={`wishlist-item__img${item.aiImage ? " is-ai" : ""}`} onClick={() => setOpenId(item.id)} aria-label={`פתיחת ${item.name}`}>
                {cover
                  ? <img src={cover} alt="" loading="lazy" decoding="async" />
                  : <span className="wishlist-item__swatch" style={{ background: item.color || "#d8d0c2" }} aria-hidden="true" />}
              </button>
              <p className="gallery-item__name">
                {item.color && <span className="inspo-dot" style={{ background: item.color }} aria-hidden="true" />}
                {item.name}
              </p>
              <p className="wishlist-item__part">{[PART_LABELS[item.part], item.colorName].filter(Boolean).join(" · ")}</p>
              {item.description && <p className="wishlist-item__desc">{item.description}</p>}
              <div className="wishlist-item__actions">
                <button type="button" className="wishlist-item__btn" disabled={busy === item.id} onClick={() => remove(item, true)} aria-label={`קניתי את ${item.name}`}>
                  <Check size={13} aria-hidden="true" /> קניתי
                </button>
                <button type="button" className="wishlist-item__btn is-icon" disabled={busy === item.id} onClick={() => remove(item, false)} aria-label={`הסרת ${item.name}`}>
                  <Trash size={13} aria-hidden="true" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {open && <WishlistItemModal item={open} wardrobeId={wardrobeId} onUpdate={onUpdate} onClose={() => setOpenId(null)} />}
    </section>
  );
}

// One wishlist piece: the cut-out, the whole inspiration photo, and an AI catalog
// photo made on request from the picture shown
function WishlistItemModal({ item, wardrobeId, onUpdate, onClose }) {
  const views = [
    item.image && { id: "image", label: "הפריט", src: item.image },
    item.photo && { id: "photo", label: "תמונת ההשראה", src: item.photo },
    item.aiImage && { id: "ai", label: "תמונת AI", src: item.aiImage },
  ].filter(Boolean);
  const [view, setView] = useState(item.aiImage ? "ai" : views[0]?.id);
  const [zoom, setZoom] = useState(false);
  const [making, setMaking] = useState(null);
  const [error, setError] = useState("");
  const current = views.find((entry) => entry.id === view) || views[0];
  // The AI photo is made from the cut-out unless the whole photo is shown
  const source = view === "photo" ? "photo" : "image";

  const make = async (quality) => {
    setMaking(quality);
    setError("");
    try {
      const res = await fetch(`/api/import/wishlist/${item.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wardrobe-id": wardrobeId },
        body: JSON.stringify({ quality, source }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "לא ניתן להכין תמונה כרגע");
      onUpdate?.(data);
      setView("ai");
    } catch (err) {
      setError(err.message);
    } finally {
      setMaking(null);
    }
  };

  return (
    <div className="builder-modal-overlay look-builder-overlay" onMouseDown={(event) => event.target === event.currentTarget && !making && onClose()}>
      <div className="builder-modal look-builder wish-modal" role="dialog" aria-modal="true" aria-labelledby="wish-title">
        <header className="lb-header">
          <h2 id="wish-title">{item.name}</h2>
          <button className="lb-close" type="button" onClick={onClose} aria-label="סגירה"><X size={18} /></button>
        </header>
        <div className="lb-body">
          {views.length > 1 && (
            <div className="lb-tabs wish-tabs" role="tablist">
              {views.map((entry) => (
                <button key={entry.id} type="button" role="tab" aria-selected={entry.id === current?.id} className={entry.id === current?.id ? "is-on" : ""} onClick={() => setView(entry.id)}>
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          {current && (
            <button type="button" className={`wish-view${current.id === "ai" ? " is-ai" : ""}`} onClick={() => setZoom(true)} aria-label="הגדלה">
              <img src={current.src} alt={current.label} />
              {making && <span className="lb-preview__busy"><ArrowClockwise size={18} className="spin" /></span>}
            </button>
          )}
          <section className="lb-section">
            <p className="wishlist-item__part">{[PART_LABELS[item.part], item.colorName].filter(Boolean).join(" · ")}</p>
            {item.description && <p className="wish-desc">{item.description}</p>}
          </section>
          <section className="lb-section">
            <h3 className="wish-make__title">הכנת תמונת פריט ב-AI</h3>
            <p className="lb-hint">
              {source === "photo"
                ? "תיעשה מתמונת ההשראה המלאה. מתאים כשהחיתוך פספס חלק מהפריט."
                : "תיעשה מהפריט החתוך: כך ה-AI רואה רק אותו ולא מתבלבל עם בגדים אחרים."}
            </p>
            <div className="wish-make">
              <button type="button" className="lb-button" disabled={Boolean(making)} onClick={() => make("low")}>
                {making === "low" ? <ArrowClockwise size={15} className="spin" /> : <MagicWand size={15} />}
                <span>{making === "low" ? "מכין..." : "איכות נמוכה"}</span>
                {making !== "low" && <small>{PRICES.catalogLow}</small>}
              </button>
              <button type="button" className="lb-button" disabled={Boolean(making)} onClick={() => make("medium")}>
                {making === "medium" ? <ArrowClockwise size={15} className="spin" /> : <MagicWand size={15} />}
                <span>{making === "medium" ? "מכין..." : "איכות בינונית"}</span>
                {making !== "medium" && <small>{PRICES.catalogMedium}</small>}
              </button>
            </div>
            {error && <p className="lb-error" role="alert">{error}</p>}
          </section>
        </div>
      </div>
      {zoom && current && (
        <ImageLightbox images={views.map((entry) => ({ src: entry.src, alt: entry.label }))} startIndex={views.indexOf(current)} onClose={() => setZoom(false)} />
      )}
    </div>
  );
}
