// Rough cost of each AI action, in agorot, shown next to the buttons that trigger it.
// Based on OpenAI's gpt-image-2 prices (checked October 2026) at about 3.6 ₪ per dollar,
// including the photos sent to the model. The real charge can be a little higher or lower.
//
//   Catalog photo of a garment, low quality (1024×1024):     ~$0.006 + input ≈ 3–5 agorot
//   Catalog photo, medium quality (1024×1024):               ~$0.053 + input ≈ 20–25 agorot
//   Garment on me, medium quality (1536×1024):               ~$0.041 + 2 photos in ≈ 20 agorot
//   Look on me, medium quality (1024×1024), you + N pieces:  ~$0.053 + N+1 photos in ≈ 25–40 agorot
//   Text tasks with gpt-4o-mini (complete a look, tags):     well under 1 agora
//   Flat lay looks and suitcase layouts:                     free, made on the server without AI

export const PRICES = {
  catalogLow: "כ-4 אג׳",
  catalogMedium: "כ-22 אג׳",
  modeledItem: "כ-20 אג׳",
  textAI: "פחות מאגורה",
  free: "חינם",
};

// A look on the model sends a photo of you plus one photo per garment
export function lookOnModelPrice(garmentCount = 1) {
  const agorot = Math.round(22 + 3 * Math.max(1, garmentCount));
  return `כ-${agorot} אג׳`;
}

export function autoLooksPrice(count = 1) {
  const each = 30;
  return count > 1 ? `כ-${each * count} אג׳ (כ-${each} ללוק)` : `כ-${each} אג׳`;
}
