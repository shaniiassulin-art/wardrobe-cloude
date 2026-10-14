// How long a garment is on the body. Chosen per item (when adding it and in the
// item window) and used by the free flat lay to size and stack the pieces.
// The ids must match GARMENT_FIT in server/wardrobe-api.mjs.
const TOP = [
  { id: "crop", label: "קרופ" },
  { id: "waist", label: "עד קו המכנס" },
  { id: "hip", label: "עד הירכיים" },
  { id: "bottom", label: "עד הישבן" },
  { id: "long", label: "ארוכה" },
];
const JACKET = [
  { id: "crop", label: "קצר" },
  { id: "waist", label: "עד קו המכנס" },
  { id: "hip", label: "עד הירכיים" },
  { id: "bottom", label: "עד הישבן" },
  { id: "knee", label: "עד הברך" },
  { id: "long", label: "ארוך" },
];
const BOTTOM = [
  { id: "shorts", label: "קצר" },
  { id: "knee", label: "עד הברך" },
  { id: "midi", label: "מידי" },
  { id: "ankle", label: "מגיע עד הנעל" },
  { id: "onShoe", label: "נופל על הנעל" },
];
const DRESS = [
  { id: "mini", label: "מיני" },
  { id: "knee", label: "עד הברך" },
  { id: "midi", label: "מידי" },
  { id: "maxi", label: "מקסי" },
];

export function lengthOptions(part) {
  if (part === "upperbody" || part === "top") return { title: "אורך החולצה", options: TOP };
  if (part === "wholebody_up" || part === "outerwear" || part === "jacket") return { title: "אורך הז'קט", options: JACKET };
  if (part === "lowerbody" || part === "bottom") return { title: "אורך המכנס / החצאית", options: BOTTOM };
  if (part === "dress" || part === "wholebody") return { title: "אורך השמלה", options: DRESS };
  return null;
}

// Keeps a length only if it is one of the choices for this kind of garment
export function fitForPart(fit, part) {
  const choices = lengthOptions(part);
  return choices && choices.options.some((option) => option.id === fit?.length) ? { length: fit.length } : {};
}
