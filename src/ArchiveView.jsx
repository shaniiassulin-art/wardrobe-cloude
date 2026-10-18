import { useState } from "react";
import { ArrowCounterClockwise, Check, Trash } from "@phosphor-icons/react";
import { fittedImage, imageFallback, thumbUrl } from "./image-files.js";

const formatDate = (iso) => {
  try { return new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" }); } catch { return ""; }
};

// Items that were deleted. They can be brought back to the wardrobe, or deleted
// for good (which also removes their photos).
export function ArchiveView({ items, onRestore, onPurge }) {
  const [checked, setChecked] = useState([]);
  const [busy, setBusy] = useState(null);
  const toggle = (id) => setChecked((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  const allChecked = items.length > 0 && checked.length === items.length;

  const run = async (kind, ids) => {
    if (!ids.length) return;
    if (kind === "purge" && !window.confirm(ids.length === 1 ? "למחוק את הפריט לצמיתות? אי אפשר לבטל את זה." : `למחוק ${ids.length} פריטים לצמיתות? אי אפשר לבטל את זה.`)) return;
    setBusy(kind);
    try {
      await (kind === "restore" ? onRestore(ids) : onPurge(ids));
      setChecked((current) => current.filter((id) => !ids.includes(id)));
    } finally {
      setBusy(null);
    }
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
      <div className="archive-bar">
        <button type="button" className="archive-bar__all" onClick={() => setChecked(allChecked ? [] : items.map((item) => item.id))}>
          {allChecked ? "ביטול הבחירה" : "בחירת הכל"}
        </button>
        <span className="archive-bar__count">{checked.length ? `נבחרו ${checked.length}` : `${items.length} פריטים בארכיון`}</span>
        <div className="archive-bar__actions">
          <button type="button" className="secondary-button" disabled={!checked.length || Boolean(busy)} onClick={() => run("restore", checked)}>
            <ArrowCounterClockwise size={15} aria-hidden="true" /> {busy === "restore" ? "מחזיר..." : "החזרה לארון"}
          </button>
          <button type="button" className="delete-button" disabled={!checked.length || Boolean(busy)} onClick={() => run("purge", checked)}>
            <Trash size={15} aria-hidden="true" /> {busy === "purge" ? "מוחק..." : "מחיקה לצמיתות"}
          </button>
        </div>
      </div>
      <div className="gallery-grid archive-grid">
        {items.map((item) => {
          const isChecked = checked.includes(item.id);
          return (
            <div key={item.id} className={`gallery-item archive-item${isChecked ? " is-checked" : ""}`}>
              <button type="button" className="gallery-item__main" aria-pressed={isChecked} onClick={() => toggle(item.id)} aria-label={`בחירת ${item.name || "פריט"}`}>
                <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 320)} onError={imageFallback(item.thumbnail || item.image)} alt="" loading="lazy" decoding="async" />
                <span className="gallery-item__check" aria-hidden="true">{isChecked && <Check size={16} weight="bold" />}</span>
              </button>
              <p className="gallery-item__name">{item.name}</p>
              <p className="archive-item__date">נמחק ב-{formatDate(item.archivedAt)}</p>
              <button type="button" className="archive-item__restore" disabled={Boolean(busy)} onClick={() => run("restore", [item.id])}>
                <ArrowCounterClockwise size={13} aria-hidden="true" /> החזרה
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
