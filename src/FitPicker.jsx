import { isTopPart, lengthOptions } from "./fit-options.js";

// Multiple-choice length for a garment. Tapping the chosen answer again clears it.
export function FitPicker({ part, fit, onChange, compact = false }) {
  const choices = lengthOptions(part);
  if (!choices) return null;
  // With no length chosen: a top is laid to the trouser line, a jacket to the bottom
  const isJacket = part === "wholebody_up" || part === "outerwear" || part === "jacket";
  const current = fit?.length || (isTopPart(part) ? "waist" : isJacket ? "bottom" : null);
  // Everything already chosen except the setting being changed
  const keep = (changing) => Object.fromEntries(Object.entries(fit || {}).filter(([key, value]) => key !== changing && value !== undefined && value !== false));
  return (
    <div className={`fit-picker${compact ? " is-compact" : ""}`}>
      <span className="fit-picker__title">{choices.title} <small>משפיע על הפריסה</small></span>
      <div className="fit-picker__options" role="radiogroup" aria-label={choices.title}>
        {choices.options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={current === option.id}
            className={current === option.id ? "is-on" : ""}
            onClick={() => onChange({ ...keep("length"), ...(current === option.id ? {} : { length: option.id }) })}
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="fit-picker__title">גזרה</span>
      <div className="fit-picker__options" role="radiogroup" aria-label="גזרה">
        {[{ id: false, label: "רגילה" }, { id: true, label: "אוברסייז" }].map((option) => (
          <button
            key={String(option.id)}
            type="button"
            role="radio"
            aria-checked={Boolean(fit?.oversize) === option.id}
            className={Boolean(fit?.oversize) === option.id ? "is-on" : ""}
            onClick={() => onChange({ ...keep("oversize"), ...(option.id ? { oversize: true } : {}) })}
          >
            {option.label}
          </button>
        ))}
      </div>
      {isTopPart(part) && (
        <>
          <span className="fit-picker__title">סוג חולצה <small>מכופתרת אפשר לפרוס פתוחה</small></span>
          <div className="fit-picker__options" role="radiogroup" aria-label="סוג חולצה">
            {[{ id: false, label: "רגילה" }, { id: true, label: "מכופתרת" }].map((option) => (
              <button
                key={String(option.id)}
                type="button"
                role="radio"
                aria-checked={Boolean(fit?.buttoned) === option.id}
                className={Boolean(fit?.buttoned) === option.id ? "is-on" : ""}
                onClick={() => onChange({ ...keep("buttoned"), ...(option.id ? { buttoned: true } : {}) })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
