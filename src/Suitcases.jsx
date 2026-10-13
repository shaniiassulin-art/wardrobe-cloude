import { useEffect, useMemo, useState } from "react";
import { Check, MagicWand, PencilSimple, Plus, Suitcase, Trash, X } from "@phosphor-icons/react";
import { fittedImage } from "./image-files.js";

export const newSuitcaseId = () => `suitcase-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Chooses which suitcase(s) to pack the given items into, or creates a new one
export function SuitcasePicker({ suitcases, itemIds, onAdd, onRemove, onCreate, onClose }) {
  const [newTitle, setNewTitle] = useState("");
  const single = itemIds.length === 1;

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const create = (event) => {
    event.preventDefault();
    if (!newTitle.trim()) return;
    onCreate(newTitle.trim(), itemIds);
    setNewTitle("");
  };

  return (
    <div className="builder-modal-overlay suitcase-picker-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="builder-modal suitcase-picker" role="dialog" aria-modal="true" aria-labelledby="suitcase-picker-title">
        <header className="builder-header">
          <div>
            <h2 id="suitcase-picker-title">הוספה למזוודה</h2>
            <p>{single ? "בחרי לאיזו מזוודה להוסיף את הפריט." : `בחרי לאיזו מזוודה להוסיף ${itemIds.length} פריטים.`}</p>
          </div>
          <button className="import-icon-button" type="button" onClick={onClose} aria-label="סגירה"><X size={20} /></button>
        </header>

        {suitcases.length > 0 && (
          <ul className="suitcase-picker__list">
            {suitcases.map((suitcase) => {
              const containsAll = itemIds.every((id) => suitcase.garmentIds?.includes(id));
              return (
                <li key={suitcase.id}>
                  <Suitcase size={18} aria-hidden="true" />
                  <span className="suitcase-picker__name">
                    {suitcase.title || "מזוודה"}
                    <small>{suitcase.garmentIds?.length || 0} פריטים</small>
                  </span>
                  {containsAll ? (
                    single ? (
                      <button type="button" className="secondary-button" onClick={() => onRemove(suitcase.id, itemIds)}>
                        <Check size={14} /> במזוודה · הסרה
                      </button>
                    ) : (
                      <span className="suitcase-picker__done"><Check size={14} /> כבר בפנים</span>
                    )
                  ) : (
                    <button type="button" className="primary-button" onClick={() => onAdd(suitcase.id, itemIds)}>
                      <Plus size={14} /> הוספה
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form className="suitcase-picker__create" onSubmit={create}>
          <input
            className="account-input"
            type="text"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="מזוודה חדשה, למשל: חתונה באילת"
            aria-label="שם למזוודה חדשה"
          />
          <button type="submit" className="secondary-button" disabled={!newTitle.trim()}>
            <Plus size={14} /> יצירה והוספה
          </button>
        </form>
      </div>
    </div>
  );
}

// Suitcases tab: one suitcase per event, each saved on the server
export function LuggageView({ items, suitcases, activeId, onSelect, onCreate, onRename, onDelete, onToggleItem, onGenerateFlatlay, onOpenItem, typeLabel }) {
  const [newTitle, setNewTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(null);
  const active = suitcases.find((suitcase) => suitcase.id === activeId) || suitcases[0] || null;
  const packedItems = useMemo(() => (active ? items.filter((item) => active.garmentIds?.includes(item.id)) : []), [items, active]);
  const availableItems = useMemo(() => (active ? items.filter((item) => !active.garmentIds?.includes(item.id)) : []), [items, active]);

  const create = (event) => {
    event.preventDefault();
    if (!newTitle.trim()) return;
    onCreate(newTitle.trim(), []);
    setNewTitle("");
  };

  const saveTitle = () => {
    if (editingTitle !== null && editingTitle.trim() && active) onRename(active.id, editingTitle.trim());
    setEditingTitle(null);
  };

  return (
    <div className="luggage-view">
      <section className="suitcase-shelf" aria-label="המזוודות שלי">
        {suitcases.map((suitcase) => (
          <button
            key={suitcase.id}
            type="button"
            className={`suitcase-chip${active?.id === suitcase.id ? " is-active" : ""}`}
            onClick={() => onSelect(suitcase.id)}
            aria-pressed={active?.id === suitcase.id}
          >
            <Suitcase size={16} weight={active?.id === suitcase.id ? "fill" : "regular"} aria-hidden="true" />
            <span>{suitcase.title || "מזוודה"}</span>
            <small>{suitcase.garmentIds?.length || 0}</small>
          </button>
        ))}
        <form className="suitcase-new" onSubmit={create}>
          <input
            type="text"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="מזוודה חדשה לאירוע..."
            aria-label="שם למזוודה חדשה"
          />
          <button type="submit" className="primary-button" disabled={!newTitle.trim()}><Plus size={14} /> יצירה</button>
        </form>
      </section>

      {!active ? (
        <div className="empty-wardrobe-card">
          <h2 className="empty-wardrobe-title">אין עדיין מזוודות</h2>
          <p className="empty-wardrobe-text">צרי מזוודה לכל אירוע או נסיעה, למשל "סופ״ש בצפון" או "חתונה", ואז הוסיפי אליה בגדים מהארון.</p>
        </div>
      ) : (
        <>
          <header className="suitcase-header">
            {editingTitle !== null ? (
              <input
                className="account-input suitcase-header__input"
                value={editingTitle}
                onChange={(event) => setEditingTitle(event.target.value)}
                onBlur={saveTitle}
                onKeyDown={(event) => { if (event.key === "Enter") saveTitle(); if (event.key === "Escape") setEditingTitle(null); }}
                aria-label="שם המזוודה"
                autoFocus
              />
            ) : (
              <h2>
                {active.title || "מזוודה"}
                <button type="button" className="import-icon-button" onClick={() => setEditingTitle(active.title || "")} aria-label="שינוי שם המזוודה"><PencilSimple size={16} /></button>
              </h2>
            )}
            <div className="suitcase-header__actions">
              {packedItems.length > 0 && (
                <button type="button" className="primary-button" onClick={() => onGenerateFlatlay(packedItems, active)}>
                  <MagicWand size={15} /> פריסת המזוודה
                </button>
              )}
              <button
                type="button"
                className="delete-button"
                onClick={() => { if (window.confirm(`למחוק את המזוודה "${active.title || "מזוודה"}"? הבגדים עצמם יישארו בארון.`)) onDelete(active.id); }}
              >
                <Trash size={15} /> מחיקת המזוודה
              </button>
            </div>
          </header>

          <section className="suitcase-section" aria-label="בתוך המזוודה">
            <h3>בתוך המזוודה <small>({packedItems.length})</small></h3>
            {packedItems.length ? (
              <div className="luggage-packed-grid">
                {packedItems.map((item) => (
                  <article key={item.id} className="luggage-item-card">
                    <button type="button" className="luggage-item-card__img-wrap" onClick={() => onOpenItem(item.id)} aria-label={`צפייה ב-${item.name}`}>
                      <img src={fittedImage(item.thumbnail || item.image)} onError={(event) => { const plain = item.thumbnail || item.image; if (event.currentTarget.getAttribute("src") !== plain) event.currentTarget.src = plain; }} alt="" />
                    </button>
                    <div className="luggage-item-card__info">
                      <h4 className="luggage-item-card__title">{item.name}</h4>
                      <span className="luggage-item-card__part">{typeLabel(item.part)}</span>
                      <button type="button" className="luggage-unpack-btn" onClick={() => onToggleItem(active.id, item.id)}>
                        <Trash size={13} /> הסרה
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="suitcase-empty">המזוודה ריקה. הוסיפי בגדים מהרשימה למטה, או בחרי כמה בגדים בארון ולחצי "הוספה למזוודה".</p>
            )}
          </section>

          {availableItems.length > 0 && (
            <section className="suitcase-section" aria-label="הוספה מהארון">
              <h3>הוספה מהארון</h3>
              <div className="luggage-packed-grid">
                {availableItems.map((item) => (
                  <article key={item.id} className="luggage-item-card">
                    <button type="button" className="luggage-item-card__img-wrap" onClick={() => onOpenItem(item.id)} aria-label={`צפייה ב-${item.name}`}>
                      <img src={fittedImage(item.thumbnail || item.image)} onError={(event) => { const plain = item.thumbnail || item.image; if (event.currentTarget.getAttribute("src") !== plain) event.currentTarget.src = plain; }} alt="" />
                    </button>
                    <div className="luggage-item-card__info">
                      <h4 className="luggage-item-card__title">{item.name}</h4>
                      <span className="luggage-item-card__part">{typeLabel(item.part)}</span>
                      <button type="button" className="secondary-button" onClick={() => onToggleItem(active.id, item.id)}>
                        <Plus size={13} /> הוספה
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
