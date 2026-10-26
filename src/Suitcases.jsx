import { useEffect, useMemo, useState } from "react";
import { Check, MagicWand, PencilSimple, Plus, Suitcase, Trash, X } from "@phosphor-icons/react";
import { fittedImage, imageFallback, thumbUrl } from "./image-files.js";

export const newSuitcaseId = () => `suitcase-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Chooses which suitcase(s) to pack the given items into, or creates a new one
// What a suitcase holds, in words: "3 פריטים · 2 לוקים"
export const suitcaseSummary = (suitcase) => {
  const items = suitcase.garmentIds?.length || 0;
  const looks = suitcase.outfitIds?.length || 0;
  return [`${items} פריטים`, looks ? `${looks} ${looks === 1 ? "לוק" : "לוקים"}` : null].filter(Boolean).join(" · ");
};

// field is "garmentIds" when packing wardrobe items, "outfitIds" when packing looks
export function SuitcasePicker({ suitcases, itemIds, field = "garmentIds", onAdd, onRemove, onCreate, onClose }) {
  const [newTitle, setNewTitle] = useState("");
  const single = itemIds.length === 1;
  const isLook = field === "outfitIds";

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
            <p>{isLook ? "בחרי לאיזו מזוודה להוסיף את הלוק." : single ? "בחרי לאיזו מזוודה להוסיף את הפריט." : `בחרי לאיזו מזוודה להוסיף ${itemIds.length} פריטים.`}</p>
          </div>
          <button className="import-icon-button" type="button" onClick={onClose} aria-label="סגירה"><X size={20} /></button>
        </header>

        {suitcases.length > 0 && (
          <ul className="suitcase-picker__list">
            {suitcases.map((suitcase) => {
              const containsAll = itemIds.every((id) => suitcase[field]?.includes(id));
              return (
                <li key={suitcase.id}>
                  <Suitcase size={18} aria-hidden="true" />
                  <span className="suitcase-picker__name">
                    {suitcase.title || "מזוודה"}
                    <small>{suitcaseSummary(suitcase)}</small>
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
export function LuggageView({ items, outfits = [], onOpenLook, suitcases, activeId, onSelect, onCreate, onRename, onDelete, onToggleItem, onGenerateFlatlay, onOpenItem, typeLabel, selecting = false, checkedIds = [], onToggleCheck }) {
  const [newTitle, setNewTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(null);
  const active = suitcases.find((suitcase) => suitcase.id === activeId) || suitcases[0] || null;
  const packedItems = useMemo(() => (active ? items.filter((item) => active.garmentIds?.includes(item.id)) : []), [items, active]);
  const availableItems = useMemo(() => (active ? items.filter((item) => !active.garmentIds?.includes(item.id)) : []), [items, active]);
  const packedLooks = useMemo(() => (active ? outfits.filter((look) => active.outfitIds?.includes(look.id)) : []), [outfits, active]);
  const availableLooks = useMemo(() => (active ? outfits.filter((look) => !active.outfitIds?.includes(look.id)) : []), [outfits, active]);
  // The flat lay shows everything packed: loose items plus the items of each packed look
  const allPackedItems = useMemo(() => {
    const ids = new Set([...packedItems.map((item) => item.id), ...packedLooks.flatMap((look) => look.garmentIds || (look.garments || []).map((g) => g.id))]);
    return items.filter((item) => ids.has(item.id));
  }, [items, packedItems, packedLooks]);
  const [addTab, setAddTab] = useState("items");

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
            className={`suitcase-chip${!selecting && active?.id === suitcase.id ? " is-active" : ""}${selecting && checkedIds.includes(suitcase.id) ? " is-checked" : ""}`}
            onClick={() => (selecting ? onToggleCheck?.(suitcase.id) : onSelect(suitcase.id))}
            aria-pressed={selecting ? checkedIds.includes(suitcase.id) : active?.id === suitcase.id}
          >
            {selecting
              ? <span className="suitcase-chip__check" aria-hidden="true">{checkedIds.includes(suitcase.id) && <Check size={12} weight="bold" />}</span>
              : <Suitcase size={16} weight={active?.id === suitcase.id ? "fill" : "regular"} aria-hidden="true" />}
            <span>{suitcase.title || "מזוודה"}</span>
            <small>{(suitcase.garmentIds?.length || 0) + (suitcase.outfitIds?.length || 0)}</small>
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
              {allPackedItems.length > 0 && (
                <button type="button" className="primary-button" onClick={() => onGenerateFlatlay(allPackedItems, active)}>
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
            <h3>בתוך המזוודה <small>({packedItems.length + packedLooks.length})</small></h3>
            {packedItems.length || packedLooks.length ? (
              <div className="luggage-packed-grid">
                {packedLooks.map((look) => (
                  <article key={look.id} className="luggage-item-card luggage-look-card">
                    <button type="button" className="luggage-item-card__img-wrap" onClick={() => onOpenLook?.(look)} aria-label={`צפייה בלוק ${look.name}`}>
                      <img src={thumbUrl(look.image, 480)} onError={imageFallback(look.image)} alt="" loading="lazy" decoding="async" />
                    </button>
                    <div className="luggage-item-card__info">
                      <h4 className="luggage-item-card__title">{look.name}</h4>
                      <span className="luggage-item-card__part">לוק · {(look.garmentIds || look.garments || []).length} פריטים</span>
                      <button type="button" className="luggage-unpack-btn" onClick={() => onToggleItem(active.id, look.id, "outfitIds")}>
                        <Trash size={13} /> הסרה
                      </button>
                    </div>
                  </article>
                ))}
                {packedItems.map((item) => (
                  <article key={item.id} className="luggage-item-card">
                    <button type="button" className="luggage-item-card__img-wrap" onClick={() => onOpenItem(item.id)} aria-label={`צפייה ב-${item.name}`}>
                      <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 320)} loading="lazy" decoding="async" onError={imageFallback(item.thumbnail || item.image)} alt="" />
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
              <p className="suitcase-empty">המזוודה ריקה. הוסיפי בגדים או לוקים מהרשימה למטה.</p>
            )}
          </section>

          {(availableItems.length > 0 || availableLooks.length > 0) && (
            <section className="suitcase-section" aria-label="הוספה למזוודה">
              <div className="suitcase-add-head">
                <h3>הוספה למזוודה</h3>
                <div className="suitcase-add-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={addTab === "items"} className={addTab === "items" ? "is-on" : ""} onClick={() => setAddTab("items")}>פריטים <small>{availableItems.length}</small></button>
                  <button type="button" role="tab" aria-selected={addTab === "looks"} className={addTab === "looks" ? "is-on" : ""} onClick={() => setAddTab("looks")}>לוקים <small>{availableLooks.length}</small></button>
                </div>
              </div>
              {addTab === "looks" && !availableLooks.length && (
                <p className="suitcase-empty">{outfits.length ? "כל הלוקים כבר במזוודה." : "עדיין אין לוקים שמורים. אפשר ליצור לוק בלשונית \"לוקים\"."}</p>
              )}
              {addTab === "items" && !availableItems.length && <p className="suitcase-empty">כל הפריטים כבר במזוודה.</p>}
              <div className="luggage-packed-grid">
                {(addTab === "looks" ? availableLooks : []).map((look) => (
                  <article key={look.id} className="luggage-item-card luggage-look-card">
                    <button type="button" className="luggage-item-card__img-wrap" onClick={() => onOpenLook?.(look)} aria-label={`צפייה בלוק ${look.name}`}>
                      <img src={thumbUrl(look.image, 480)} onError={imageFallback(look.image)} alt="" loading="lazy" decoding="async" />
                    </button>
                    <div className="luggage-item-card__info">
                      <h4 className="luggage-item-card__title">{look.name}</h4>
                      <span className="luggage-item-card__part">לוק · {(look.garmentIds || look.garments || []).length} פריטים</span>
                      <button type="button" className="secondary-button" onClick={() => onToggleItem(active.id, look.id, "outfitIds")}>
                        <Plus size={13} /> הוספה
                      </button>
                    </div>
                  </article>
                ))}
                {(addTab === "items" ? availableItems : []).map((item) => (
                  <article key={item.id} className="luggage-item-card">
                    <button type="button" className="luggage-item-card__img-wrap" onClick={() => onOpenItem(item.id)} aria-label={`צפייה ב-${item.name}`}>
                      <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 320)} loading="lazy" decoding="async" onError={imageFallback(item.thumbnail || item.image)} alt="" />
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
