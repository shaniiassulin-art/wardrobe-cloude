import { lengthOptions } from "./fit-options.js";

// Multiple-choice length for a garment. Tapping the chosen answer again clears it.
export function FitPicker({ part, fit, onChange, compact = false }) {
  const choices = lengthOptions(part);
  if (!choices) return null;
  const current = fit?.length || null;
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
            onClick={() => onChange(current === option.id ? {} : { length: option.id })}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
