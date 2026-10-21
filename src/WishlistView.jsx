import { useState } from "react";
import { Check, Trash } from "@phosphor-icons/react";

const PART_LABELS = {
  upperbody: "חולצה",
  wholebody_up: "עליונית",
  lowerbody: "מכנסיים / חצאית",
  dress: "שמלה",
  shoes: "נעליים",
  accessories_up: "אקססורי",
};

// Pieces missing from the wardrobe, saved from inspiration photos, to look for in stores
export function WishlistView({ items, onRemove }) {
  const [busy, setBusy] = useState(null);

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
        {items.map((item) => (
          <article key={item.id} className="gallery-item wishlist-item">
            <div className="wishlist-item__img">
              {item.image
                ? <img src={item.image} alt="" loading="lazy" decoding="async" />
                : <span className="wishlist-item__swatch" style={{ background: item.color || "#d8d0c2" }} aria-hidden="true" />}
            </div>
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
        ))}
      </div>
    </section>
  );
}
