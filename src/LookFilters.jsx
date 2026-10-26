import { useMemo, useState } from "react";
import { Funnel, X } from "@phosphor-icons/react";
import { COLOR_FAMILIES, itemColorFamilies } from "./colors.js";
import { fittedImage, imageFallback, thumbUrl } from "./image-files.js";

export const EMPTY_LOOK_FILTERS = { colors: [], events: [], items: [], tags: [] };

// Styles of looks made automatically, shown in Hebrew
const EVENT_LABELS = {
  casual: "יומיומי",
  everyday: "יומיומי",
  "smart-casual": "סמארט קז'ואל",
  weekend: "סוף שבוע",
  "night-out": "ערב",
};
export const eventLabel = (value) => EVENT_LABELS[value] || value;
// "casual" is only the default given to looks without an event, so it is not an event
export const lookEvents = (look) => [...new Set((look.occasion || []).filter((value) => value !== "casual").map(eventLabel).filter(Boolean))];
export const lookTags = (look) => [...new Set((look.tags || []).map((tag) => tag.toLowerCase()))];

// A look's colours are the colours of the pieces in it
export function lookColorFamilies(look, itemsById) {
  return [...new Set((look.garmentIds || []).flatMap((id) => (itemsById.get(id) ? itemColorFamilies(itemsById.get(id)) : [])))];
}

// Within a group any choice matches; groups combine (black AND evening)
export function matchesLookFilters(look, filters, itemsById) {
  return (!filters.colors.length || lookColorFamilies(look, itemsById).some((family) => filters.colors.includes(family)))
    && (!filters.events.length || lookEvents(look).some((event) => filters.events.includes(event)))
    && (!filters.items.length || filters.items.every((id) => (look.garmentIds || []).includes(id)))
    && (!filters.tags.length || lookTags(look).some((tag) => filters.tags.includes(tag)));
}

const countBy = (values) => values.reduce((counts, value) => counts.set(value, (counts.get(value) || 0) + 1), new Map());

// Filter looks by colour, event, a specific piece and tag, built from the looks there are
export function LookFilters({ looks, items, filters, onChange }) {
  const [open, setOpen] = useState(false);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const options = useMemo(() => {
    const colors = countBy(looks.flatMap((look) => lookColorFamilies(look, itemsById)));
    const events = countBy(looks.flatMap(lookEvents));
    const pieces = countBy(looks.flatMap((look) => [...new Set(look.garmentIds || [])]).filter((id) => itemsById.has(id)));
    const tags = countBy(looks.flatMap(lookTags));
    return {
      colors: COLOR_FAMILIES.filter((family) => colors.has(family.id)).map((family) => ({ ...family, count: colors.get(family.id) })),
      events: [...events].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "he")),
      items: [...pieces].map(([id, count]) => ({ item: itemsById.get(id), count })).sort((a, b) => b.count - a.count || a.item.name.localeCompare(b.item.name, "he")),
      tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "he")),
    };
  }, [looks, itemsById]);
  const activeCount = filters.colors.length + filters.events.length + filters.items.length + filters.tags.length;
  const toggle = (group, value) => onChange((current) => ({
    ...current,
    [group]: current[group].includes(value) ? current[group].filter((x) => x !== value) : [...current[group], value],
  }));

  if (!looks.length) return null;

  const chip = (group, value, label, extra = null) => (
    <button key={`${group}-${value}`} type="button" className="filter-chip is-on" onClick={() => toggle(group, value)}>{extra}{label}<X size={11} aria-label="הסרה" /></button>
  );

  return (
    <section className="wardrobe-filters look-filters" aria-label="סינון הלוקים">
      <div className="wardrobe-filters__bar">
        <button type="button" className={`wardrobe-filters__toggle${activeCount ? " is-active" : ""}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <Funnel size={15} aria-hidden="true" />
          <span>{activeCount ? `סינון (${activeCount})` : "סינון"}</span>
        </button>
        {activeCount > 0 && (
          <button type="button" className="wardrobe-filters__clear" onClick={() => onChange(EMPTY_LOOK_FILTERS)}>
            <X size={13} aria-hidden="true" /> ניקוי
          </button>
        )}
        {!open && activeCount > 0 && (
          <div className="wardrobe-filters__summary">
            {filters.colors.map((id) => {
              const family = COLOR_FAMILIES.find((f) => f.id === id);
              return chip("colors", id, family?.label, <span className="filter-chip__dot" style={{ background: family?.swatch }} />);
            })}
            {filters.events.map((event) => chip("events", event, event))}
            {filters.items.map((id) => chip("items", id, itemsById.get(id)?.name || "פריט"))}
            {filters.tags.map((tag) => chip("tags", tag, `#${tag}`))}
          </div>
        )}
      </div>

      {open && (
        <div className="wardrobe-filters__panel">
          {options.colors.length > 0 && (
            <fieldset className="wardrobe-filters__group">
              <legend>צבע</legend>
              <div className="wardrobe-filters__chips">
                {options.colors.map((family) => (
                  <button key={family.id} type="button" className={`filter-chip${filters.colors.includes(family.id) ? " is-on" : ""}`} aria-pressed={filters.colors.includes(family.id)} onClick={() => toggle("colors", family.id)}>
                    <span className="filter-chip__dot" style={{ background: family.swatch }} />
                    {family.label}
                    <small>{family.count}</small>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <fieldset className="wardrobe-filters__group">
            <legend>אירוע</legend>
            {options.events.length ? (
              <div className="wardrobe-filters__chips">
                {options.events.map(([event, count]) => (
                  <button key={event} type="button" className={`filter-chip${filters.events.includes(event) ? " is-on" : ""}`} aria-pressed={filters.events.includes(event)} onClick={() => toggle("events", event)}>
                    {event}
                    <small>{count}</small>
                  </button>
                ))}
              </div>
            ) : <p className="look-filters__empty">עוד לא הוגדר אירוע לאף לוק. אפשר להוסיף אירוע בעריכת הלוק.</p>}
          </fieldset>
          {options.items.length > 0 && (
            <fieldset className="wardrobe-filters__group">
              <legend>פריט מהארון</legend>
              <div className="look-filters__items">
                {options.items.map(({ item, count }) => {
                  const on = filters.items.includes(item.id);
                  return (
                    <button key={item.id} type="button" className={`look-filters__item${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => toggle("items", item.id)}>
                      <span className="look-filters__thumb">
                        <img src={thumbUrl(fittedImage(item.thumbnail || item.image), 160)} onError={imageFallback(item.thumbnail || item.image)} alt="" loading="lazy" decoding="async" />
                      </span>
                      <span className="look-filters__name">{item.name}</span>
                      <small>{count} {count === 1 ? "לוק" : "לוקים"}</small>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          <fieldset className="wardrobe-filters__group">
            <legend>תגיות</legend>
            {options.tags.length ? (
              <div className="wardrobe-filters__chips">
                {options.tags.map(([tag, count]) => (
                  <button key={tag} type="button" className={`filter-chip${filters.tags.includes(tag) ? " is-on" : ""}`} aria-pressed={filters.tags.includes(tag)} onClick={() => toggle("tags", tag)}>
                    #{tag}
                    <small>{count}</small>
                  </button>
                ))}
              </div>
            ) : <p className="look-filters__empty">עוד אין תגיות ללוקים. אפשר להוסיף תגיות בעריכת הלוק.</p>}
          </fieldset>
          <button type="button" className="secondary-button wardrobe-filters__done" onClick={() => setOpen(false)}>סיום</button>
        </div>
      )}
    </section>
  );
}
