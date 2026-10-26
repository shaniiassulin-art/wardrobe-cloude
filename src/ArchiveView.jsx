import { useState } from "react";
import { ArrowCounterClockwise, Check } from "@phosphor-icons/react";
import { fittedImage, imageFallback, thumbUrl } from "./image-files.js";

const formatDate = (iso) => {
  try { return new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" }); } catch { return ""; }
};

// Items that were deleted. Each one can be brought back to the wardrobe; to restore
// or delete several (deleting for good also removes their photos) use "בחירה" at the top.
export function ArchiveView({ items, selecting = false, checkedIds = [], onToggleCheck, onRestore }) {
  const [busy, setBusy] = useState(null);

  const restore = async (id) => {
    setBusy(id);
    try { await onRestore([id]); } finally { setBusy(null); }
  };

  if (!items.length) {
    return (
      <div className="empty-wardrobe-container">
        <div className="empty-wardrobe-card">
          <h2 className="empty-wardrobe-title">הארכיון ריק</h2>
          <p className="empty-wardrobe-text">פריטים שמוחקים מהארון מגיעים לכאן, ואפשר להחזיר אותם.</p>
        </div>
      </div>
    );
  }

  return (
    <section className="archive-view" aria-label="ארכיון">
      <div className="gallery-grid archive-grid">
        {items.map((item) => {
          const isChecked = selecting && checkedIds.includes(item.id);
          return (
            <div key={item.id} className={`gallery-item archive-item${isChecked ? " is-checked" : ""}`}>
              <button
                type="button"
                className="gallery-item__main"
                aria-pressed={selecting ? isChecked : undefined}
                onClick={() => selecting && onToggleCheck?.(item.id)}
                aria-label={selecting ? `בחירת ${item.name || "פריט"}` : item.name || "פריט"}
                style={selecting ? undefined : { cursor: "default" }}
              >
                <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 320)} onError={imageFallback(item.thumbnail || item.image)} alt="" loading="lazy" decoding="async" />
                {selecting && <span className="gallery-item__check" aria-hidden="true">{isChecked && <Check size={16} weight="bold" />}</span>}
              </button>
              <p className="gallery-item__name">{item.name}</p>
              <p className="archive-item__date">נמחק ב-{formatDate(item.archivedAt)}</p>
              {!selecting && (
                <button type="button" className="archive-item__restore" disabled={Boolean(busy)} onClick={() => restore(item.id)}>
                  <ArrowCounterClockwise size={13} aria-hidden="true" /> {busy === item.id ? "מחזיר..." : "החזרה"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
