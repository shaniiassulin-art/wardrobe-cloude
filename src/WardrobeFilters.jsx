import { useMemo, useState } from "react";
import { Funnel, X } from "@phosphor-icons/react";
import { COLOR_FAMILIES, itemColorFamilies } from "./colors.js";

export const EMPTY_FILTERS = { colors: [], tags: [], brands: [] };

// Within a group any choice matches (green OR blue); groups combine (green AND "summer")
export function matchesFilters(item, filters) {
  const tags = (item.tags || []).map((tag) => tag.toLowerCase());
  return (!filters.colors.length || itemColorFamilies(item).some((family) => filters.colors.includes(family)))
    && (!filters.tags.length || filters.tags.some((tag) => tags.includes(tag)))
    && (!filters.brands.length || filters.brands.includes((item.brand || "").trim()));
}

const countBy = (values) => values.reduce((counts, value) => counts.set(value, (counts.get(value) || 0) + 1), new Map());

// Filter by colour family, tag and brand, built from what is actually in the wardrobe
export function WardrobeFilters({ items, filters, onChange }) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => {
    const colors = countBy(items.flatMap(itemColorFamilies));
    const tags = countBy(items.flatMap((item) => [...new Set((item.tags || []).map((tag) => tag.toLowerCase()))]));
    const brands = countBy(items.map((item) => (item.brand || "").trim()).filter(Boolean));
    return {
      colors: COLOR_FAMILIES.filter((family) => colors.has(family.id)).map((family) => ({ ...family, count: colors.get(family.id) })),
      tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "he")),
      brands: [...brands].sort((a, b) => a[0].localeCompare(b[0], "he")),
    };
  }, [items]);
  const activeCount = filters.colors.length + filters.tags.length + filters.brands.length;
  // Functional update so quick successive clicks never undo each other
  const toggle = (group, value) => onChange((current) => ({
    ...current,
    [group]: current[group].includes(value) ? current[group].filter((x) => x !== value) : [...current[group], value],
  }));

  if (!options.colors.length && !options.tags.length && !options.brands.length) return null;

  return (
    <section className="wardrobe-filters" aria-label="סינון הארון">
      <div className="wardrobe-filters__bar">
        <button type="button" className={`wardrobe-filters__toggle${activeCount ? " is-active" : ""}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <Funnel size={15} aria-hidden="true" />
          <span>{activeCount ? `סינון (${activeCount})` : "סינון"}</span>
        </button>
        {activeCount > 0 && (
          <button type="button" className="wardrobe-filters__clear" onClick={() => onChange(EMPTY_FILTERS)}>
            <X size={13} aria-hidden="true" /> ניקוי
          </button>
        )}
        {!open && activeCount > 0 && (
          <div className="wardrobe-filters__summary">
            {filters.colors.map((id) => {
              const family = COLOR_FAMILIES.find((f) => f.id === id);
              return <button key={id} type="button" className="filter-chip is-on" onClick={() => toggle("colors", id)}><span className="filter-chip__dot" style={{ background: family?.swatch }} />{family?.label}<X size={11} aria-label="הסרה" /></button>;
            })}
            {filters.tags.map((tag) => <button key={tag} type="button" className="filter-chip is-on" onClick={() => toggle("tags", tag)}>#{tag}<X size={11} aria-label="הסרה" /></button>)}
            {filters.brands.map((brand) => <button key={brand} type="button" className="filter-chip is-on" onClick={() => toggle("brands", brand)}>{brand}<X size={11} aria-label="הסרה" /></button>)}
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
          {options.tags.length > 0 && (
            <fieldset className="wardrobe-filters__group">
              <legend>תגיות</legend>
              <div className="wardrobe-filters__chips">
                {options.tags.map(([tag, count]) => (
                  <button key={tag} type="button" className={`filter-chip${filters.tags.includes(tag) ? " is-on" : ""}`} aria-pressed={filters.tags.includes(tag)} onClick={() => toggle("tags", tag)}>
                    #{tag}
                    <small>{count}</small>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {options.brands.length > 0 && (
            <fieldset className="wardrobe-filters__group">
              <legend>מותג</legend>
              <div className="wardrobe-filters__chips">
                {options.brands.map(([brand, count]) => (
                  <button key={brand} type="button" className={`filter-chip${filters.brands.includes(brand) ? " is-on" : ""}`} aria-pressed={filters.brands.includes(brand)} onClick={() => toggle("brands", brand)}>
                    {brand}
                    <small>{count}</small>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <button type="button" className="secondary-button wardrobe-filters__done" onClick={() => setOpen(false)}>סיום</button>
        </div>
      )}
    </section>
  );
}
