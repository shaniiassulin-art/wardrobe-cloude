import { randomUUID } from "node:crypto";
import { COLOR_FAMILIES, colorFamily } from "../src/colors.js";
import path from "node:path";
import sharp from "sharp";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const TASK_ROOT = "/api/import/tasks";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes", "dress", "wholebody"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MODEL_REFERENCE_KEY = "model-reference.png";

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function imageResponse(bytes, { contentType = "image/png", cache = "public, max-age=31536000, immutable", head = false } = {}) {
  const headers = { "Content-Type": contentType, "Cache-Control": cache };
  if (cache.includes("immutable")) {
    // Let Netlify's CDN keep stored photos so repeat loads don't reach the server
    // (each server request counts toward the host's per-minute limit). The cache is
    // kept per login cookie, so photos still need the site password.
    headers["Netlify-CDN-Cache-Control"] = "public, max-age=31536000, immutable";
    headers["Netlify-Vary"] = "cookie=wardrobe_session";
  }
  return new Response(head ? null : bytes, { status: 200, headers });
}

async function body(request, limit = 50 * 1024 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

function notFound(message = "Not found") {
  return Object.assign(new Error(message), { status: 404 });
}

function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  return copy;
}

function extension(mime = "image/png") {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/heic": "png", "image/heif": "png" })[mime] || "png";
}

function decodeImage(input) {
  const raw = input?.imageDataUrl || input?.imageBase64 || input?.image || input?.data;
  if (!raw || typeof raw !== "string") throw Object.assign(new Error("imageDataUrl or imageBase64 is required"), { status: 400 });
  let base64Data = raw;
  let mime = input?.mimeType || "image/png";
  if (raw.includes("base64,")) {
    const parts = raw.split("base64,");
    base64Data = parts[1];
    const mimeMatch = parts[0].match(/data:([^;]+)/);
    if (mimeMatch) mime = mimeMatch[1];
  } else {
    const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) {
      mime = match[1];
      base64Data = match[2];
    }
  }
  base64Data = base64Data.trim().replace(/\s+/g, "");
  const data = Buffer.from(base64Data, "base64");
  if (!data.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return { data, mime };
}

// Common English tags the import used to produce, with their Hebrew wording
const TAG_TRANSLATIONS = {
  casual: "יומיומי", everyday: "יומיומי", formal: "אלגנטי", elegant: "אלגנטי", evening: "ערב", party: "מסיבה",
  summer: "קיץ", winter: "חורף", spring: "אביב", fall: "סתיו", autumn: "סתיו", beach: "חוף", sport: "ספורט", sporty: "ספורטיבי",
  cotton: "כותנה", denim: "ג׳ינס", linen: "פשתן", wool: "צמר", knit: "סריג", knitted: "סריג", leather: "עור", silk: "משי",
  satin: "סאטן", lace: "תחרה", velvet: "קטיפה", polyester: "פוליאסטר", suede: "זמש", chiffon: "שיפון",
  striped: "פסים", stripes: "פסים", floral: "פרחוני", plaid: "משבצות", checked: "משבצות", "polka dot": "נקודות", printed: "מודפס", solid: "חלק", plain: "חלק",
  "long sleeve": "שרוול ארוך", "long sleeves": "שרוול ארוך", "short sleeve": "שרוול קצר", "short sleeves": "שרוול קצר", sleeveless: "ללא שרוולים",
  oversized: "אוברסייז", fitted: "צמוד", slim: "צמוד", loose: "רפוי", cropped: "קרופ", "high waist": "גזרה גבוהה", "high-waisted": "גזרה גבוהה",
  maxi: "מקסי", midi: "מידי", mini: "מיני", "v-neck": "צווארון וי", "crew neck": "צווארון עגול", hooded: "קפוצ׳ון", hoodie: "קפוצ׳ון",
  buttons: "כפתורים", button: "כפתורים", zipper: "רוכסן", zip: "רוכסן", pockets: "כיסים", pocket: "כיסים", belt: "חגורה", pleated: "פליסה",
  basic: "בייסיק", classic: "קלאסי", vintage: "וינטג׳", minimalist: "מינימליסטי", comfortable: "נוח", warm: "חם", light: "קליל", lightweight: "קליל",
  work: "עבודה", office: "משרד", "smart-casual": "סמארט קז׳ואל", "smart casual": "סמארט קז׳ואל", weekend: "סוף שבוע", "night-out": "יציאה",
};
const hasLatin = (text) => /[a-z]/i.test(text || "");

function normalizeMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part: PARTS.has(metadata.part) ? metadata.part : "upperbody",
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
    fit: normalizeFit(metadata.fit),
  };
}

function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

async function normalizeImage(bytes) {
  try {
    return await sharp(bytes, { failOnError: false })
      .rotate()
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .toColorspace("srgb")
      .png()
      .toBuffer();
  } catch {
    return await sharp(bytes, { failOnError: false })
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  }
}

async function cropDetectedItem(bytes, boundingBox) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

function chooseChromaKey(primary = "#808080") {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const selected = candidates.sort((a, b) => {
    const distance = (color) => color.reduce((total, channel, index) => total + ((channel - source[index]) ** 2), 0);
    return distance(b) - distance(a);
  })[0];
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function buildGarmentPrompt(metadata = {}, chromaKey = "#00ff00") {
  const name = metadata.name || "clothing item";
  const category = metadata.part || "wardrobe item";
  const primary = metadata.color || "the exact visible color";
  const secondary = metadata.secondaryColor ? ` with distinct secondary color ${metadata.secondaryColor}` : "";
  const details = Array.isArray(metadata.tags) && metadata.tags.length
    ? metadata.tags.join(", ")
    : "all visible construction and design details";
  const isShoes = category === "shoes" || /shoe|sneaker|boot|sandal|heel|loafer|נעל|סניקרס|מגף|מגפ|סנדל|כפכף/i.test(name);
  // Shoes are always shown the same way: the pair side by side, toes towards the viewer
  const shoeLayout = isShoes
    ? `\n\nShoe presentation (mandatory): Show the complete PAIR, left and right shoe, standing upright side by side on their soles with a small even gap between them, both toes pointing straight toward the camera, seen from the front at a slightly elevated eye level (about 20 degrees above) so the toe box, vamp, laces or straps and the opening are all visible. Both shoes are identical mirror images at the same size and height. If the reference shows only one shoe or shows them from the side, reconstruct the matching second shoe and turn both to this front view.`
    : "";

  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. It may also show other garments, people, or objects; find the ${name} (${category}, ${primary}) and use only that garment to identify and reconstruct it.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.${shoeLayout}

Critical: Use no ${chromaKey} anywhere in the garment. ${isShoes ? "Produce exactly one complete pair of shoes, side by side and facing the camera, with a crisp, separable outer silhouette." : "Produce exactly one complete garment with a crisp, separable outer silhouette."}`;
}

function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function removeKeyedSpill(data, index, keyedChannels, neutralLevel) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel], 0) - (neutralLevel * keyedChannels.length));
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
}

// Pixels within `radius` of a fully transparent pixel. Chroma spill only happens
// at the garment edge, so despill is limited to this band; the garment interior
// keeps its true colour (despilling it turned navy and blue garments grey-teal).
function edgeBand(data, width, height, radius = 4) {
  const clear = new Uint8Array(width * height);
  for (let pixel = 0; pixel < clear.length; pixel += 1) clear[pixel] = data[pixel * 4 + 3] === 0 ? 1 : 0;
  const rows = new Uint8Array(clear.length);
  for (let y = 0; y < height; y += 1) {
    let last = -Infinity;
    for (let x = 0; x < width; x += 1) { if (clear[y * width + x]) last = x; if (x - last <= radius) rows[y * width + x] = 1; }
    last = Infinity;
    for (let x = width - 1; x >= 0; x -= 1) { if (clear[y * width + x]) last = x; if (last - x <= radius) rows[y * width + x] = 1; }
  }
  const band = new Uint8Array(clear.length);
  for (let x = 0; x < width; x += 1) {
    let last = -Infinity;
    for (let y = 0; y < height; y += 1) { if (rows[y * width + x]) last = y; if (y - last <= radius) band[y * width + x] = 1; }
    last = Infinity;
    for (let y = height - 1; y >= 0; y -= 1) { if (rows[y * width + x]) last = y; if (last - y <= radius) band[y * width + x] = 1; }
  }
  return band;
}

function despillEdges(data, width, height, keyedChannels, neutralChannels, { fadeAlpha = false } = {}) {
  const band = edgeBand(data, width, height);
  for (let pixel = 0, index = 0; index < data.length; pixel += 1, index += 4) {
    if (data[index + 3] === 0 || !band[pixel]) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    if (spill <= 0) continue;
    if (fadeAlpha) data[index + 3] = Math.round(data[index + 3] * Math.max(0, 1 - (Math.max(0, spill - 4) / 150)));
    removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    if (data[index + 3] <= 8) data.fill(0, index, index + 4);
  }
}

export async function processChromaBackground(bytes, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const feather = 80;
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data.fill(0, index, index + 4);
    } else if (distance < tolerance + feather) {
      data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      if (data[index + 3] <= 8) data.fill(0, index, index + 4);
    }
  }
  despillEdges(data, info.width, info.height, keyedChannels, neutralChannels, { fadeAlpha: true });
  despillEdges(data, info.width, info.height, keyedChannels, neutralChannels);
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  despillEdges(framedData, framedInfo.width, framedInfo.height, keyedChannels, neutralChannels);
  const output = await sharp(framedData, { raw: framedInfo }).png().toBuffer();
  const verification = await verifyNoChromaSpill(output, key);
  return { bytes: output, verification, tolerance };
}

export async function removeChromaBackground(bytes, key, options = {}) {
  const result = await processChromaBackground(bytes, key, options);
  if (options.strict !== false && result.verification.contaminatedPixels > 1200) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

export async function frameTransparentGarment(bytes, canvasSize = 1024, occupancy = 0.88) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

async function verifyNoChromaSpill(bytes, key) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Only the edge band can carry spill; interior colours are the garment itself
  const band = edgeBand(data, info.width, info.height);
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0 || !band[index / 4]) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

async function buildModeledComposite(modelData, garmentItems) {
  const canvasWidth = 1024;
  const canvasHeight = 1024;
  const halfWidth = 512;

  const modelResized = await sharp(modelData)
    .resize(halfWidth, canvasHeight, { fit: "contain", background: { r: 245, g: 245, b: 245, alpha: 1 } })
    .png()
    .toBuffer();

  const composites = [{ input: modelResized, left: 0, top: 0 }];
  const count = Math.max(1, garmentItems.length);
  const garmentHeight = Math.floor(canvasHeight / count);

  for (let i = 0; i < count; i++) {
    const item = garmentItems[i];
    if (!item?.data) continue;
    const itemResized = await sharp(item.data)
      .resize(halfWidth, garmentHeight, { fit: "contain", background: { r: 245, g: 245, b: 245, alpha: 1 } })
      .png()
      .toBuffer();
    composites.push({
      input: itemResized,
      left: halfWidth,
      top: i * garmentHeight,
    });
  }

  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 245, g: 245, b: 245, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

export async function fitItemOnModel(modelBuffer, garmentBuffer, item = {}) {
  const trimmed = await sharp(garmentBuffer).trim().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const ratio = (meta.height || 1) / (meta.width || 1);

  let targetWidth, targetHeight, top, left;
  const nameLower = (item.name || "").toLowerCase();
  const part = item.part || "upperbody";

  if (part === "upperbody" || part === "wholebody_up") {
    if (nameLower.includes("jacket") || nameLower.includes("trench") || nameLower.includes("coat")) {
      targetWidth = 430;
      targetHeight = Math.min(520, Math.round(targetWidth * ratio));
      top = 265;
      left = Math.round((1024 - targetWidth) / 2);
    } else {
      targetWidth = 380;
      targetHeight = Math.min(480, Math.round(targetWidth * ratio));
      top = 280;
      left = Math.round((1024 - targetWidth) / 2);
    }
  } else if (part === "lowerbody") {
    if (nameLower.includes("skirt") || nameLower.includes("mini") || nameLower.includes("shorts")) {
      targetWidth = 370;
      targetHeight = Math.min(440, Math.round(targetWidth * ratio));
      top = 535;
      left = Math.round((1024 - targetWidth) / 2);
    } else {
      targetWidth = 400;
      targetHeight = Math.min(880, Math.round(targetWidth * ratio));
      top = 535;
      left = Math.round((1024 - targetWidth) / 2);
    }
  } else if (part === "shoes") {
    targetWidth = 320;
    targetHeight = Math.min(220, Math.round(targetWidth * ratio));
    top = 1330;
    left = Math.round((1024 - targetWidth) / 2);
  } else if (part === "accessories_up" || part === "accessory") {
    if (nameLower.includes("belt") || nameLower.includes("חגורה")) {
      targetWidth = 360;
      targetHeight = Math.min(130, Math.round(targetWidth * ratio));
      top = 530;
      left = Math.round((1024 - targetWidth) / 2);
    } else if (nameLower.includes("neck") || nameLower.includes("chain") || nameLower.includes("שרשרת")) {
      targetWidth = 200;
      targetHeight = Math.min(200, Math.round(targetWidth * ratio));
      top = 270;
      left = Math.round((1024 - targetWidth) / 2);
    } else if (nameLower.includes("ring") || nameLower.includes("טבע")) {
      targetWidth = 160;
      targetHeight = Math.min(160, Math.round(targetWidth * ratio));
      top = 670;
      left = 625;
    } else {
      targetWidth = 240;
      targetHeight = Math.min(260, Math.round(targetWidth * ratio));
      top = 620;
      left = 250;
    }
  } else {
    targetWidth = 380;
    targetHeight = Math.min(500, Math.round(targetWidth * ratio));
    top = 300;
    left = Math.round((1024 - targetWidth) / 2);
  }

  const resized = await sharp(trimmed)
    .resize({ width: targetWidth, height: targetHeight, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const shadow = await sharp(resized)
    .tint({ r: 25, g: 25, b: 30 })
    .blur(5)
    .linear(0.32, 0)
    .png()
    .toBuffer();

  return sharp(modelBuffer)
    .composite([
      { input: shadow, top: top + 4, left: left + 2, blend: "over" },
      { input: resized, top, left, blend: "over" }
    ])
    .png()
    .toBuffer();
}

export async function fitMultipleGarmentsOnModel(modelBuffer, garmentEntries = []) {
  const layerOrder = { lowerbody: 1, upperbody: 2, shoes: 3, accessories_up: 4, wholebody_up: 5 };
  const sorted = [...garmentEntries].sort((a, b) => {
    return (layerOrder[a.item.part] || 2) - (layerOrder[b.item.part] || 2);
  });

  const composites = [];
  for (const { buffer, item } of sorted) {
    const trimmed = await sharp(buffer).trim().toBuffer();
    const meta = await sharp(trimmed).metadata();
    const ratio = (meta.height || 1) / (meta.width || 1);
    let targetWidth, targetHeight, top, left;
    const nameLower = (item.name || "").toLowerCase();
    const part = item.part || "upperbody";

    if (part === "upperbody") {
      targetWidth = 380;
      targetHeight = Math.min(480, Math.round(targetWidth * ratio));
      top = 280;
      left = Math.round((1024 - targetWidth) / 2);
    } else if (part === "wholebody_up") {
      targetWidth = 430;
      targetHeight = Math.min(520, Math.round(targetWidth * ratio));
      top = 265;
      left = Math.round((1024 - targetWidth) / 2);
    } else if (part === "lowerbody") {
      if (nameLower.includes("skirt") || nameLower.includes("mini") || nameLower.includes("shorts")) {
        targetWidth = 370;
        targetHeight = Math.min(440, Math.round(targetWidth * ratio));
        top = 535;
        left = Math.round((1024 - targetWidth) / 2);
      } else {
        targetWidth = 400;
        targetHeight = Math.min(880, Math.round(targetWidth * ratio));
        top = 535;
        left = Math.round((1024 - targetWidth) / 2);
      }
    } else if (part === "shoes") {
      targetWidth = 320;
      targetHeight = Math.min(220, Math.round(targetWidth * ratio));
      top = 1330;
      left = Math.round((1024 - targetWidth) / 2);
    } else if (part === "accessories_up" || part === "accessory") {
      if (nameLower.includes("belt") || nameLower.includes("חגורה")) {
        targetWidth = 360;
        targetHeight = Math.min(130, Math.round(targetWidth * ratio));
        top = 530;
        left = Math.round((1024 - targetWidth) / 2);
      } else if (nameLower.includes("neck") || nameLower.includes("chain") || nameLower.includes("שרשרת")) {
        targetWidth = 200;
        targetHeight = Math.min(200, Math.round(targetWidth * ratio));
        top = 270;
        left = Math.round((1024 - targetWidth) / 2);
      } else if (nameLower.includes("ring") || nameLower.includes("טבע")) {
        targetWidth = 160;
        targetHeight = Math.min(160, Math.round(targetWidth * ratio));
        top = 670;
        left = 625;
      } else {
        targetWidth = 240;
        targetHeight = Math.min(260, Math.round(targetWidth * ratio));
        top = 620;
        left = 250;
      }
    } else {
      targetWidth = 380;
      targetHeight = Math.min(500, Math.round(targetWidth * ratio));
      top = 300;
      left = Math.round((1024 - targetWidth) / 2);
    }

    const resized = await sharp(trimmed)
      .resize({ width: targetWidth, height: targetHeight, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const shadow = await sharp(resized)
      .tint({ r: 25, g: 25, b: 30 })
      .blur(5)
      .linear(0.32, 0)
      .png()
      .toBuffer();

    composites.push({ input: shadow, top: top + 4, left: left + 2, blend: "over" });
    composites.push({ input: resized, top, left, blend: "over" });
  }

  return sharp(modelBuffer)
    .composite(composites)
    .png()
    .toBuffer();
}

// Free styling choices for a flat lay, done by arranging the photos (no AI):
//   jacket: "open"   - the jacket lies open with the top showing between its two fronts.
//                      Uses the jacket's AI "open version" when one was made, otherwise
//                      the photo is cut down the middle and the halves are spread apart.
//           "front"  - the whole jacket lies on top of the top, only the neckline peeks out
//           "behind" - the whole jacket lies underneath and the top sits on it
//   top:    "out"    - the top lies over the waistband of the bottoms
//           "tucked" - the bottoms lie over the hem of the top, like a tucked-in top
export const FLATLAY_STYLING = {
  jacket: ["open", "front", "behind"],
  top: ["out", "tucked"],
  // A button-up shirt worn open (laid like an open jacket) or buttoned
  shirt: ["open", "closed"],
};
const LEGACY_STYLING = { jacket: { closed: "front" } };

export const LAYER_STYLES = ["open", "closed", "front", "behind"];

export function normalizeFlatlayStyling(input = {}) {
  const styling = {};
  for (const [key, allowed] of Object.entries(FLATLAY_STYLING)) {
    const value = LEGACY_STYLING[key]?.[input?.[key]] || input?.[key];
    if (allowed.includes(value)) styling[key] = value;
  }
  // Upper-body layers from the body outwards: [{ id, style }]
  if (Array.isArray(input?.layers)) {
    const layers = input.layers
      .filter((entry) => entry && typeof entry.id === "string" && /^[\w-]{1,80}$/.test(entry.id))
      .slice(0, 8)
      .map((entry) => ({ id: entry.id, style: LAYER_STYLES.includes(entry.style) ? entry.style : "closed" }));
    if (layers.length) styling.layers = layers;
  }
  return styling;
}

// How long each piece is, measured on the body in "torso units":
// shoulders = 0, waist (where trousers start) = 1.
// The flat lay sizes and stacks the pieces by these so lengths look true to life.
export const GARMENT_FIT = {
  // "hip" is halfway between the waist and the knee
  top: { crop: 0.82, waist: 1.0, hip: 1.62, bottom: 1.8, long: 2.05 },
  jacket: { crop: 0.85, waist: 1.0, hip: 1.62, bottom: 1.8, knee: 2.25, long: 2.8 },
  // Where trousers/skirts end. "onShoe" = falls over the shoe
  bottom: { shorts: 1.6, knee: 2.25, midi: 2.65, ankle: 3.0, onShoe: 3.15 },
  dress: { mini: 1.85, knee: 2.3, midi: 2.7, maxi: 3.1 },
};
const ANKLE = 3.0;

export function normalizeFit(fit = {}) {
  const length = typeof fit?.length === "string" ? fit.length : null;
  const known = Object.values(GARMENT_FIT).some((table) => length in table);
  return {
    ...(known ? { length } : {}),
    ...(fit?.oversize === true ? { oversize: true } : {}),
    ...(fit?.buttoned === true ? { buttoned: true } : {}),
  };
}

// Body measurements in cm, from the profile. Used for the proportions of flat
// lays and given to the image model so photos keep the user's shape.
export function normalizeBody(input = {}) {
  const pick = (key, min, max) => {
    const value = Number(input?.[key]);
    return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : null;
  };
  const body = { height: pick("height", 120, 220), bust: pick("bust", 50, 160), waist: pick("waist", 40, 160), hips: pick("hips", 50, 170) };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null));
}
const bodyLine = (body = {}) => {
  const parts = [];
  if (body.height) parts.push(`about ${body.height} cm tall`);
  if (body.bust && body.waist && body.hips) parts.push(`with body measurements ${body.bust}-${body.waist}-${body.hips} cm (bust-waist-hips)`);
  return parts.length ? `\nBody: The person is ${parts.join(" ")}. Keep these real proportions; do not make the body thinner, curvier or taller than this.` : "";
};

// A short Hebrew default name for a look, from the colours of its main pieces,
// e.g. "לוק צהוב ושחור". A number is added when the name is already taken.
const LOOK_PART_ORDER = ["dress", "wholebody", "upperbody", "top", "lowerbody", "bottom", "wholebody_up", "outerwear", "jacket"];
export function defaultLookName(garments = [], takenNames = []) {
  const main = [...garments]
    .filter((g) => LOOK_PART_ORDER.includes(g.part))
    .sort((a, b) => LOOK_PART_ORDER.indexOf(a.part) - LOOK_PART_ORDER.indexOf(b.part));
  const labels = [];
  for (const garment of (main.length ? main : garments)) {
    const family = COLOR_FAMILIES.find((entry) => entry.id === colorFamily(garment.color));
    if (family && !labels.includes(family.label)) labels.push(family.label);
    if (labels.length === 2) break;
  }
  const base = labels.length === 2 ? `לוק ${labels[0]} ו${labels[1]}` : labels.length ? `לוק ${labels[0]}` : "לוק חדש";
  const taken = new Set(takenNames.map((name) => String(name || "").trim()));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  return base;
}

// Cuts a garment photo down the middle into its left and right halves
async function splitDownTheMiddle(buffer) {
  const { width, height } = await sharp(buffer).metadata();
  const half = Math.max(1, Math.floor(width / 2));
  const left = await sharp(buffer).extract({ left: 0, top: 0, width: half, height }).png().toBuffer();
  const right = await sharp(buffer).extract({ left: half, top: 0, width: width - half, height }).png().toBuffer();
  return { left, right, ratio: height / width };
}

export async function generateFlatLayOutfit(garmentEntries = [], styling = {}, body = {}) {
  // Width of the chest and of the waist compared with the hips (photos of trousers
  // are as wide as the hips)
  const bustToHips = body.bust && body.hips ? Math.max(0.88, Math.min(1.15, body.bust / body.hips)) : 1;
  const waistToHips = body.waist && body.hips ? Math.max(0.6, Math.min(0.95, body.waist / body.hips)) : 0.8;
  styling = normalizeFlatlayStyling(styling);
  const { jacket, top: topStyle, shirt: shirtStyle } = styling;
  if (!garmentEntries.length) {
    throw new Error("No garments provided for flat lay");
  }

  // Pre-process items: safely trim and extract metadata
  const processed = [];
  for (const entry of garmentEntries) {
    if (!entry?.buffer) continue;
    let imgBuffer = entry.buffer;
    try {
      const trimmed = await sharp(entry.buffer).trim().toBuffer();
      if (trimmed && trimmed.length > 0) {
        imgBuffer = trimmed;
      }
    } catch (_) {
      imgBuffer = entry.buffer;
    }

    try {
      const meta = await sharp(imgBuffer).metadata();
      const ratio = (meta.height || 1) / (meta.width || 1);
      const nameLower = (entry.item?.name || "").toLowerCase();
      const part = entry.item?.part || "upperbody";
      let openBuffer = null;
      if (entry.openBuffer) {
        openBuffer = await sharp(entry.openBuffer).trim().toBuffer().catch(() => entry.openBuffer);
      }
      const openMeta = openBuffer ? await sharp(openBuffer).metadata().catch(() => null) : null;
      if (entry.item) entry.item = { ...entry.item, fit: normalizeFit(entry.item.fit) };
      processed.push({
        buffer: imgBuffer,
        openBuffer,
        openRatio: openMeta ? (openMeta.height || 1) / (openMeta.width || 1) : null,
        item: entry.item,
        meta,
        ratio,
        nameLower,
        part,
      });
    } catch (_) {}
  }

  if (!processed.length) {
    throw new Error("Could not process garment images");
  }

  const canvasWidth = 1200;
  const centerX = 600;

  // Granular categorization so no item is ever lost or dropped
  const isOuterwear = (e) =>
    e.part === "wholebody_up" ||
    e.part === "outerwear" ||
    e.nameLower.includes("jacket") ||
    e.nameLower.includes("coat") ||
    e.nameLower.includes("trench") ||
    e.nameLower.includes("blazer") ||
    e.nameLower.includes("cardigan") ||
    e.nameLower.includes("ז'קט") ||
    e.nameLower.includes("מעיל");

  const isDress = (e) =>
    e.part === "dress" ||
    e.part === "wholebody" ||
    e.nameLower.includes("dress") ||
    e.nameLower.includes("gown") ||
    e.nameLower.includes("jumpsuit") ||
    e.nameLower.includes("שמלה") ||
    e.nameLower.includes("אוברול");

  const isNecklaceOrHeadwear = (e) =>
    (e.part === "accessories_up" || e.part === "accessory") &&
    (e.nameLower.includes("neck") ||
      e.nameLower.includes("chain") ||
      e.nameLower.includes("שרשרת") ||
      e.nameLower.includes("hat") ||
      e.nameLower.includes("cap") ||
      e.nameLower.includes("כובע") ||
      e.nameLower.includes("glasses") ||
      e.nameLower.includes("משקפ") ||
      e.nameLower.includes("scarf") ||
      e.nameLower.includes("צעיף"));

  const isBelt = (e) =>
    (e.part === "accessories_up" || e.part === "accessory") &&
    (e.nameLower.includes("belt") || e.nameLower.includes("חגורה"));

  const isBag = (e) =>
    e.nameLower.includes("bag") ||
    e.nameLower.includes("תיק") ||
    e.nameLower.includes("tote") ||
    e.nameLower.includes("clutch") ||
    e.nameLower.includes("luggage") ||
    e.nameLower.includes("מזוודה") ||
    e.nameLower.includes("backpack");

  const isSock = (e) =>
    e.nameLower.includes("sock") || e.nameLower.includes("גרב");

  const isShoe = (e) =>
    e.part === "shoes" ||
    e.nameLower.includes("shoe") ||
    e.nameLower.includes("pump") ||
    e.nameLower.includes("boot") ||
    e.nameLower.includes("sneaker") ||
    e.nameLower.includes("sandal") ||
    e.nameLower.includes("נעלי") ||
    e.nameLower.includes("מגפ");

  const isBottom = (e) =>
    e.part === "lowerbody" ||
    e.nameLower.includes("pant") ||
    e.nameLower.includes("trouser") ||
    e.nameLower.includes("jean") ||
    e.nameLower.includes("skirt") ||
    e.nameLower.includes("short") ||
    e.nameLower.includes("מכנסי") ||
    e.nameLower.includes("חצאית");

  const headwear = processed.filter(isNecklaceOrHeadwear);
  const outerwear = processed.filter((e) => isOuterwear(e) && !headwear.includes(e));
  const dresses = processed.filter((e) => isDress(e) && !outerwear.includes(e) && !headwear.includes(e));
  const tops = processed.filter(
    (e) =>
      (e.part === "upperbody" || e.nameLower.includes("top") || e.nameLower.includes("shirt") || e.nameLower.includes("חולצה")) &&
      !outerwear.includes(e) &&
      !dresses.includes(e) &&
      !headwear.includes(e)
  );
  const belts = processed.filter(isBelt);
  const bottoms = processed.filter((e) => isBottom(e) && !outerwear.includes(e) && !dresses.includes(e) && !tops.includes(e));
  const socks = processed.filter(isSock);
  const shoes = processed.filter((e) => isShoe(e) && !socks.includes(e));
  const bags = processed.filter((e) => isBag(e) && !shoes.includes(e) && !socks.includes(e));

  // Anything not categorized yet:
  const assigned = new Set([
    ...headwear,
    ...outerwear,
    ...dresses,
    ...tops,
    ...belts,
    ...bottoms,
    ...shoes,
    ...socks,
    ...bags,
  ]);
  const otherAccessories = processed.filter((e) => !assigned.has(e));

  const composites = [];
  const placedBoxes = [];
  const layersOf = new Map();
  // Move the photos of these pieces to the top of the pile
  const bringToFront = (pieces) => {
    for (const piece of pieces) {
      for (const layer of layersOf.get(piece) || []) {
        const index = composites.indexOf(layer);
        if (index >= 0) composites.splice(index, 1);
        composites.push(layer);
      }
    }
  };

  // Helper to place item with realistic drop shadow
  async function placeItem(item, { targetW, targetH, left, top, blur = 6, opacity = 0.22, buffer, fit = "contain" }) {
    const w = Math.max(40, Math.round(targetW));
    const h = Math.max(40, Math.round(targetH));
    const l = Math.round(left);
    const t = Math.round(top);

    const resized = await sharp(buffer || item.buffer)
      .resize({
        width: w,
        height: h,
        fit,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    // Soft shadow: the piece's silhouette, padded so the blur is never cut off at
    // the edge of the picture (a cut-off blur shows up as a hard dark line)
    const pad = Math.ceil(blur * 3);
    const { data: shadowData, info: shadowInfo } = await sharp(resized)
      .ensureAlpha()
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let index = 0; index < shadowData.length; index += 4) {
      shadowData[index] = 35;
      shadowData[index + 1] = 30;
      shadowData[index + 2] = 25;
      shadowData[index + 3] = Math.round(shadowData[index + 3] * opacity);
    }
    const shadow = await sharp(shadowData, { raw: shadowInfo }).blur(blur).png().toBuffer();

    const layers = [{ input: shadow, top: t + 4 - pad, left: l + 2 - pad }, { input: resized, top: t, left: l }];
    composites.push(...layers);
    layersOf.set(item, [...(layersOf.get(item) || []), ...layers]);

    placedBoxes.push({ left: l, top: t, width: w, height: h });
  }

  let currentY = 70;

  // 1. Headwear & Necklaces at top
  if (headwear.length > 0) {
    const count = headwear.length;
    const itemW = count === 1 ? 210 : Math.min(180, Math.round(440 / count));
    const totalW = count * itemW + (count - 1) * 20;
    let startX = Math.round(centerX - totalW / 2);
    let maxRowH = 0;

    for (const hw of headwear) {
      const itemH = Math.min(180, Math.round(itemW * hw.ratio));
      await placeItem(hw, { targetW: itemW, targetH: itemH, left: startX, top: currentY, blur: 4, opacity: 0.18 });
      startX += itemW + 20;
      if (itemH > maxRowH) maxRowH = itemH;
    }
    currentY += maxRowH + 15;
  }

  // One piece of each kind (the usual outfit): lay it out like a body, using each
  // piece's length so a long top covers the waistband, trousers fall on the shoe, etc.
  // Upper-body layers (dress, tops, button-up shirts, jackets), from the one
  // closest to the body outwards. The order and how each outer layer is laid can
  // be chosen in the look builder (styling.layers); otherwise a natural default.
  const isButtoned = (e) => e.item?.fit?.buttoned === true;
  const layerKind = (e) => (dresses.includes(e) ? "dress" : outerwear.includes(e) ? "jacket" : "top");
  const canOpen = (e) => layerKind(e) === "jacket" || isButtoned(e);
  const defaultOrder = [...dresses, ...tops.filter((e) => !isButtoned(e)), ...tops.filter(isButtoned), ...outerwear];
  const chosenOrder = Array.isArray(styling?.layers) ? styling.layers : [];
  const byId = new Map(defaultOrder.map((e) => [e.item?.id, e]));
  const orderedUpper = [
    ...chosenOrder.map((entry) => byId.get(entry.id)).filter(Boolean),
    ...defaultOrder.filter((e) => !chosenOrder.some((entry) => entry.id === e.item?.id)),
  ];
  const chosenStyle = new Map(chosenOrder.map((entry) => [entry.id, entry.style]));
  const styleOf = (e, index) => {
    let style = chosenStyle.get(e.item?.id);
    if (!style) {
      if (layerKind(e) === "jacket") style = jacket || "open";
      else if (isButtoned(e)) style = shirtStyle === "open" ? "open" : "closed";
      else style = index === 0 ? "closed" : "front";
    }
    if (style === "open" && !canOpen(e)) style = "closed";
    // "In front" / "behind" are no longer offered: the order of the layers decides
    // what lies on what, so older looks that used them are laid as closed
    if (style === "front" || style === "behind") style = "closed";
    return style;
  };
  const simpleColumn = orderedUpper.length <= 5 && dresses.length <= 1 && bottoms.length <= 1
    && !(dresses.length && bottoms.length) && (orderedUpper.length + bottoms.length) > 0;
  if (simpleColumn) {
    const T = 300; // shoulder-to-waist, in pixels
    const shoulderY = currentY;
    const waistY = shoulderY + T;
    const lengthOf = (piece, table, fallback) => GARMENT_FIT[table][piece?.item?.fit?.length] ?? fallback;
    // Size a piece so its hem lands exactly at the chosen length (`hemUnits` torso
    // units below where it starts) and its width follows the fit: `baseW` is the
    // width for this cut (oversize gives a larger base) and the window around it is
    // narrow, so regular and oversize never look alike. The photo is stretched to
    // that box, but never squashed or pulled more than about a third.
    // Share of the picture's width covered by the garment along one row (0 = top,
    // 1 = bottom), from the cut-out's transparency
    const opaqueSpan = async (buffer, at) => {
      try {
        const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const y = Math.min(info.height - 1, Math.max(0, Math.round(info.height * at)));
        let first = -1;
        let last = -1;
        for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * info.channels + info.channels - 1] > 40) {
            if (first < 0) first = x;
            last = x;
          }
        }
        return first < 0 ? 1 : (last - first + 1) / info.width;
      } catch {
        return 1;
      }
    };
    const sizeTo = (piece, startUnits, hemUnits, baseW, ratio = piece.ratio, [minF, maxF] = [0.9, 1.08]) => {
      const h = Math.max(60, (hemUnits - startUnits) * T);
      let w = Math.max(baseW * minF, Math.min(baseW * maxF, h / ratio));
      const stretch = h / (w * ratio);
      if (stretch > 1.35) w = h / (ratio * 1.35);
      if (stretch < 0.75) w = h / (ratio * 0.75);
      return { w: Math.round(w), h: Math.round(h) };
    };
    const isOversize = (piece) => piece?.item?.fit?.oversize === true;
    const hemOf = (piece) => {
      const kind = layerKind(piece);
      return kind === "dress" ? lengthOf(piece, "dress", 2.3) : kind === "jacket" ? lengthOf(piece, "jacket", GARMENT_FIT.jacket.bottom) : lengthOf(piece, "top", GARMENT_FIT.top.waist);
    };

    const innerPiece = orderedUpper[0] || null;
    const bottomPiece = bottoms[0] || null;
    const isDressInner = innerPiece ? layerKind(innerPiece) === "dress" : false;
    const innerIsTop = innerPiece ? layerKind(innerPiece) === "top" : false;
    const isSkirt = bottomPiece && /skirt|חצאית/.test(bottomPiece.nameLower);
    const draw = []; // [piece, box] in drawing order, first is lowest

    // Trousers are sized first: a regular top is as wide as their waist, an
    // oversized one clearly wider
    const bottomEnd = bottomPiece ? lengthOf(bottomPiece, "bottom", isSkirt ? 2.25 : ANKLE) : null;
    const bottomSize = bottomPiece ? sizeTo(bottomPiece, 1, bottomEnd, isOversize(bottomPiece) ? 440 : 360, bottomPiece.ratio, [0.85, 1.05]) : null;
    const waistW = bottomSize ? bottomSize.w : 360;
    // With a belt the top, belt and trousers are laid apart, so each keeps its own
    // size and position; without one the top is fitted to the trousers
    const laidApart = belts.length > 0 && Boolean(bottomPiece);

    // Cuts a piece in two and spreads the halves `gap` apart around the body line
    const openBoxes = async (piece, size, gap, top, split = false) => {
      if (piece.openBuffer && !split) return [{ left: centerX - size.w / 2, top, w: size.w, h: size.h, buffer: piece.openBuffer, fit: "fill" }];
      const halves = await splitDownTheMiddle(piece.openBuffer || piece.buffer);
      const halfW = Math.round(size.w / 2);
      return [
        { left: centerX - gap / 2 - halfW, top, w: halfW, h: size.h, buffer: halves.left, fit: "fill" },
        { left: centerX + gap / 2, top, w: halfW, h: size.h, buffer: halves.right, fit: "fill" },
      ];
    };

    let innerBox = null;
    let innerNaturalW = 0; // the first layer's width before it is fitted to a waistband
    const innerDraws = []; // the innermost layer when it is not a single box (open on its own)
    // In or out is about the first layer only (the one on the body); every layer
    // over it always lies over the trousers.
    const tuckInner = innerIsTop && Boolean(bottomPiece) && topStyle === "tucked";
    const outInner = innerIsTop && Boolean(bottomPiece) && !tuckInner;
    if (innerPiece) {
      let hem = hemOf(innerPiece);
      // Without a belt: tucked, its hem goes under the waistband (the trousers lie
      // over it); out, it hangs over the waistband even when it is cut to the trouser line
      if (!laidApart && tuckInner) hem = Math.max(hem, 1.22);
      if (!laidApart && outInner && hem >= 0.98) hem = Math.max(hem, 1.14);
      const big = isOversize(innerPiece);
      const kind = layerKind(innerPiece);
      const size = kind === "dress"
        ? sizeTo(innerPiece, 0, hem, big ? 500 : 420)
        : kind === "jacket"
          ? sizeTo(innerPiece, 0, hem, waistW * (big ? 1.3 : 1.1), innerPiece.ratio, [0.95, 1.06])
          : sizeTo(innerPiece, 0, hem, waistW * bustToHips * (big ? 1.32 : 1.0), innerPiece.ratio, big ? [0.97, 1.1] : [0.92, 1.04]);
      // A top tucked into the trousers is exactly as wide as their waistband: the
      // width of the top's hem (not its sleeves) matches the trousers' waist
      innerNaturalW = size.w;
      if (tuckInner) {
        const waistSpan = await opaqueSpan(bottomPiece.buffer, 0.03);
        const hemSpan = await opaqueSpan(innerPiece.buffer, 0.94);
        size.w = Math.round(Math.max(waistW * 0.6, Math.min(waistW * 2.2, (waistW * waistSpan) / Math.max(0.2, hemSpan))));
      }
      // Keep the hem at the chosen length: a short photo starts a little lower
      const drop = bottomPiece && kind !== "dress" && !laidApart ? Math.max(0, Math.round(hem * T - size.h)) : 0;
      innerBox = { left: centerX - size.w / 2, top: shoulderY + Math.min(drop, Math.round(T * 0.45)), w: size.w, h: size.h, fit: "fill" };
      // With a belt the pieces are laid apart, so a tucked top shows only down to the
      // waist: the part that goes into the trousers is folded under
      if (laidApart && tuckInner && hem > 1.02 && !(orderedUpper.length === 1 && canOpen(innerPiece) && styleOf(innerPiece, 0) === "open")) {
        const visible = 1 / hem;
        const meta = await sharp(innerPiece.buffer).metadata();
        const cropH = Math.max(20, Math.round(meta.height * visible));
        innerBox.buffer = await sharp(innerPiece.buffer).extract({ left: 0, top: 0, width: meta.width, height: Math.min(meta.height, cropH) }).png().toBuffer();
        innerBox.h = Math.round(size.h * visible);
      }
      // A button-up shirt or jacket on its own, laid open with nothing under it
      if (orderedUpper.length === 1 && canOpen(innerPiece) && styleOf(innerPiece, 0) === "open") {
        innerDraws.push(...(await openBoxes(innerPiece, size, Math.round(size.w * 0.22), innerBox.top)));
      }
    }
    // Collars line up with the innermost layer's
    const collarY = innerBox ? innerBox.top : shoulderY;

    // Outer layers. Layers that are not open (closed, in front, behind) are laid
    // next to each other in a row, so every one is seen whole; open layers go over
    // everything, their fronts at the two sides of the row.
    const aboveDraws = [];
    const closedDraws = []; // drawn under every open layer
    const behindDraws = [];
    const upperBoxes = innerBox && !innerDraws.length ? [innerBox] : [...innerDraws];
    const rowBoxes = innerBox && !innerDraws.length ? [innerBox] : [];
    // A short inner top (a crop) does not make the layers over it smaller
    const bodyW = Math.round(waistW * bustToHips);
    let prevW = Math.max(innerBox ? innerNaturalW || innerBox.w : 0, bodyW);
    let widest = prevW;
    let rowUsed = false;
    const sizeLayer = (piece, style, underW) => {
      const big = isOversize(piece);
      const base = underW * (layerKind(piece) === "jacket" ? (big ? 1.3 : 1.1) : (big ? 1.25 : 1.06));
      return sizeTo(piece, 0, hemOf(piece), base, style === "open" && piece.openBuffer ? piece.openRatio : piece.ratio, [0.96, 1.06]);
    };
    const layered = orderedUpper.slice(1).map((piece, i) => ({ piece, style: styleOf(piece, i + 1) }));
    for (const { piece, style } of layered.filter((layer) => layer.style !== "open")) {
      const size = sizeLayer(piece, style, prevW);
      const rowRight = rowBoxes.length ? Math.max(...rowBoxes.map((box) => box.left + box.w)) : centerX - size.w / 2;
      // A closed layer covers half of the layer it lies on
      const lastRow = rowBoxes[rowBoxes.length - 1];
      const overlap = !lastRow ? 0 : style === "closed"
        ? Math.round(Math.min(lastRow.w * 0.5, size.w * 0.6))
        : Math.round(Math.min(size.w, prevW) * 0.3);
      const box = { left: rowRight - overlap, top: collarY + (rowBoxes.length ? 8 : 0), w: size.w, h: size.h, fit: "fill" };
      if (style === "behind") behindDraws.unshift([piece, box]);
      else closedDraws.push([piece, box]);
      rowBoxes.push(box);
      upperBoxes.push(box);
      rowUsed = rowBoxes.length > 1;
      prevW = size.w;
      widest = Math.max(widest, size.w);
    }
    // The row is centred, so the open layers frame it evenly
    if (rowBoxes.length > 1) {
      const minLeft = Math.min(...rowBoxes.map((box) => box.left));
      const maxRight = Math.max(...rowBoxes.map((box) => box.left + box.w));
      const shift = Math.round(centerX - (minLeft + maxRight) / 2);
      for (const box of rowBoxes) box.left += shift;
    }
    const rowW = rowBoxes.length ? Math.max(...rowBoxes.map((box) => box.left + box.w)) - Math.min(...rowBoxes.map((box) => box.left)) : prevW;
    let prevGap = 0;
    let openUnderW = widest;
    for (const { piece, style } of layered.filter((layer) => layer.style === "open")) {
      const size = sizeLayer(piece, style, openUnderW);
      const halfW = size.w / 2;
      // Each open layer spreads wider than the open layer under it, so every one peeks out;
      // over a row of layers its fronts sit at the row's two sides
      const gap = prevGap
        ? prevGap + Math.round(openUnderW * 0.3)
        : rowBoxes.length > 1
          ? Math.round(rowW - halfW * 0.8)
          : Math.min(Math.round(size.w * 0.78), Math.round(openUnderW * 0.42));
      const boxes = await openBoxes(piece, size, gap, collarY, rowBoxes.length > 1);
      prevGap = gap;
      aboveDraws.push(...boxes.map((box) => [piece, box]));
      upperBoxes.push(...boxes);
      openUnderW = size.w;
    }
    const diagonalUsed = rowUsed;
    const jacketHemY = upperBoxes.length ? Math.max(...upperBoxes.map((box) => box.top + box.h)) : null;
    const jacketPiece = orderedUpper.length > 1 ? orderedUpper[orderedUpper.length - 1] : null;
    // Trousers, belt and shoes line up under the top (it may sit off-centre beside a jacket)
    // (with layers laid in a row, under the middle of the whole row)
    const bodyX = innerBox && (!diagonalUsed || tuckInner) ? innerBox.left + innerBox.w / 2 : centerX;

    let bottomBox = null;
    if (bottomPiece) {
      const top = innerPiece || jacketPiece ? waistY : shoulderY;
      bottomBox = { left: bodyX - bottomSize.w / 2, top, w: bottomSize.w, h: bottomSize.h, end: bottomEnd, fit: "fill" };
    }

    // With a belt the pieces are laid apart: top, a gap, the belt, a gap, then the
    // trousers. Without a belt the lengths chosen for each piece decide the overlap.
    let beltBoxes = [];
    if (belts.length && bottomBox) {
      const upperBottom = rowBoxes.length > 1 ? Math.max(...rowBoxes.map((box) => box.top + box.h)) : innerBox ? innerBox.top + innerBox.h : jacketHemY ?? shoulderY;
      const gap = 22;
      let y = upperBottom + gap;
      beltBoxes = belts.map((belt) => {
        // A belt sits at the waist, which is narrower than the hips
        const w = Math.round(Math.max(220, Math.min(420, bottomBox.w * waistToHips * 1.08)));
        const h = Math.min(110, Math.round(w * belt.ratio));
        const box = { piece: belt, left: bodyX - w / 2, top: y, w, h };
        y += h + 10;
        return box;
      });
      bottomBox.top = y - 10 + gap;
    } else if (belts.length) {
      const meetY = innerBox ? innerBox.top + innerBox.h + 20 : waistY;
      beltBoxes = belts.map((belt, i) => {
        const w = 380;
        const h = Math.min(110, Math.round(w * belt.ratio));
        return { piece: belt, left: bodyX - w / 2, top: meetY + i * (h + 10), w, h };
      });
    }

    // Socks go between the trousers and the shoes: just under the hem, with the
    // shoes over their lower part
    const lowestAbove = Math.max(
      bottomBox ? bottomBox.top + bottomBox.h : 0,
      ...beltBoxes.map((box) => box.top + box.h),
      innerBox ? innerBox.top + innerBox.h : 0,
      jacketHemY || 0,
    );
    const sockBoxes = [];
    if (socks.length) {
      const w = socks.length > 1 ? 150 : 210;
      const totalW = socks.length * w + (socks.length - 1) * 20;
      socks.slice(0, 2).forEach((sock, i) => {
        const h = Math.min(240, Math.round(w * sock.ratio));
        sockBoxes.push({ piece: sock, left: bodyX - totalW / 2 + i * (w + 20), top: lowestAbove - Math.round(h * 0.12), w, h });
      });
    }

    // Shoes sit at the ankle under long trousers or a long dress; otherwise a little below the hem
    const shoeBoxes = [];
    if (shoes.length) {
      const lowest = sockBoxes.length ? Math.max(...sockBoxes.map((box) => box.top + box.h)) : lowestAbove;
      const pair = shoes.slice(0, 2);
      const w = pair.length === 2 ? 270 : 320;
      const shoeH = Math.min(220, Math.round(w * pair[0].ratio));
      // Over the shoe: the hem covers the top third of the shoe. To the ankle: they
      // just meet. Shorter: a small gap.
      const end = bottomBox ? bottomBox.end : innerBox && isDressInner ? lengthOf(innerPiece, "dress", 2.3) : 0;
      const shoeTop = sockBoxes.length ? lowest - Math.round(shoeH * 0.3)
        : end >= 3.1 ? lowest - Math.round(shoeH * 0.35)
        : end >= 2.9 ? lowest - 6
        : lowest + 26;
      const gapX = 24;
      const totalW = pair.length * w + (pair.length - 1) * gapX;
      pair.forEach((shoe, i) => {
        const h = Math.min(220, Math.round(w * shoe.ratio));
        shoeBoxes.push({ piece: shoe, left: bodyX - totalW / 2 + i * (w + gapX), top: shoeTop, w, h });
      });
      shoes.slice(2).forEach((shoe, i) => {
        const h = Math.min(200, Math.round(260 * shoe.ratio));
        shoeBoxes.push({ piece: shoe, left: bodyX - 130, top: shoeTop + 230 + i * 220, w: 260, h });
      });
    }

    // Drawing order, lowest first. Shoes go under the trousers so long trousers fall over them.
    const tucked = tuckInner;
    // Socks lowest, then shoes over them, then trousers over both
    for (const box of sockBoxes) draw.push([box.piece, box]);
    for (const box of shoeBoxes) draw.push([box.piece, box]);
    draw.push(...behindDraws);
    const middle = [];
    if (innerBox) {
      if (innerDraws.length) middle.push(...innerDraws.map((box) => [innerPiece, box]));
      else middle.push([innerPiece, innerBox]);
    }
    if (bottomBox) {
      if (tucked) middle.push([bottomPiece, bottomBox]);
      else middle.unshift([bottomPiece, bottomBox]);
    }
    draw.push(...middle);
    // Closed layers first, then every open layer over everything, fronts at the sides
    draw.push(...closedDraws);
    draw.push(...aboveDraws);
    // Drawn last so nothing hides it
    for (const box of beltBoxes) draw.push([box.piece, box]);

    for (const [piece, box] of draw) {
      await placeItem(piece, { targetW: box.w, targetH: box.h, left: box.left, top: box.top, blur: 7, opacity: 0.24, buffer: box.buffer, fit: box.fit || "contain" });
    }
    const bottomEdge = Math.max(...draw.map(([, box]) => box.top + box.h));
    currentY = bottomEdge + 25;
  } else {
  // 2. Tops / Outerwear / Dresses
  const allUpper = [...outerwear, ...tops, ...dresses];
  const upperTopY = currentY;
  let upperBottom = null;
  // Where the bottoms start when they overlap the top (the hem of the inner top)
  let tuckLine = null;
  // True when the jacket lies underneath the top rather than over it
  let jacketUnder = false;
  if (allUpper.length === 1) {
    const item = allUpper[0];
    const isFullDress = dresses.includes(item);
    const targetW = isFullDress ? 440 : 410;
    const targetH = Math.min(isFullDress ? 760 : 520, Math.round(targetW * item.ratio));
    const leftX = Math.round(centerX - targetW / 2);
    await placeItem(item, { targetW, targetH, left: leftX, top: currentY, blur: 7, opacity: 0.24 });
    currentY += targetH + 15;
  } else if (allUpper.length === 2) {
    // 2 pieces: if outerwear + inner top, arrange jacket flanking or stylish side-by-side
    const hasOuter = outerwear.length > 0;
    const piece1 = allUpper[0];
    const piece2 = allUpper[1];

    if (hasOuter && jacket) {
      const outerPiece = outerwear[0];
      const innerPiece = (allUpper[0] === outerPiece) ? allUpper[1] : allUpper[0];
      if (jacket === "open" && outerPiece.openBuffer) {
        // The jacket's own open photo (empty between the fronts) lies over the top
        const outerW = 480;
        const outerH = Math.min(620, Math.round(outerW * outerPiece.openRatio));
        const innerW = 320;
        const innerH = Math.min(460, Math.round(innerW * innerPiece.ratio));
        const innerTop = currentY + 6;
        await placeItem(innerPiece, { targetW: innerW, targetH: innerH, left: centerX - innerW / 2, top: innerTop, blur: 6, opacity: 0.2 });
        await placeItem(outerPiece, { targetW: outerW, targetH: outerH, left: centerX - outerW / 2, top: currentY, blur: 8, opacity: 0.25, buffer: outerPiece.openBuffer });
        tuckLine = innerTop + innerH;
        upperBottom = Math.max(currentY + outerH, innerTop + innerH);
        currentY = upperBottom + 15;
      } else if (jacket === "open") {
        // No open photo: cut the jacket in two and spread the halves over the sides of the top
        const halves = await splitDownTheMiddle(outerPiece.buffer);
        const jacketW = 430;
        const halfW = Math.round(jacketW / 2);
        const jacketH = Math.min(600, Math.round(jacketW * halves.ratio));
        const innerW = 320;
        const innerH = Math.min(460, Math.round(innerW * innerPiece.ratio));
        const gap = Math.round(innerW * 0.42);
        const innerTop = currentY + 6;
        await placeItem(innerPiece, { targetW: innerW, targetH: innerH, left: centerX - innerW / 2, top: innerTop, blur: 6, opacity: 0.2 });
        // Each half keeps its height and stays against its cut edge
        await placeItem(outerPiece, { targetW: halfW, targetH: jacketH, left: centerX - gap / 2 - halfW, top: currentY, blur: 8, opacity: 0.25, buffer: halves.left, fit: "fill" });
        await placeItem(outerPiece, { targetW: halfW, targetH: jacketH, left: centerX + gap / 2, top: currentY, blur: 8, opacity: 0.25, buffer: halves.right, fit: "fill" });
        tuckLine = innerTop + innerH;
        upperBottom = Math.max(currentY + jacketH, innerTop + innerH);
        currentY = upperBottom + 15;
      } else if (jacket === "behind") {
        // Whole jacket underneath, top centred on it and a little lower so the collar shows
        const outerW = 440;
        const outerH = Math.min(600, Math.round(outerW * outerPiece.ratio));
        const innerW = 300;
        const innerH = Math.min(440, Math.round(innerW * innerPiece.ratio));
        const innerTop = currentY + Math.round(outerH * 0.12);
        await placeItem(outerPiece, { targetW: outerW, targetH: outerH, left: centerX - outerW / 2, top: currentY, blur: 8, opacity: 0.25 });
        await placeItem(innerPiece, { targetW: innerW, targetH: innerH, left: centerX - innerW / 2, top: innerTop, blur: 6, opacity: 0.2 });
        jacketUnder = true;
        upperBottom = Math.max(currentY + outerH, innerTop + innerH);
        currentY = upperBottom + 15;
      } else {
        // Whole jacket in front: the top underneath and slightly higher, jacket on top of it
        const innerW = 330;
        const innerH = Math.min(480, Math.round(innerW * innerPiece.ratio));
        const outerW = 420;
        const outerH = Math.min(580, Math.round(outerW * outerPiece.ratio));
        const outerTop = currentY + 34;
        await placeItem(innerPiece, { targetW: innerW, targetH: innerH, left: centerX - innerW / 2, top: currentY, blur: 6, opacity: 0.2 });
        await placeItem(outerPiece, { targetW: outerW, targetH: outerH, left: centerX - outerW / 2, top: outerTop, blur: 8, opacity: 0.25 });
        upperBottom = Math.max(currentY + innerH, outerTop + outerH);
        currentY = upperBottom + 15;
      }
    } else if (hasOuter) {
      const outerPiece = outerwear[0];
      const innerPiece = (allUpper[0] === outerPiece) ? allUpper[1] : allUpper[0];

      const outerW = 390;
      const outerH = Math.min(540, Math.round(outerW * outerPiece.ratio));
      const innerW = 360;
      const innerH = Math.min(500, Math.round(innerW * innerPiece.ratio));

      const outerLeft = Math.round(centerX - 240);
      const innerLeft = Math.round(centerX - 100);

      // Inner first then outer slightly overlaid to left
      await placeItem(innerPiece, { targetW: innerW, targetH: innerH, left: innerLeft, top: currentY, blur: 6, opacity: 0.2 });
      await placeItem(outerPiece, { targetW: outerW, targetH: outerH, left: outerLeft, top: currentY, blur: 8, opacity: 0.25 });
      currentY += Math.max(outerH, innerH) + 15;
    } else {
      // 2 tops: clean side-by-side
      const targetW = 360;
      const h1 = Math.min(500, Math.round(targetW * piece1.ratio));
      const h2 = Math.min(500, Math.round(targetW * piece2.ratio));

      await placeItem(piece1, { targetW, targetH: h1, left: centerX - 380, top: currentY });
      await placeItem(piece2, { targetW, targetH: h2, left: centerX + 20, top: currentY });
      currentY += Math.max(h1, h2) + 15;
    }
  } else if (allUpper.length > 2) {
    // 3 or more tops/outerwear: grid with 2 per row
    const targetW = 350;
    for (let i = 0; i < allUpper.length; i += 2) {
      const item1 = allUpper[i];
      const item2 = allUpper[i + 1];
      const h1 = Math.min(480, Math.round(targetW * item1.ratio));
      await placeItem(item1, { targetW, targetH: h1, left: item2 ? (centerX - 370) : (centerX - targetW / 2), top: currentY });

      let rowH = h1;
      if (item2) {
        const h2 = Math.min(480, Math.round(targetW * item2.ratio));
        await placeItem(item2, { targetW, targetH: h2, left: centerX + 20, top: currentY });
        rowH = Math.max(h1, h2);
      }
      currentY += rowH + 15;
    }
  }

  // Tucked or untucked: the bottoms overlap the hem of the top a little.
  // Only when there is a separate top (not a dress) and bottoms to tuck into.
  const canTuck = topStyle && !belts.length && bottoms.length > 0 && allUpper.length > 0 && !allUpper.every((e) => dresses.includes(e));
  if (canTuck) {
    const sectionBottom = tuckLine ?? upperBottom ?? (currentY - 15);
    const upperHeight = Math.max(1, sectionBottom - upperTopY);
    const overlap = Math.round(Math.min(140, upperHeight * (topStyle === "tucked" ? 0.2 : 0.12)));
    currentY = sectionBottom - overlap;
  }

  // 3. Belts
  if (belts.length > 0) {
    for (const belt of belts) {
      const targetW = 380;
      const targetH = Math.min(110, Math.round(targetW * belt.ratio));
      const leftX = Math.round(centerX - targetW / 2);
      await placeItem(belt, { targetW, targetH, left: leftX, top: currentY, blur: 5, opacity: 0.2 });
      currentY += targetH + 12;
    }
  }

  // 4. Bottoms (Pants / Skirts / Shorts)
  if (bottoms.length === 1) {
    const b = bottoms[0];
    const isShort = b.nameLower.includes("skirt") || b.nameLower.includes("short");
    const targetW = isShort ? 390 : 420;
    const targetH = Math.min(isShort ? 440 : 660, Math.round(targetW * b.ratio));
    const leftX = Math.round(centerX - targetW / 2);
    await placeItem(b, { targetW, targetH, left: leftX, top: currentY, blur: 7, opacity: 0.22 });
    currentY += targetH + 20;
  } else if (bottoms.length > 1) {
    // Multiple bottoms: 2 per row side-by-side so none are hidden
    const targetW = 340;
    for (let i = 0; i < bottoms.length; i += 2) {
      const b1 = bottoms[i];
      const b2 = bottoms[i + 1];
      const isShort1 = b1.nameLower.includes("skirt") || b1.nameLower.includes("short");
      const h1 = Math.min(isShort1 ? 420 : 620, Math.round(targetW * b1.ratio));
      await placeItem(b1, { targetW, targetH: h1, left: b2 ? (centerX - 360) : (centerX - targetW / 2), top: currentY });

      let rowH = h1;
      if (b2) {
        const isShort2 = b2.nameLower.includes("skirt") || b2.nameLower.includes("short");
        const h2 = Math.min(isShort2 ? 420 : 620, Math.round(targetW * b2.ratio));
        await placeItem(b2, { targetW, targetH: h2, left: centerX + 20, top: currentY });
        rowH = Math.max(h1, h2);
      }
      currentY += rowH + 20;
    }
  }

  // Untucked: the top lies over the waistband of the bottoms.
  // Tucked: the bottoms cover the hem of the top.
  // A jacket lying over the top stays on top of everything; one lying under it stays under.
  if (canTuck) {
    const inner = allUpper.filter((piece) => !outerwear.includes(piece));
    if (jacketUnder) {
      if (topStyle === "out") bringToFront(inner);
    } else {
      bringToFront(topStyle === "out" ? [...inner, ...outerwear] : outerwear);
    }
  }

  // Socks between the trousers and the shoes
  for (const sock of socks) {
    const targetW = 220;
    const targetH = Math.min(240, Math.round(targetW * sock.ratio));
    await placeItem(sock, { targetW, targetH, left: Math.round(centerX - targetW / 2), top: currentY, blur: 5, opacity: 0.18 });
    currentY += targetH + 14;
  }

  // 5. Shoes
  if (shoes.length === 1) {
    const shoe = shoes[0];
    const targetW = 330;
    const targetH = Math.min(230, Math.round(targetW * shoe.ratio));
    const leftX = Math.round(centerX - targetW / 2);
    await placeItem(shoe, { targetW, targetH, left: leftX, top: currentY, blur: 6, opacity: 0.2 });
    currentY += targetH + 25;
  } else if (shoes.length > 1) {
    const targetW = 300;
    for (let i = 0; i < shoes.length; i += 2) {
      const s1 = shoes[i];
      const s2 = shoes[i + 1];
      const h1 = Math.min(220, Math.round(targetW * s1.ratio));
      await placeItem(s1, { targetW, targetH: h1, left: s2 ? (centerX - 320) : (centerX - targetW / 2), top: currentY });

      let rowH = h1;
      if (s2) {
        const h2 = Math.min(220, Math.round(targetW * s2.ratio));
        await placeItem(s2, { targetW, targetH: h2, left: centerX + 20, top: currentY });
        rowH = Math.max(h1, h2);
      }
      currentY += rowH + 20;
    }
  }

  }

  // 6. Left side accessories (Bags, backpacks, luggage)
  let leftSideY = 140;
  for (const bag of bags) {
    const targetW = 280;
    const targetH = Math.min(340, Math.round(targetW * bag.ratio));
    await placeItem(bag, { targetW, targetH, left: 80, top: leftSideY, blur: 7, opacity: 0.22 });
    leftSideY += targetH + 30;
  }

  // 7. Right side accessories (Jewelry, watches, glasses, etc.)
  let rightSideY = 140;
  for (const acc of otherAccessories) {
    const targetW = 190;
    const targetH = Math.min(200, Math.round(targetW * acc.ratio));
    await placeItem(acc, { targetW, targetH, left: 890, top: rightSideY, blur: 5, opacity: 0.2 });
    rightSideY += targetH + 25;
  }

  // 8. Bounding box & margins check
  const minLeft = placedBoxes.length ? Math.min(...placedBoxes.map((b) => b.left)) : 80;
  const minTop = placedBoxes.length ? Math.min(...placedBoxes.map((b) => b.top)) : 80;

  const leftPadding = 80;
  const topPadding = 80;
  const shiftX = minLeft < leftPadding ? leftPadding - minLeft : 0;
  const shiftY = minTop < topPadding ? topPadding - minTop : 0;

  if (shiftX > 0 || shiftY > 0) {
    for (const comp of composites) {
      comp.left += shiftX;
      comp.top += shiftY;
    }
    for (const b of placedBoxes) {
      b.left += shiftX;
      b.top += shiftY;
    }
  }

  const maxRight = placedBoxes.length ? Math.max(...placedBoxes.map((b) => b.left + b.width)) : 1000;
  const maxBottom = placedBoxes.length
    ? Math.max(
        ...placedBoxes.map((b) => b.top + b.height),
        currentY + shiftY,
        leftSideY + shiftY,
        rightSideY + shiftY
      )
    : 1000;

  const finalCanvasWidth = Math.max(1200, Math.round(maxRight + 80));
  const finalCanvasHeight = Math.max(1200, Math.round(maxBottom + 90));

  const bg = await sharp({
    create: {
      width: Math.round(finalCanvasWidth),
      height: Math.round(finalCanvasHeight),
      channels: 4,
      background: { r: 248, g: 246, b: 242, alpha: 1 },
    },
  }).png().toBuffer();

  return sharp(bg).composite(composites).png().toBuffer();
}

// Account problems (no credits, bad key) get a clear Hebrew message and an
// `accountProblem` flag so callers can tell the user instead of failing silently.
export function openAIError(status, result = {}, fallback = "OpenAI request failed") {
  const code = result.error?.code || result.error?.type || "";
  let message = result.error?.message || fallback;
  let accountProblem = false;
  if (code === "insufficient_quota" || code === "billing_hard_limit_reached" || /quota|billing/i.test(message)) {
    message = "נגמרו הקרדיטים בחשבון OpenAI. אפשר להטעין יתרה ב-platform.openai.com ← Billing ולנסות שוב.";
    accountProblem = true;
  } else if (status === 401 || code === "invalid_api_key") {
    message = "המפתח של OpenAI לא תקין או בוטל. צריך לעדכן אותו בהגדרות של Netlify.";
    accountProblem = true;
  } else if (status === 429) {
    message = "OpenAI עמוס כרגע או שהגעת למגבלת הבקשות. נסו שוב בעוד דקה.";
  }
  return Object.assign(new Error(message), { accountProblem });
}

// Keys pasted into Netlify are sometimes the masked "••••" shown by a dashboard,
// which cannot be sent in a header. Explain that instead of a cryptic fetch error.
export function checkApiKey(key, service) {
  if (/^[!-~]+$/.test(key)) return key;
  throw Object.assign(new Error(`המפתח של ${service} שמוגדר ב-Netlify לא תקין: יש בו נקודות או תווים שלא שייכים למפתח. כנראה הועתק המפתח המוסתר (••••). צריך ליצור מפתח חדש, להעתיק אותו מיד כשהוא מוצג, ולעדכן אותו ב-Netlify.`), { accountProblem: true, status: 400 });
}

// Crops a transparent garment image to the garment itself (ignoring faint
// specks) and centres it on a square with a uniform margin, so every item looks
// the same size in the wardrobe whatever tool produced it.
export async function fitGarmentToSquare(bytes, size = 1024, occupancy = 0.9) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let index = 3, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index] < 24) continue;
    const x = pixel % info.width;
    const y = (pixel - x) / info.width;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < minX) return bytes;
  const target = Math.round(size * occupancy);
  const garment = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .resize(target, target, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: garment.data, left: Math.floor((size - garment.info.width) / 2), top: Math.floor((size - garment.info.height) / 2) }])
    .png()
    .toBuffer();
}

async function openAIEditRequest({ key, baseUrl, model, prompt, images, size, background, quality }) {
  const form = new FormData();
  const validEditModel = (!model || model.includes("dall-e") || model.includes("mini")) ? "gpt-image-2" : model;
  form.set("model", validEditModel);

  let adjustedPrompt = prompt;
  if (images.length === 1) {
    const normalized = await normalizeImage(images[0].data);
    form.append("image", new Blob([normalized], { type: "image/png" }), "image.png");
  } else if (images.length > 1) {
    const composite = await buildModeledComposite(images[0].data, images.slice(1));
    form.append("image", new Blob([composite], { type: "image/png" }), "reference.png");
    adjustedPrompt = prompt
      .replace(/Image 1/g, "the person reference on the left of the image")
      .replace(/Image 2/g, "the garment cutout on the right of the image")
      .replace(/Image 3/g, "the second garment cutout on the right of the image")
      .replace(/Image 4/g, "the third garment cutout on the right of the image");
  }

  form.set("prompt", adjustedPrompt);
  form.set("size", size || "1024x1024");
  form.set("quality", quality || "high");
  form.set("output_format", "png");
  if (background) form.set("background", background);

  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${checkApiKey(key, "OpenAI")}` }, body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw openAIError(response.status, result, `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI response did not contain image data");
  return Buffer.from(encoded, "base64");
}

async function openAIAnalyzeRequest({ key, baseUrl, model, image, mime }) {
  const validVisionModel = (!model || model.includes("5.4") || !model.includes("gpt-4")) ? "gpt-4o-mini" : model;
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${checkApiKey(key, "OpenAI")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: validVisionModel,
      input: [{ role: "user", content: [
        { type: "input_text", text: "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful short detail tags written in Hebrew (for example: כותנה, פסים, קיץ, יומיומי)." },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", minItems: 0, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, maxItems: 4 }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"] } } }, required: ["items"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw openAIError(response.status, result, `OpenAI analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI analysis returned an invalid clothing list");
  return parsed.items;
}

async function geminiAnalyze({ image, mime = "image/png" }) {
  const { GoogleGenAI, Type } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { headers: { "User-Agent": "aistudio-build" } },
  });
  const prompt = "Identify every distinct wearable clothing item visible in this image. Return one record per actual item. Include integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner (0-999), followed by width and height (1-1000). Use only category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Suggest a concise specific name, primary six-digit hex color (#rrggbb), optional secondary hex color, and 1-4 short detail tags written in Hebrew.";
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite",
    contents: [
      {
        parts: [
          { inlineData: { data: image.toString("base64"), mimeType: mime } },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                part: { type: Type.STRING },
                color: { type: Type.STRING },
                secondaryColor: { type: Type.STRING },
                tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                boundingBox: {
                  type: Type.OBJECT,
                  properties: {
                    x: { type: Type.INTEGER },
                    y: { type: Type.INTEGER },
                    width: { type: Type.INTEGER },
                    height: { type: Type.INTEGER },
                  },
                  required: ["x", "y", "width", "height"],
                },
              },
              required: ["name", "part", "color", "tags", "boundingBox"],
            },
          },
        },
        required: ["items"],
      },
    },
  });
  const text = response.text?.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

// Routes that can run longer than a hosted request allows (AI image generation).
// Hosts with a request time limit run them as background tasks; see enqueueRequest.
const LONG_ROUTES = [
  { method: "POST", pattern: /^\/api\/import\/outfits\/generate$/ },
  { method: "POST", pattern: /^\/api\/import\/outfits\/auto-generate$/ },
  { method: "POST", pattern: /^\/api\/import\/inspiration$/ },
  { method: "POST", pattern: /^\/api\/import\/wishlist\/[a-f0-9-]{36}\/generate$/i },
  { method: "POST", pattern: /^\/api\/import\/wishlist\/analyze$/ },
  { method: "POST", pattern: /^\/api\/import\/wardrobe\/import-[a-f0-9-]{36}\/modeled$/i },
  { method: "POST", pattern: /^\/api\/import\/wardrobe\/import-[a-f0-9-]{36}\/regenerate$/i },
  { method: "POST", pattern: /^\/api\/import\/wardrobe\/import-[a-f0-9-]{36}\/open-version$/i },
];

/**
 * Creates the wardrobe API over a key/value store (see server/stores.mjs).
 *
 * - `handle(request)` answers a web `Request` for /api/import/* with a `Response`
 *   (or null for other paths).
 * - `defer(task)` schedules slow work (garment/modeled generation, refits, long
 *   requests). Locally it can simply run the task; on Netlify it starts a
 *   background function that calls `runDeferred(task)`.
 */
// Estimated OpenAI charge per request, in US dollars (gpt-image-2 prices checked
// October 2026). Several reference photos are sent as one combined image, so every
// edit has one image input plus the written prompt.
const IMAGE_OUTPUT_USD = {
  low: { square: 0.006, wide: 0.005 },
  medium: { square: 0.053, wide: 0.041 },
  high: { square: 0.211, wide: 0.165 },
};
const IMAGE_INPUT_USD = 0.006;
// gpt-4o-mini, per token
const TEXT_INPUT_USD = 0.15 / 1e6;
const TEXT_OUTPUT_USD = 0.6 / 1e6;

export function estimateImageUsd({ quality = "high", size = "1024x1024" } = {}) {
  const table = IMAGE_OUTPUT_USD[quality] || IMAGE_OUTPUT_USD.high;
  return (size === "1024x1024" ? table.square : table.wide) + IMAGE_INPUT_USD;
}

export function estimateTextUsd(usage = {}) {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens) || 800;
  const output = Number(usage.completion_tokens ?? usage.output_tokens) || 200;
  return (input * TEXT_INPUT_USD) + (output * TEXT_OUTPUT_USD);
}

// The written request for a look on the user. Also offered to copy into ChatGPT.
export function buildLookPrompt(selectedGarments, { outfitName, backdrop, notes, body } = {}) {
    const garmentListDesc = selectedGarments.map((g, idx) => `Garment ${idx + 1}: ${g.name} (${g.part}, color: ${g.color || "as shown"})`).join(", ");
    const notesPrompt = notes?.trim()
      ? `\nStyling & fit instructions: ${notes.trim()}\nFollow these exact styling instructions precisely (e.g. open/closed, untucked/tucked, rolled sleeves, or shoulder tie).`
      : "";

    const hasOuter = selectedGarments.some((g) => g.part === "wholebody_up" || g.part === "outerwear" || g.part === "jacket");
    const layeredClause = hasOuter
      ? `\nLayered-look clause: Layer the exact inner top and outer layer naturally so both remain visibly identifiable. First inspect the outer reference. If it has a real full front button or zipper closure, it may be worn naturally open or partly open using only that closure. If it is a pullover or has no full front opening, keep it closed exactly as designed and reveal the inner top only at its real collar or neckline, sleeve or cuff edge, or a natural 2–4 cm untucked hem below the outer layer. Never invent, add, split, unzip, unbutton, or simulate a closure. Keep the outer garment at its true length even when it overlaps the waistband.`
      : "";

    return `Use case: identity-preserve
Asset type: square outfit gallery photograph

Image 1: identity reference for the exact person to preserve.
${selectedGarments.map((g, idx) => `Image ${idx + 2}: exact ${g.part} reference (${g.name})`).join("\n")}

Primary request: Create a professional square editorial fashion photograph of the person from Image 1 wearing all of the exact referenced garments (${garmentListDesc}), and only those garments.

Outfit: ${outfitName}
Scene/backdrop: ${backdrop}
${notesPrompt}

Subject: Preserve the same person's recognizable face, hair, age, build, skin texture, and body proportions.${bodyLine(body)} Dress them in the exact referenced garments. Plain understated shoes and invisible basics such as socks are allowed where needed. Do not add, replace, or invent any other visible clothing or accessory.

Style/medium: Photorealistic natural editorial fashion campaign with authentic skin and fabric texture and no synthetic AI polish.

Composition/framing: Square 1:1 image. Show the complete person and outfit from head through shoes. Keep the person centered and occupying most of the frame with modest breathing room. Use a relaxed, mostly front-facing pose with arms away from the torso so every item remains readable.

Lighting/mood: Warm professional natural light, realistic shadows, and restrained editorial color grading.

Garment fidelity: Preserve every referenced garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, and distinctive details. Keep each piece recognizable without changing its natural length, tuck, or construction.
${layeredClause}

Avoid: Completely hidden selected garments, invented zippers, buttons, openings, unnatural layering, extra people, text overlays, watermarks, studio cutout appearance, or synthetic AI polish.`;
}

// The written request for one garment on the user. Also offered to copy into ChatGPT.
export function buildModeledPrompt(record, note = "", body = {}) {
  const base = `Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail (${record.name}, ${record.part}). The garment colour must stay exactly ${record.color || "as shown in Image 2"}${record.secondaryColor ? ` with ${record.secondaryColor}` : ""}; do not recolour, tint, or restyle it. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.`;
  const withBody = `${base}${bodyLine(body)}`;
  return note ? `${withBody}\nUser direction about this garment and how it is worn: ${note}` : withBody;
}

// A photo the user made elsewhere (e.g. in ChatGPT), saved as a PNG of a sensible size
async function normalizeUpload(input) {
  const { data } = decodeImage(input);
  return sharp(data, { failOnError: false }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
}

export function createWardrobeApi({ store, env = {}, defer } = {}) {
  let serverSettings = null;
  const running = new Map();

  // Values pasted into a dashboard often carry stray spaces or line breaks
  const setting = (name, fallback = "") =>
    String(serverSettings?.[name] || env[name] || process.env[name] || fallback).trim();
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  // ── AI spending ──
  // Every paid OpenAI request made by the site is written down with its estimated
  // cost. The log is shared by all wardrobes, since they share one OpenAI key.
  const SPEND_KEY = "billing/spend.json";
  const BALANCE_KEY = "billing/balance.json";
  async function recordSpend(action, usd, wardrobeId = null) {
    try {
      const log = (await store.getJSON(SPEND_KEY).catch(() => null)) || { since: new Date().toISOString(), totalUsd: 0, months: {}, recent: [] };
      const at = new Date().toISOString();
      const month = at.slice(0, 7);
      log.totalUsd = Number(((log.totalUsd || 0) + usd).toFixed(6));
      log.months = { ...(log.months || {}), [month]: Number((((log.months || {})[month] || 0) + usd).toFixed(6)) };
      log.recent = [{ at, action, usd: Number(usd.toFixed(5)), wardrobeId }, ...(log.recent || [])].slice(0, 60);
      await store.setJSON(SPEND_KEY, log);
    } catch (error) {
      console.warn("Could not record AI spend:", error.message);
    }
  }

  async function openAIEdit(options) {
    const bytes = await openAIEditRequest(options);
    const action = options.action
      || (options.size && options.size !== "1024x1024" ? "פריט עליי"
        : (options.images?.length || 0) > 1 ? "לוק עליי" : "תמונת קטלוג");
    await recordSpend(action, estimateImageUsd(options), options.wardrobeId);
    return bytes;
  }

  async function openAIAnalyze(options) {
    const items = await openAIAnalyzeRequest(options);
    await recordSpend("זיהוי בגדים בתמונה", 0.001);
    return items;
  }

  // Actual charges from OpenAI. Needs an Admin key (OPENAI_ADMIN_KEY), because
  // regular project keys cannot read billing. OpenAI has no API for the remaining
  // credit balance, so the balance is entered by the user and spending is subtracted.
  // Daily charges for the past year from OpenAI's Costs API, fetched in one sweep
  // and kept for 15 minutes. OpenAI allows only a few billing requests a minute,
  // so the profile never asks it directly; a busy answer falls back to the saved copy.
  const COSTS_CACHE_KEY = "billing/costs-cache.json";
  const COSTS_FRESH_MS = 15 * 60 * 1000;
  async function openAICostBuckets() {
    const adminKey = setting("OPENAI_ADMIN_KEY").trim();
    if (!adminKey) return null;
    const projectId = setting("OPENAI_PROJECT_ID").trim();
    const cached = await store.getJSON(COSTS_CACHE_KEY).catch(() => null);
    const sameScope = cached && cached.projectId === (projectId || null);
    if (sameScope && Date.now() - Date.parse(cached.fetchedAt) < COSTS_FRESH_MS) return cached;
    try {
      const startTime = Math.floor(Date.now() / 1000 - 364 * 24 * 3600);
      const buckets = [];
      let page = null;
      for (let i = 0; i < 4; i++) {
        const params = new URLSearchParams({ start_time: String(startTime), bucket_width: "1d", limit: "180" });
        if (projectId) params.append("project_ids", projectId);
        if (page) params.set("page", page);
        const response = await fetch(`${apiBaseUrl()}/organization/costs?${params}`, {
          headers: { Authorization: `Bearer ${checkApiKey(adminKey, "OpenAI")}` },
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw Object.assign(new Error(response.status === 401 || response.status === 403
            ? "מפתח המנהל של OpenAI לא תקין או שאין לו הרשאה לנתוני חיוב."
            : "busy"), { quiet: response.status !== 401 && response.status !== 403 });
        }
        for (const bucket of result.data || []) {
          const usd = (bucket.results || []).reduce((total, row) => total + (Number(row.amount?.value) || 0), 0);
          buckets.push({ start: bucket.start_time, usd });
        }
        if (!result.has_more || !result.next_page) break;
        page = result.next_page;
      }
      const fresh = { fetchedAt: new Date().toISOString(), projectId: projectId || null, buckets };
      await store.setJSON(COSTS_CACHE_KEY, fresh).catch(() => {});
      return fresh;
    } catch (error) {
      // OpenAI busy or unreachable: use the last copy, however old, without a message
      if (sameScope) return { ...cached, stale: true };
      if (error.quiet) return { buckets: null, pending: true };
      throw error;
    }
  }
  const sumSince = (buckets, startSeconds) => buckets.reduce((total, bucket) => total + (bucket.start >= startSeconds - 86400 + 1 ? bucket.usd : 0), 0);

  async function billingSummary() {
    const log = (await store.getJSON(SPEND_KEY).catch(() => null)) || { since: null, totalUsd: 0, months: {}, recent: [] };
    const balance = await store.getJSON(BALANCE_KEY).catch(() => null);
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;

    const summary = {
      estimate: {
        since: log.since,
        totalUsd: log.totalUsd || 0,
        monthUsd: (log.months || {})[month] || 0,
        recent: (log.recent || []).slice(0, 8),
      },
      actual: { configured: Boolean(setting("OPENAI_ADMIN_KEY").trim()), projectFiltered: Boolean(setting("OPENAI_PROJECT_ID").trim()) },
      balance: null,
    };

    if (summary.actual.configured) {
      try {
        const costs = await openAICostBuckets();
        if (costs?.buckets) {
          const buckets = costs.buckets;
          summary.actual.monthUsd = buckets.reduce((total, bucket) => total + (bucket.start >= monthStart ? bucket.usd : 0), 0);
          // OpenAI keeps cost data for one year only
          summary.actual.yearUsd = buckets.reduce((total, bucket) => total + bucket.usd, 0);
          if (balance?.setAt) summary.actual.sinceBalanceUsd = sumSince(buckets, Date.parse(balance.setAt) / 1000);
          summary.actual.updatedAt = costs.fetchedAt;
        } else if (costs?.pending) {
          summary.actual.pending = true;
        }
      } catch (error) {
        summary.actual.error = error.message;
      }
    }

    if (balance && Number.isFinite(balance.balanceUsd)) {
      const usedFromActual = Number.isFinite(summary.actual.sinceBalanceUsd) ? summary.actual.sinceBalanceUsd : null;
      const usedFromEstimate = Math.max(0, (log.totalUsd || 0) - (balance.spentAtSet || 0));
      const used = usedFromActual ?? usedFromEstimate;
      summary.balance = {
        enteredUsd: balance.balanceUsd,
        setAt: balance.setAt,
        usedSinceUsd: used,
        remainingUsd: balance.balanceUsd - used,
        source: usedFromActual === null ? "estimate" : "actual",
      };
    }
    return summary;
  }

  async function loadSettings() {
    if (!serverSettings) serverSettings = (await store.getJSON("settings.json").catch(() => null)) || {};
  }

  async function requireBytes(key, message = "File not found") {
    const data = await store.getBytes(key);
    if (!data) throw notFound(message);
    return data;
  }

  const libraryKey = (name) => `imported/${name}`;

  // Garment photos for a flat lay, plus the AI "open" photo of jackets that have one
  async function withOpenVersions(entries) {
    for (const entry of entries) {
      if (!entry.item?.openImage) continue;
      entry.openBuffer = await store.getBytes(libraryKey(`${entry.item.id}-open.png`)).catch(() => null);
    }
    return entries;
  }

  // Resized WebP copies of stored images. The ?t= version is part of the key, so a
  // replaced photo (which always gets a new ?t=) gets a fresh copy.
  const VARIANT_WIDTHS = [160, 240, 320, 480, 640, 800, 1080];
  function variantWidth(url) {
    const requested = Number(url.searchParams.get("w"));
    if (!Number.isFinite(requested) || requested <= 0) return null;
    return VARIANT_WIDTHS.find((width) => width >= requested) || VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
  }
  async function imageVariant(name, url, width, fit, loadSource) {
    const version = (url.searchParams.get("t") || "0").replace(/[^\w-]/g, "").slice(0, 24) || "0";
    const key = `variants/${name.replace(/\.png$/i, "")}-${fit ? "fit" : "full"}-w${width}-v${version}.webp`;
    const cached = await store.getBytes(key).catch(() => null);
    if (cached) return cached;
    let source = await loadSource();
    if (!source) return null;
    if (fit) source = await fitGarmentToSquare(source);
    const bytes = await sharp(source, { failOnError: false })
      .resize({ width, height: width * 2, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80, alphaQuality: 90, effort: 4 })
      .toBuffer();
    await store.setBytes(key, bytes).catch(() => {});
    return bytes;
  }
  const outfitImageKey = (name) => `outfit-images/${name}`;
  const jobKey = (id, name = "job.json") => `jobs/${id}/${name}`;

  // Each extra wardrobe has its own model photo; the main wardrobe uses the root one
  function modelReferenceKey(wardrobeId = "user-shani") {
    return getWardrobeKeys(wardrobeId).modelReference || MODEL_REFERENCE_KEY;
  }

  async function loadModelReference(wardrobeId = "user-shani") {
    return store.getBytes(modelReferenceKey(wardrobeId));
  }

  function resolveWardrobeId(request, url) {
    const fromHeader = request?.headers ? (request.headers.get("x-wardrobe-id") || request.headers.get("x-wardrobe")) : null;
    const fromQuery = url?.searchParams ? (url.searchParams.get("wardrobeId") || url.searchParams.get("wardrobe") || url.searchParams.get("email") || url.searchParams.get("user")) : null;
    const raw = (fromHeader || fromQuery || "user-shani").toString().trim();
    if (!raw || raw === "default" || raw === "user-shani" || raw.toLowerCase() === "shaniiassulin@gmail.com") {
      return "user-shani";
    }
    const sanitized = raw.toLowerCase().replace(/@/g, "-at-").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
    return sanitized || "user-shani";
  }

  function getWardrobeKeys(wardrobeId = "user-shani") {
    if (!wardrobeId || wardrobeId === "user-shani" || wardrobeId === "default") {
      return {
        dir: null,
        importedFile: "library.json",
        suitcasesFile: "suitcases.json",
        outfitsFile: "outfits.json",
        userProfileFile: "user-profile.json",
        modelReference: null,
      };
    }
    const dir = `wardrobes/${wardrobeId}`;
    return {
      dir,
      importedFile: `${dir}/library.json`,
      suitcasesFile: `${dir}/suitcases.json`,
      outfitsFile: `${dir}/outfits.json`,
      userProfileFile: `${dir}/user-profile.json`,
      modelReference: `${dir}/model-reference.png`,
    };
  }

  async function loadOutfits(wardrobeId = "user-shani") {
    const data = await store.getJSON(getWardrobeKeys(wardrobeId).outfitsFile);
    return Array.isArray(data?.outfits) ? data.outfits : Array.isArray(data) ? data : [];
  }

  async function saveOutfits(wardrobeId = "user-shani", outfits) {
    await store.setJSON(getWardrobeKeys(wardrobeId).outfitsFile, { version: 1, outfits });
  }

  async function loadSuitcases(wardrobeId = "user-shani") {
    const data = await store.getJSON(getWardrobeKeys(wardrobeId).suitcasesFile);
    return Array.isArray(data?.suitcases) ? data.suitcases : Array.isArray(data) ? data : [];
  }

  async function saveSuitcases(wardrobeId = "user-shani", suitcases) {
    await store.setJSON(getWardrobeKeys(wardrobeId).suitcasesFile, { version: 1, suitcases });
  }

  async function loadUserProfile(wardrobeId = "user-shani") {
    const profile = await store.getJSON(getWardrobeKeys(wardrobeId).userProfileFile);
    if (profile) return profile;
    if (wardrobeId === "user-shani") {
      return {
        id: "user-shani",
        email: "shaniiassulin@gmail.com",
        name: "שני אסולין",
        avatar: null,
        createdAt: new Date().toISOString(),
        lastSync: new Date().toISOString(),
      };
    }
    return {
      id: wardrobeId,
      email: `${wardrobeId}@wardrobe.local`,
      name: `ארון ${wardrobeId}`,
      avatar: null,
      createdAt: new Date().toISOString(),
      lastSync: new Date().toISOString(),
    };
  }

  async function bodyOf(wardrobeId = "user-shani") {
    return normalizeBody((await loadUserProfile(wardrobeId).catch(() => null))?.body);
  }

  async function saveUserProfile(wardrobeId = "user-shani", profile) {
    await store.setJSON(getWardrobeKeys(wardrobeId).userProfileFile, {
      ...profile,
      lastSync: new Date().toISOString(),
    });
  }

  async function listWardrobes() {
    const list = [];
    const shaniProfile = await loadUserProfile("user-shani");
    const shaniItems = await loadImported("user-shani");
    list.push({
      id: "user-shani",
      name: shaniProfile.name || "שני אסולין",
      email: shaniProfile.email || "shaniiassulin@gmail.com",
      itemCount: shaniItems.length,
      isDefault: true,
      lastSync: shaniProfile.lastSync || null,
    });

    try {
      for (const wId of await store.listDirs("wardrobes")) {
        if (wId === "user-shani") continue;
        const prof = await loadUserProfile(wId);
        const items = await loadImported(wId);
        list.push({
          id: wId,
          name: prof.name || `ארון ${wId}`,
          email: prof.email || "",
          itemCount: items.length,
          isDefault: false,
          lastSync: prof.lastSync || null,
        });
      }
    } catch {}
    return list;
  }

  async function createOrConnectWardrobe({ email = "", name = "", id = "" }) {
    const rawEmail = (email || "").trim().toLowerCase();
    const rawId = (id || "").trim();
    const rawName = (name || "").trim();

    // Check if target is default/shani
    if (rawId === "user-shani" || rawEmail === "shaniiassulin@gmail.com") {
      const prof = await loadUserProfile("user-shani");
      if (rawName && rawName !== prof.name) {
        prof.name = rawName;
        await saveUserProfile("user-shani", prof);
      }
      return prof;
    }

    // Check if an existing wardrobe has this email
    if (rawEmail) {
      const all = await listWardrobes();
      const match = all.find((w) => w.email && w.email.toLowerCase() === rawEmail);
      if (match) {
        const prof = await loadUserProfile(match.id);
        if (rawName && prof.name !== rawName) {
          prof.name = rawName;
          await saveUserProfile(match.id, prof);
        }
        return prof;
      }
    }

    // Determine wardrobe id
    let targetId = rawId ? rawId.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase() : null;
    if (!targetId && rawEmail) {
      targetId = "wardrobe-" + rawEmail.replace(/@/g, "-at-").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
    }
    if (!targetId) {
      targetId = `wardrobe-${Date.now().toString(36)}`;
    }

    const { importedFile: libF, suitcasesFile: suitF, outfitsFile: outF } = getWardrobeKeys(targetId);

    // Initialize files if not existing
    if (!(await store.exists(libF))) await store.setJSON(libF, []);
    if (!(await store.exists(suitF))) await store.setJSON(suitF, { version: 1, suitcases: [] });
    if (!(await store.exists(outF))) await store.setJSON(outF, { version: 1, outfits: [] });

    const newProfile = {
      id: targetId,
      name: rawName || (rawEmail ? rawEmail.split("@")[0] : `ארון ${targetId}`),
      email: rawEmail || "",
      avatar: null,
      createdAt: new Date().toISOString(),
      lastSync: new Date().toISOString(),
    };
    await saveUserProfile(targetId, newProfile);
    return newProfile;
  }

  async function deleteWardrobe(wardrobeId) {
    if (!wardrobeId || wardrobeId === "user-shani" || wardrobeId === "default") {
      throw new Error("לא ניתן למחוק את ארון ברירת המחדל.");
    }
    const { dir } = getWardrobeKeys(wardrobeId);
    if (dir) await store.deletePrefix(dir);
    return true;
  }

  async function generateOutfitLook(input = {}) {
    const { name, garmentIds = [], occasion, settingDirection, notes, save = true, mode, noModel, wardrobeId = "user-shani" } = input;
    const isFlatlay = mode === "flatlay" || noModel === true;
    const styling = isFlatlay ? normalizeFlatlayStyling(input.styling) : {};

    const records = await loadImported(wardrobeId);
    const selectedGarments = [];
    const garmentImages = [];

    for (let i = 0; i < garmentIds.length; i++) {
      const id = garmentIds[i];
      const record = records.find((item) => item.id === id);
      if (!record) continue;
      selectedGarments.push(record);
      const garmentData = await requireBytes(libraryKey(`${id}-garment.png`), "Garment image not found");
      garmentImages.push({
        data: garmentData,
        mime: "image/png",
        name: `garment-${i + 1}.png`,
      });
    }

    if (!selectedGarments.length) throw new Error("אנא בחרו לפחות פריט אחד מהמלתחה ליצירת לוק.");

    const outfitName = (typeof name === "string" && name.trim()) || defaultLookName(selectedGarments, (await loadOutfits(wardrobeId)).map((o) => o.name));
    const backdrop = settingDirection || "a warm, natural daylight setting with minimalist architecture";

    let bytes;
    const garmentEntries = selectedGarments.map((g, idx) => ({
      buffer: garmentImages[idx].data,
      item: g,
    }));

    if (isFlatlay) {
      bytes = await generateFlatLayOutfit(await withOpenVersions(garmentEntries), styling, await bodyOf(wardrobeId));
    } else {
      const key = setting("OPENAI_API_KEY");
      const modelData = await loadModelReference(wardrobeId);

      if (!key || !modelData) {
        if (modelData) {
          try {
            bytes = await fitMultipleGarmentsOnModel(modelData, garmentEntries);
          } catch (_) {
            bytes = await generateFlatLayOutfit(garmentEntries);
          }
        } else {
          bytes = await generateFlatLayOutfit(garmentEntries);
        }
      } else {
        const model = { data: modelData, mime: "image/png", name: "model.png" };

        const prompt = buildLookPrompt(selectedGarments, { outfitName, backdrop, notes, body: await bodyOf(wardrobeId) });

        try {
          bytes = await openAIEdit({
            key,
            baseUrl: apiBaseUrl(),
            model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
            // Looks use medium quality: much cheaper, and still good for a lookbook
            quality: setting("OPENAI_LOOK_QUALITY", "medium"),
            size: "1024x1024",
            images: [model, ...garmentImages],
            prompt,
          });
        } catch (err) {
          if (err.accountProblem) throw Object.assign(err, { status: 402 });
          console.warn("OpenAI outfit generation error, fallback to fitting:", err.message);
        }

        if (!bytes) {
          bytes = await fitMultipleGarmentsOnModel(model.data, garmentEntries);
        }
      }
    }

    const outfitId = `outfit-${randomUUID().slice(0, 8)}`;
    const filename = `${outfitId}.png`;
    await store.setBytes(outfitImageKey(filename), bytes);

    const outfitRecord = {
      id: outfitId,
      name: outfitName,
      occasion: occasion ? (Array.isArray(occasion) ? occasion : [occasion]) : ["casual"],
      garmentIds,
      garments: selectedGarments.map((g) => ({
        id: g.id,
        name: g.name,
        part: g.part,
        thumbnail: g.thumbnail || g.image,
      })),
      notes: notes?.trim() || null,
      mode: isFlatlay ? "flatlay" : "modeled",
      styling: isFlatlay && Object.keys(styling).length ? styling : null,
      setting: backdrop,
      image: `/api/import/outfits/images/${filename}?t=${Date.now()}`,
      createdAt: new Date().toISOString(),
      wardrobeId,
    };

    if (save !== false) {
      const currentOutfits = await loadOutfits(wardrobeId);
      const updatedOutfits = [outfitRecord, ...currentOutfits.filter((o) => o.id !== outfitId)];
      await saveOutfits(wardrobeId, updatedOutfits);
    }

    return outfitRecord;
  }

  async function saveCustomOutfit(outfitData, wardrobeId = "user-shani") {
    if (!outfitData || !Array.isArray(outfitData.garmentIds) || !outfitData.garmentIds.length) {
      throw Object.assign(new Error("Please select at least one garment from your wardrobe to save an outfit"), { status: 400 });
    }
    const records = await loadImported(wardrobeId);
    const selectedGarments = outfitData.garmentIds
      .map((id) => records.find((item) => item.id === id))
      .filter(Boolean);

    const outfitId = outfitData.id || `outfit-${randomUUID().slice(0, 8)}`;
    let outfitImage = outfitData.image;
    // A photo of the look made elsewhere (e.g. in ChatGPT)
    if (typeof outfitData.uploadedImage === "string" && outfitData.uploadedImage.startsWith("data:")) {
      const bytes = await normalizeUpload({ imageDataUrl: outfitData.uploadedImage });
      const filename = `${outfitId}.png`;
      await store.setBytes(outfitImageKey(filename), bytes);
      outfitImage = `/api/import/outfits/images/${filename}?t=${Date.now()}`;
      outfitData = { ...outfitData, mode: "modeled", uploadedImage: undefined };
    }
    const styling = outfitData.mode === "flatlay" ? normalizeFlatlayStyling(outfitData.styling) : {};

    if (!outfitImage || outfitData.mode === "flatlay" || outfitImage.startsWith("data:")) {
      try {
        const garmentEntries = [];
        for (const g of selectedGarments) {
          const buffer = await store.getBytes(libraryKey(`${g.id}-garment.png`));
          if (buffer) garmentEntries.push({ buffer, item: g });
        }
        if (garmentEntries.length) {
          const bytes = await generateFlatLayOutfit(await withOpenVersions(garmentEntries), styling, await bodyOf(wardrobeId));
          const filename = `${outfitId}.png`;
          await store.setBytes(outfitImageKey(filename), bytes);
          outfitImage = `/api/import/outfits/images/${filename}?t=${Date.now()}`;
        }
      } catch (err) {
        console.warn("Could not generate flatlay outfit image:", err.message);
      }
    }
    if (!outfitImage) {
      outfitImage = selectedGarments[0]?.thumbnail || selectedGarments[0]?.image || "";
    }

    const outfitRecord = {
      id: outfitId,
      name: (typeof outfitData.name === "string" && outfitData.name.trim()) || defaultLookName(selectedGarments, (await loadOutfits(wardrobeId)).filter((o) => o.id !== outfitId).map((o) => o.name)),
      occasion: outfitData.occasion || ["casual"],
      garmentIds: outfitData.garmentIds,
      garments: selectedGarments.map((g) => ({
        id: g.id,
        name: g.name,
        part: g.part,
        thumbnail: g.thumbnail || g.image,
      })),
      notes: outfitData.notes || null,
      mode: outfitData.mode === "flatlay" ? "flatlay" : outfitData.mode === "modeled" ? "modeled" : null,
      styling: Object.keys(styling).length ? styling : null,
      setting: outfitData.setting || "Custom wardrobe outfit",
      image: outfitImage,
      createdAt: outfitData.createdAt || new Date().toISOString(),
      wardrobeId,
    };

    const currentOutfits = await loadOutfits(wardrobeId);
    const updatedOutfits = [outfitRecord, ...currentOutfits.filter((o) => o.id !== outfitId)];
    await saveOutfits(wardrobeId, updatedOutfits);
    return outfitRecord;
  }

  async function autoGenerateOutfits({ count = 1, occasion = "everyday", season = "", settingDirection = "", notes = "", wardrobeId = "user-shani" } = {}) {
    const targetCount = Math.max(1, Math.min(6, Number(count) || 1));
    const records = await loadImported(wardrobeId);
    if (!records.length) {
      throw Object.assign(new Error("Your wardrobe is empty. Please import clothing items first."), { status: 400 });
    }

    const tops = records.filter((r) => r.part === "upperbody");
    const bottoms = records.filter((r) => r.part === "lowerbody");
    const dresses = records.filter((r) => r.part === "dress" || r.part === "wholebody");
    const outers = records.filter((r) => r.part === "wholebody_up" || r.part === "outerwear" || r.part === "jacket");
    const shoes = records.filter((r) => r.part === "shoes");
    const accessories = records.filter((r) => r.part === "accessories_up" || r.part === "accessory");

    const hasBase = (tops.length > 0 && bottoms.length > 0) || dresses.length > 0 || tops.length > 0;
    if (!hasBase) {
      throw Object.assign(new Error("כדי ליצור לוקים אוטומטית צריך בארון חולצות ומכנסיים, או שמלות."), { status: 400 });
    }

    const existingOutfits = await loadOutfits(wardrobeId);
    const existingNames = existingOutfits.map((o) => o.name);
    const existingCombos = new Set(
      existingOutfits.map((o) => [...(o.garmentIds || [])].sort().join(","))
    );

    const settings = [
      "a quiet warm-stone courtyard with restrained greenery",
      "a sunlit modern European street with soft background",
      "an elegant warm-toned contemporary cafe interior",
      "a warm, natural daylight setting with minimalist architecture",
      "a contemporary clean white gallery space with soft shadows",
    ];

    const curatedCombos = [];
    const usedGarments = new Map();
    const useCount = (id) => usedGarments.get(id) || 0;
    const markUsed = (id) => usedGarments.set(id, useCount(id) + 1);

    for (let attempt = 0; attempt < 50 && curatedCombos.length < targetCount; attempt++) {
      const basePieces = [];
      const preferDress = dresses.length > 0 && (tops.length === 0 || bottoms.length === 0 || Math.random() > 0.6);

      if (preferDress) {
        const sortedDresses = [...dresses].sort((a, b) => useCount(a.id) - useCount(b.id));
        basePieces.push(sortedDresses[curatedCombos.length % sortedDresses.length]);
      } else if (tops.length > 0 && bottoms.length > 0) {
        const sortedTops = [...tops].sort((a, b) => useCount(a.id) - useCount(b.id));
        const sortedBottoms = [...bottoms].sort((a, b) => useCount(a.id) - useCount(b.id));
        basePieces.push(
          sortedTops[curatedCombos.length % sortedTops.length],
          sortedBottoms[curatedCombos.length % sortedBottoms.length]
        );
      } else if (tops.length > 0) {
        const sortedTops = [...tops].sort((a, b) => useCount(a.id) - useCount(b.id));
        basePieces.push(sortedTops[curatedCombos.length % sortedTops.length]);
      } else if (records.length > 0) {
        basePieces.push(records[curatedCombos.length % records.length]);
      }

      const combo = [...basePieces];

      // Optional outer layer
      if (outers.length > 0 && (curatedCombos.length % 2 === 1 || outers.length >= targetCount)) {
        const sortedOuters = [...outers].sort((a, b) => useCount(a.id) - useCount(b.id));
        const pickedOuter = sortedOuters[curatedCombos.length % sortedOuters.length];
        if (!combo.some((g) => g.id === pickedOuter.id)) {
          combo.push(pickedOuter);
        }
      }

      // Optional shoes
      if (shoes.length > 0) {
        const sortedShoes = [...shoes].sort((a, b) => useCount(a.id) - useCount(b.id));
        const pickedShoes = sortedShoes[curatedCombos.length % sortedShoes.length];
        if (!combo.some((g) => g.id === pickedShoes.id)) {
          combo.push(pickedShoes);
        }
      }

      // Optional accessory
      if (accessories.length > 0 && Math.random() > 0.4) {
        const sortedAcc = [...accessories].sort((a, b) => useCount(a.id) - useCount(b.id));
        const pickedAcc = sortedAcc[curatedCombos.length % sortedAcc.length];
        if (!combo.some((g) => g.id === pickedAcc.id)) {
          combo.push(pickedAcc);
        }
      }

      const comboKey = combo.map((g) => g.id).sort().join(",");
      if (!existingCombos.has(comboKey) && !curatedCombos.some((c) => c.key === comboKey)) {
        combo.forEach((g) => markUsed(g.id));
        const primary = combo[0];
        const secondary = combo[1];
        const outfitTitle = defaultLookName(combo, [...existingNames, ...curatedCombos.map((c) => c.name)]);

        curatedCombos.push({
          key: comboKey,
          name: outfitTitle,
          garmentIds: combo.map((g) => g.id),
          settingDirection: settingDirection || settings[curatedCombos.length % settings.length],
          occasion: occasion ? [occasion] : ["everyday", "smart-casual"],
        });
      }
    }

    if (!curatedCombos.length) {
      throw Object.assign(new Error("כל השילובים האפשריים מהמלתחה הנוכחית כבר נוצרו! הוסיפו עוד בגדים ליצירת לוקים חדשים."), { status: 400 });
    }

    const createdOutfits = [];
    for (const combo of curatedCombos) {
      const generated = await generateOutfitLook({
        name: combo.name,
        garmentIds: combo.garmentIds,
        occasion: combo.occasion,
        settingDirection: combo.settingDirection,
        notes: typeof notes === "string" ? notes.slice(0, 600) : "",
        save: true,
        wardrobeId,
      });
      createdOutfits.push(generated);
    }

    return createdOutfits;
  }

  async function completeOutfitWithAI({ selectedGarmentIds = [], suggestNew = false, wardrobeId = "user-shani" }) {
    const records = await loadImported(wardrobeId);
    const selectedGarments = records.filter((r) => selectedGarmentIds.includes(r.id));
    const availableGarments = records.filter((r) => !selectedGarmentIds.includes(r.id));

    if (availableGarments.length === 0) {
      return {
        recommendedGarmentIds: [],
        explanation: selectedGarments.length > 0
          ? "All your current wardrobe pieces are already selected in this outfit."
          : "Your wardrobe is empty. Add pieces first so the AI can style them.",
        suggestedNewPieces: suggestNew ? [
          "A classic tailored black blazer",
          "Straight-leg raw denim jeans",
          "Clean white leather sneakers"
        ] : [],
      };
    }

    const key = setting("OPENAI_API_KEY");
    if (key) {
      try {
        const prompt = `You are an expert personal stylist. The user is assembling an outfit from their existing personal wardrobe.
Current pieces in the outfit:
${selectedGarments.map((g) => `- ID: ${g.id} | Name: ${g.name} | Category: ${g.part} | Color: ${g.color} | Tags: ${g.tags?.join(", ") || "none"}`).join("\n") || "None selected yet"}

Available pieces in their wardrobe:
${availableGarments.map((g) => `- ID: ${g.id} | Name: ${g.name} | Category: ${g.part} | Color: ${g.color} | Tags: ${g.tags?.join(", ") || "none"}`).join("\n")}

STRICT INSTRUCTIONS:
1. Select 1 to 3 complementary pieces from the AVAILABLE wardrobe list to create a cohesive, tasteful outfit.
2. If a top is chosen and no bottom is chosen, prioritize finding a bottom (or vice versa). If a dress is chosen, do not add tops or bottoms, but consider outerwear, shoes, or accessories.
3. CRITICAL RULE: You must choose ONLY items that actually exist in the Available pieces list using their exact IDs. Never invent items or IDs.
4. ${suggestNew ? "Provide 1-2 styling ideas for new items the user could add to their closet in the future." : "Do NOT suggest any items outside the wardrobe."}

Respond in strict JSON format:
{
  "recommendedIds": ["id1", "id2"],
  "explanation": "Brief 1-2 sentence stylist explanation of why these pieces pair well together (color harmony, silhouette, balance)",
  "suggestedNewPieces": ["optional item idea 1", "optional item idea 2"]
}`;

        const res = await fetch(`${apiBaseUrl()}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${checkApiKey(key, "OpenAI")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: setting("OPENAI_VISION_MODEL", "gpt-4o-mini"),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "You are an expert personal stylist. Always output valid JSON." },
              { role: "user", content: prompt },
            ],
            temperature: 0.7,
          }),
        });

        if (res.ok) {
          const completion = await res.json();
          await recordSpend("השלמת לוק עם AI", estimateTextUsd(completion.usage), wardrobeId);
          const content = completion.choices?.[0]?.message?.content;
          if (content) {
            const parsed = JSON.parse(content);
            const validRecommendedIds = (parsed.recommendedIds || [])
              .filter((id) => availableGarments.some((g) => g.id === id));

            if (validRecommendedIds.length > 0) {
              return {
                recommendedGarmentIds: validRecommendedIds,
                explanation: parsed.explanation || "AI selected matching wardrobe pieces to complete your outfit.",
                suggestedNewPieces: suggestNew ? (parsed.suggestedNewPieces || []) : [],
              };
            }
          }
        }
      } catch (err) {
        console.warn("OpenAI outfit completion error, using stylist heuristic fallback:", err);
      }
    }

    // High quality stylist heuristic fallback
    const hasTop = selectedGarments.some((g) => g.part === "upperbody");
    const hasBottom = selectedGarments.some((g) => g.part === "lowerbody");
    const hasDress = selectedGarments.some((g) => g.part === "dress" || g.part === "wholebody");
    const hasOuter = selectedGarments.some((g) => g.part === "wholebody_up");
    const hasShoes = selectedGarments.some((g) => g.part === "shoes");
    const hasAccessory = selectedGarments.some((g) => g.part === "accessories_up");

    const recommended = [];
    const needed = [];
    if (!hasDress) {
      if (!hasBottom && hasTop) needed.push("lowerbody");
      if (!hasTop && hasBottom) needed.push("upperbody");
      if (!hasTop && !hasBottom) needed.push("upperbody", "lowerbody");
    }
    if (!hasOuter) needed.push("wholebody_up");
    if (!hasShoes) needed.push("shoes");
    if (!hasAccessory) needed.push("accessories_up");

    for (const cat of needed) {
      if (recommended.length >= 3) break;
      const match = availableGarments.find((g) => (g.part === cat || (cat === "dress" && g.part === "wholebody")) && !recommended.includes(g.id));
      if (match) recommended.push(match.id);
    }

    if (recommended.length === 0 && availableGarments.length > 0) {
      recommended.push(availableGarments[0].id);
    }

    const recommendedItems = records.filter((r) => recommended.includes(r.id));
    const explanation = recommendedItems.length > 0
      ? `ה-AI השלים את הלוק עם ${recommendedItems.map((i) => i.name).join(", ")} מהמלתחה לשילוב מאוזן ומדויק.`
      : "לא נמצאו פריטים מתאימים נוספים במלתחה.";

    return {
      recommendedGarmentIds: recommended,
      explanation,
      suggestedNewPieces: suggestNew ? [
        "A neutral trench coat or tailored jacket",
        "Clean low-profile leather sneakers",
      ] : [],
    };
  }

  async function setupStatus(wardrobeId = "user-shani") {
    const hasApiKey = Boolean(setting("OPENAI_API_KEY").trim()) || Boolean(process.env.GEMINI_API_KEY) || true;
    return {
      ready: true,
      hasApiKey,
      // Whether AI import is available; without it the app offers only the free mode
      hasOpenAIKey: Boolean(setting("OPENAI_API_KEY").trim()),
      hasModelReference: await store.exists(modelReferenceKey(wardrobeId)),
      modelReference: modelReferenceKey(wardrobeId),
    };
  }

  async function loadJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    return store.getJSON(jobKey(id));
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await store.setJSON(jobKey(job.id), job);
  }

  async function deleteJob(id) {
    await store.deletePrefix(`jobs/${id}`);
  }

  async function loadImported(wardrobeId = "user-shani") {
    return (await store.getJSON(getWardrobeKeys(wardrobeId).importedFile)) || [];
  }

  async function saveImported(wardrobeId = "user-shani", records = []) {
    await store.setJSON(getWardrobeKeys(wardrobeId).importedFile, records);
  }

  // Deleted items go to an archive (photos kept) so they can be brought back
  const archiveKey = (wardrobeId) => getWardrobeKeys(wardrobeId).importedFile.replace(/library\.json$/, "archive.json");
  const wishlistKey = (wardrobeId) => getWardrobeKeys(wardrobeId).importedFile.replace(/library\.json$/, "wishlist.json");
  const wishlistImageKey = (wardrobeId, id, variant) => getWardrobeKeys(wardrobeId).importedFile.replace(/library\.json$/, `wishlist/${id}${variant ? `-${variant}` : ""}.img`);
  async function loadWishlist(wardrobeId = "user-shani") {
    return (await store.getJSON(wishlistKey(wardrobeId)).catch(() => null)) || [];
  }
  async function saveWishlist(wardrobeId = "user-shani", records = []) {
    await store.setJSON(wishlistKey(wardrobeId), records);
  }
  async function loadArchive(wardrobeId = "user-shani") {
    return (await store.getJSON(archiveKey(wardrobeId)).catch(() => null)) || [];
  }
  async function saveArchive(wardrobeId = "user-shani", records = []) {
    await store.setJSON(archiveKey(wardrobeId), records);
  }
  async function archiveItems(wardrobeId, ids) {
    const wanted = new Set(ids);
    const records = await loadImported(wardrobeId);
    const moving = records.filter((record) => wanted.has(record.id));
    if (!moving.length) return [];
    const archivedAt = new Date().toISOString();
    for (const record of moving) {
      const pendingFile = record.pendingVersion?.file;
      if (pendingFile) await store.delete(libraryKey(pendingFile)).catch(() => {});
    }
    const archive = await loadArchive(wardrobeId);
    const moved = moving.map((record) => ({ ...record, pendingVersion: null, archivedAt }));
    await saveArchive(wardrobeId, [...moved, ...archive.filter((record) => !wanted.has(record.id))]);
    await saveImported(wardrobeId, records.filter((record) => !wanted.has(record.id)));
    return moved.map((record) => record.id);
  }
  async function restoreItems(wardrobeId, ids) {
    const wanted = new Set(ids);
    const archive = await loadArchive(wardrobeId);
    const back = archive.filter((record) => wanted.has(record.id)).map(({ archivedAt, ...record }) => record);
    if (!back.length) return [];
    const records = await loadImported(wardrobeId);
    const existing = new Set(records.map((record) => record.id));
    await saveImported(wardrobeId, [...records, ...back.filter((record) => !existing.has(record.id))]);
    await saveArchive(wardrobeId, archive.filter((record) => !wanted.has(record.id)));
    return back;
  }
  async function purgeItems(wardrobeId, ids) {
    const wanted = new Set(ids);
    const archive = await loadArchive(wardrobeId);
    const removing = archive.filter((record) => wanted.has(record.id));
    for (const { id } of removing) {
      await Promise.all(["garment", "modeled", "original", "open"].map((kind) => store.delete(libraryKey(`${id}-${kind}.png`)).catch(() => {})));
    }
    await saveArchive(wardrobeId, archive.filter((record) => !wanted.has(record.id)));
    return removing.map((record) => record.id);
  }

  async function persistImported(job, includeModeled = false) {
    const wId = job.wardrobeId || "user-shani";
    const id = `import-${job.id}`;
    const garmentName = `${id}-garment.png`;
    const originalName = `${id}-original.png`;
    const originalBytes = job.internal?.originalFile ? await store.getBytes(jobKey(job.id, job.internal.originalFile)) : null;
    if (originalBytes) await store.setBytes(libraryKey(originalName), originalBytes);
    const garmentSource = job.stages.garment.assetUrl
      ? path.basename(new URL(job.stages.garment.assetUrl, "http://localhost").pathname)
      : `garment-${job.stages.garment.attempts}.png`;
    await store.setBytes(libraryKey(garmentName), await requireBytes(jobKey(job.id, garmentSource), "Garment image not found"));
    let modeledImage = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      const modeledSource = job.stages.modeled.assetUrl
        ? path.basename(new URL(job.stages.modeled.assetUrl, "http://localhost").pathname)
        : `modeled-${job.stages.modeled.attempts}.png`;
      await store.setBytes(libraryKey(modeledName), await requireBytes(jobKey(job.id, modeledSource), "Modeled image not found"));
      modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}`;
    }
    const metadata = job.metadata || {};
    const records = await loadImported(wId);
    const existing = records.find((record) => record.id === id);
    const record = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      fit: normalizeFit(metadata.fit),
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      originalImage: originalBytes ? `${LIBRARY_ASSET_ROOT}/${originalName}` : existing?.originalImage || null,
      // How the catalog photo was made: low / medium / high quality, or free
      catalogQuality: job.mode === "free"
        ? job.mode
        : job.stages.garment.quality || (job.mode === "catalog" ? setting("OPENAI_CATALOG_QUALITY", "low") : setting("OPENAI_IMAGE_QUALITY", "high")),
      importJobId: job.id,
      wardrobeId: wId,
    };
    const next = [...records.filter((item) => item.id !== id), record];
    await saveImported(wId, next);
    return record;
  }

  // Schedules a stage generation. If the background worker cannot be started the
  // stage is marked failed so the UI offers a retry instead of waiting forever.
  async function startStage(jobId, stageName) {
    try {
      await defer({ type: "stage", jobId, stageName });
    } catch (error) {
      console.error("Could not start background generation:", error);
      const fresh = await loadJob(jobId);
      if (!fresh) return;
      fresh.stages[stageName].status = "failed";
      fresh.stages[stageName].error = "לא ניתן היה להתחיל את העיבוד ברקע. נסו שוב.";
      fresh.stages[stageName].updatedAt = new Date().toISOString();
      await saveJob(fresh);
    }
  }

  async function generate(job, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const current = await loadJob(job.id);
      if (!current) return;
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current);
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      try {
        const outputName = `${stageName}-${stage.attempts}.png`;
        const key = setting("OPENAI_API_KEY");
        // The full original photo is sent, not the detected crop: the vision model names
        // garments well but its boxes are often off, which produced crops of the wrong area.
        // The prompt names the exact garment to extract and to drop everything else.
        const sourceFile = current.internal.originalFile;
        const original = { data: await requireBytes(jobKey(current.id, sourceFile), "Source image not found"), mime: "image/png", name: sourceFile };
        let bytes;
        if (stageName === "garment") {
          chromaKeyUsed = chooseChromaKey(current.metadata.color);
          // Catalog imports start cheap; the user can redo a bad one at medium quality
          const garmentQuality = current.stages.garment.quality || (current.mode === "catalog"
            ? setting("OPENAI_CATALOG_QUALITY", "low")
            : setting("OPENAI_IMAGE_QUALITY", "high"));
          const basePrompt = buildGarmentPrompt(current.metadata, chromaKeyUsed);
          if (key) {
            bytes = await openAIEdit({
              key,
              baseUrl: apiBaseUrl(),
              model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
              quality: garmentQuality,
              size: "1024x1024",
              images: [original],
              prompt: current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt,
            });
            const rawName = `${stageName}-${stage.attempts}-source.png`;
            await store.setBytes(jobKey(current.id, rawName), bytes);
            failedAssetUrl = `${ASSET_ROOT}/${current.id}/${rawName}`;
            try {
              bytes = await removeChromaBackground(bytes, chromaKeyUsed, { tolerance: 48 });
            } catch (chromaErr) {
              console.warn("Chroma removal warning, attempting higher tolerance:", chromaErr.message);
              const fallbackProcessed = await processChromaBackground(bytes, chromaKeyUsed, { tolerance: 58 });
              bytes = fallbackProcessed.bytes;
            }
          } else {
            // When no OpenAI key is set: frame transparent cutout cleanly with sharp
            bytes = await frameTransparentGarment(original.data, 1024, 0.88);
          }
        } else {
          const garmentName = current.stages.garment.assetUrl
            ? path.basename(new URL(current.stages.garment.assetUrl, "http://localhost").pathname)
            : `garment-${current.stages.garment.attempts}.png`;
          const garment = { data: await requireBytes(jobKey(current.id, garmentName), "Garment image not found"), mime: "image/png", name: "garment.png" };
          const modelData = await loadModelReference(current.wardrobeId);
          if (!modelData) {
            const fresh = await loadJob(current.id);
            fresh.stages.modeled.status = "skipped";
            fresh.status = "complete";
            await saveJob(fresh);
            return;
          }
          const model = { data: modelData, mime: "image/png", name: "model.png" };
          const garmentColour = current.metadata?.color ? ` The garment colour must stay exactly ${current.metadata.color}${current.metadata.secondaryColor ? ` with ${current.metadata.secondaryColor}` : ""}; do not recolour, tint, or restyle it.` : "";
          const basePrompt = `Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail.${garmentColour} Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.`;
          if (key) {
            try {
              bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_MODELED_QUALITY", "medium"), size: "1536x1024", images: [model, garment], prompt: current.stages.modeled.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.modeled.prompt}` : basePrompt });
            } catch (modelError) {
              // Fail visibly so the user knows to fix their OpenAI account
              if (modelError.accountProblem) throw modelError;
              console.warn("Modeled image generation fallback:", modelError.message);
              bytes = await fitItemOnModel(model.data, garment.data, {
                name: current.metadata?.name,
                part: current.metadata?.part,
              });
            }
          } else {
            bytes = await fitItemOnModel(model.data, garment.data, {
              name: current.metadata?.name,
              part: current.metadata?.part,
            });
          }
        }
        await store.setBytes(jobKey(current.id, outputName), bytes);
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "review";
        fresh.stages[stageName].assetUrl = `${ASSET_ROOT}/${fresh.id}/${outputName}`;
        fresh.stages[stageName].failedAssetUrl = null;
        fresh.stages[stageName].cleanupPreviewUrl = null;
        fresh.stages[stageName].cleanupDiagnostics = null;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        fresh.stages[stageName].updatedAt = new Date().toISOString();
        await saveJob(fresh);
      } catch (error) {
        const fresh = await loadJob(current.id);
        if (!fresh) return;
        fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
        if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        await saveJob(fresh);
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  // Re-dresses every wardrobe item on a newly uploaded model reference.
  async function refitModeledPhotos(wardrobeId) {
    const modelData = await loadModelReference(wardrobeId);
    if (!modelData) return;
    const records = await loadImported(wardrobeId);
    let changed = false;
    for (const item of records) {
      try {
        const garmentBuf = await store.getBytes(libraryKey(`${item.id}-garment.png`));
        if (!garmentBuf) continue;
        const modeledBuf = await fitItemOnModel(modelData, garmentBuf, item);
        await store.setBytes(libraryKey(`${item.id}-modeled.png`), modeledBuf);
        item.modeledImage = `${LIBRARY_ASSET_ROOT}/${item.id}-modeled.png?t=${Date.now()}`;
        changed = true;
      } catch (_) {}
    }
    if (changed) await saveImported(wardrobeId, records);
  }

  function isLongRequest(request) {
    const { pathname } = new URL(request.url);
    return LONG_ROUTES.some((route) => route.method === request.method && route.pattern.test(pathname));
  }

  // Stores the request and hands it to the background worker. The client polls
  // GET /api/import/tasks/:id and receives the original response once it is ready.
  async function enqueueRequest(request) {
    const id = randomUUID();
    const headers = {};
    for (const name of ["content-type", "x-wardrobe-id", "x-wardrobe"]) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    await store.setJSON(`tasks/${id}.json`, {
      id,
      status: "queued",
      createdAt: new Date().toISOString(),
      request: { method: request.method, url: request.url, headers, body: await request.text() },
    });
    try {
      await defer({ type: "request", taskId: id });
    } catch (error) {
      await store.delete(`tasks/${id}.json`);
      return json(503, { error: "לא ניתן היה להתחיל את העיבוד ברקע. נסו שוב בעוד רגע." });
    }
    return json(202, { taskId: id, status: "queued" }, { "x-task-id": id });
  }

  async function runRequestTask(taskId) {
    const key = `tasks/${taskId}.json`;
    const task = await store.getJSON(key);
    if (!task || task.status === "done") return;
    await store.setJSON(key, { ...task, status: "running" });
    let response;
    try {
      const { method, url, headers, body: requestBody } = task.request;
      response = await handle(new Request(url, { method, headers, body: requestBody || undefined }));
    } catch (error) {
      response = json(500, { error: error.message || "Internal server error" });
    }
    const text = response ? await response.text() : JSON.stringify({ error: "Not found" });
    await store.setJSON(key, {
      id: taskId,
      status: "done",
      finishedAt: new Date().toISOString(),
      response: {
        status: response?.status || 404,
        contentType: response?.headers.get("content-type") || "application/json; charset=utf-8",
        body: text,
      },
    });
  }

  async function runDeferred(task) {
    await loadSettings();
    if (task?.type === "stage") {
      const job = await loadJob(task.jobId);
      if (job && STAGES.has(task.stageName)) await generate(job, task.stageName);
    } else if (task?.type === "refit") {
      await refitModeledPhotos(task.wardrobeId || "user-shani");
    } else if (task?.type === "request") {
      await runRequestTask(task.taskId);
    }
  }

  // Restarts generation for jobs that were interrupted (local server restarts).
  async function resumeJobs() {
    await loadSettings();
    for (const id of await store.listDirs("jobs")) {
      const job = await loadJob(id);
      if (!job) continue;
      if (job.status === "complete") {
        try {
          await persistImported(job, true);
          await deleteJob(job.id);
        } catch (error) {
          job.status = "active";
          job.stages.modeled.status = "review";
          job.stages.modeled.decision = null;
          job.stages.modeled.error = null;
          await saveJob(job);
        }
        continue;
      }
      if (job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected") {
        await deleteJob(job.id);
        continue;
      }
      if (job.stages.crop && job.stages.crop.status !== "approved") continue;
      if (["processing", "queued"].includes(job.stages.garment.status)) {
        job.stages.garment.status = "pending";
        await saveJob(job);
        await startStage(job.id, "garment");
      } else if (job.stages.garment.status === "approved" && ["pending", "processing", "queued"].includes(job.stages.modeled.status)) {
        job.stages.modeled.status = "pending";
        await saveJob(job);
        await startStage(job.id, "modeled");
      }
    }
  }

  // Rewrites English tags in a wardrobe as Hebrew. Known words come from the
  // dictionary; anything else is translated by the text model when a key is set.
  async function translateWardrobeTags(wardrobeId) {
    const records = await loadImported(wardrobeId);
    const english = [...new Set(records.flatMap((record) => (record.tags || []).filter(hasLatin).map((tag) => tag.trim().toLowerCase())))];
    if (!english.length) return { translated: 0, remaining: 0 };
    const map = new Map(english.filter((tag) => TAG_TRANSLATIONS[tag]).map((tag) => [tag, TAG_TRANSLATIONS[tag]]));
    const unknown = english.filter((tag) => !map.has(tag));
    const key = setting("OPENAI_API_KEY");
    if (unknown.length && key) {
      try {
        const res = await fetch(`${apiBaseUrl()}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${checkApiKey(key, "OpenAI")}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: setting("OPENAI_VISION_MODEL", "gpt-4o-mini"),
            response_format: { type: "json_object" },
            temperature: 0,
            messages: [
              { role: "system", content: "You translate short clothing tags from English to natural, short Hebrew as used in fashion stores. Reply with JSON only." },
              { role: "user", content: `Translate each tag to Hebrew. Return {"translations": {"<english tag>": "<hebrew tag>"}}. Tags: ${JSON.stringify(unknown)}` },
            ],
          }),
        });
        const completion = await res.json();
        if (res.ok) await recordSpend("תרגום תגיות", estimateTextUsd(completion?.usage), wardrobeId);
        const content = completion?.choices?.[0]?.message?.content;
        const translations = JSON.parse(content || "{}").translations || {};
        for (const [tag, hebrew] of Object.entries(translations)) {
          if (typeof hebrew === "string" && hebrew.trim() && unknown.includes(tag.toLowerCase())) map.set(tag.toLowerCase(), hebrew.trim().slice(0, 40));
        }
      } catch (error) {
        console.warn("Tag translation failed:", error.message);
      }
    }
    if (!map.size) return { translated: 0, remaining: english.length };
    // Re-read so edits made meanwhile are kept
    const latest = await loadImported(wardrobeId);
    let changed = 0;
    for (const record of latest) {
      const tags = (record.tags || []).map((tag) => map.get(tag.trim().toLowerCase()) || tag);
      const unique = [...new Set(tags)];
      if (JSON.stringify(unique) !== JSON.stringify(record.tags || [])) { record.tags = unique; changed += 1; }
    }
    if (changed) await saveImported(wardrobeId, latest);
    return { translated: map.size, remaining: english.length - map.size, itemsChanged: changed };
  }

  async function handle(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/import/")) return null;
    await loadSettings();
    try {
      const taskMatch = url.pathname.match(/^\/api\/import\/tasks\/([a-f0-9-]{36})$/i);
      if (taskMatch && request.method === "GET") {
        const key = `tasks/${taskMatch[1]}.json`;
        const task = await store.getJSON(key);
        if (!task) return json(404, { error: "Task not found" });
        if (task.status !== "done") return json(200, { status: task.status });
        await store.delete(key);
        return json(200, { status: "done", response: task.response });
      }
      if (url.pathname === "/api/import/tags/translate" && request.method === "POST") {
        return json(200, await translateWardrobeTags(resolveWardrobeId(request, url)));
      }
      if (url.pathname === "/api/import/wardrobes" && request.method === "GET") {
        return json(200, await listWardrobes());
      }
      if (url.pathname === "/api/import/wardrobes" && request.method === "POST") {
        const input = await body(request);
        const profile = await createOrConnectWardrobe(input);
        return json(200, { success: true, wardrobe: profile });
      }
      const wardrobeManageDeleteMatch = url.pathname.match(/^\/api\/import\/wardrobes\/([\w-]+)$/i);
      if (wardrobeManageDeleteMatch && request.method === "DELETE") {
        const targetId = wardrobeManageDeleteMatch[1];
        try {
          await deleteWardrobe(targetId);
          return json(200, { deleted: true, id: targetId });
        } catch (err) {
          return json(400, { error: err.message });
        }
      }
      if (url.pathname === "/api/import/wardrobe" && request.method === "GET") {
        const wId = resolveWardrobeId(request, url);
        return json(200, await loadImported(wId));
      }
      if (url.pathname === "/api/import/config" && request.method === "GET") {
        const wId = resolveWardrobeId(request, url);
        return json(200, await setupStatus(wId));
      }
      if (url.pathname === "/api/import/model-reference" && request.method === "POST") {
        const wId = resolveWardrobeId(request, url);
        try {
          const input = await body(request, 50 * 1024 * 1024);
          const image = decodeImage(input);
          const normalized = await normalizeImage(image.data);
          await store.setBytes(modelReferenceKey(wId), normalized);

          const status = await setupStatus(wId);
          // Re-dress existing items on the new photo without blocking the response
          await defer({ type: "refit", wardrobeId: wId }).catch((updateErr) => {
            console.warn("Could not batch update modeled photos:", updateErr.message);
          });
          return json(200, { success: true, ...status, wardrobeId: wId });
        } catch (uploadErr) {
          console.error("Model reference upload failed:", uploadErr);
          return json(400, { error: uploadErr.message || "שגיאה בעיבוד תמונת המודל" });
        }
      }
      if (url.pathname === "/api/import/model-reference" && (request.method === "GET" || request.method === "HEAD")) {
        const wId = resolveWardrobeId(request, url);
        const data = await loadModelReference(wId);
        if (!data) return json(404, { error: "No model reference photo found" });
        return imageResponse(data, { cache: "no-store", head: request.method === "HEAD" });
      }
      const idList = (input) => (Array.isArray(input?.ids) ? input.ids : []).filter((id) => typeof id === "string" && /^[\w-]{1,80}$/.test(id)).slice(0, 500);
      if (url.pathname === "/api/import/archive" && request.method === "GET") {
        return json(200, await loadArchive(resolveWardrobeId(request, url)));
      }
      if (url.pathname === "/api/import/wardrobe/archive" && request.method === "POST") {
        const ids = idList(await body(request));
        return json(200, { archived: await archiveItems(resolveWardrobeId(request, url), ids) });
      }
      if (url.pathname === "/api/import/archive/restore" && request.method === "POST") {
        const ids = idList(await body(request));
        return json(200, { restored: await restoreItems(resolveWardrobeId(request, url), ids) });
      }
      if (url.pathname === "/api/import/archive/purge" && request.method === "POST") {
        const ids = idList(await body(request));
        return json(200, { deleted: await purgeItems(resolveWardrobeId(request, url), ids) });
      }
      const wardrobeDeleteMatch = url.pathname.match(/^\/api\/import\/wardrobe\/([\w-]+)$/i);
      if (wardrobeDeleteMatch && request.method === "DELETE") {
        // Deleting moves the item to the archive
        const id = wardrobeDeleteMatch[1];
        const moved = await archiveItems(resolveWardrobeId(request, url), [id]);
        if (!moved.length) return json(404, { error: "Wardrobe item not found" });
        return json(200, { deleted: true, archived: true, id });
      }
      const wardrobeUpdateMatch = url.pathname.match(/^\/api\/import\/wardrobe\/([\w-]+)$/i);
      if (wardrobeUpdateMatch && (request.method === "PUT" || request.method === "PATCH")) {
        const id = wardrobeUpdateMatch[1];
        const wId = resolveWardrobeId(request, url);
        const input = await body(request);
        const records = await loadImported(wId);
        const index = records.findIndex((record) => record.id === id);
        if (index === -1) return json(404, { error: "Wardrobe item not found" });
        records[index] = {
          ...records[index],
          ...input,
          ...(input.fit !== undefined ? { fit: normalizeFit(input.fit) } : {}),
          id,
          updatedAt: new Date().toISOString(),
        };
        await saveImported(wId, records);
        return json(200, records[index]);
      }
      const wardrobeRegenerateMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/regenerate$/i);
      if (wardrobeRegenerateMatch && request.method === "POST") {
        // Creates a new version for the user to compare; the current photo is kept
        const id = wardrobeRegenerateMatch[1];
        const wId = resolveWardrobeId(request, url);
        const input = await body(request);
        const records = await loadImported(wId);
        const record = records.find((item) => item.id === id);
        if (!record) return json(404, { error: "Wardrobe item not found" });
        const key = setting("OPENAI_API_KEY");
        if (!key) return json(400, { error: "צריך מפתח של OpenAI כדי לעבד מחדש." });
        // Prefer the original upload; older items only have the catalog photo, shown on white
        const original = await store.getBytes(libraryKey(`${id}-original.png`));
        const garment = original ? null : await store.getBytes(libraryKey(`${id}-garment.png`));
        if (!original && !garment) return json(404, { error: "לא נמצאה תמונה של הפריט." });
        const source = original || await sharp(garment).flatten({ background: "#ffffff" }).png().toBuffer();
        const quality = ["low", "medium"].includes(input.quality) ? input.quality : "low";
        const chromaKey = chooseChromaKey(record.color);
        const direction = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) : "";
        const fromCutout = original ? "" : "\nReference note: the input is an existing product cutout of this garment on white. Recreate it faithfully as a cleaner catalog photo, changing only what the user direction asks.";
        const basePrompt = buildGarmentPrompt(record, chromaKey) + fromCutout;
        let bytes;
        try {
          bytes = await openAIEdit({
            key,
            baseUrl: apiBaseUrl(),
            model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
            quality,
            size: "1024x1024",
            images: [{ data: source, mime: "image/png", name: "source.png" }],
            prompt: direction ? `${basePrompt}\nUser regeneration direction: ${direction}` : basePrompt,
          });
        } catch (error) {
          return json(error.accountProblem ? 402 : 502, { error: error.message });
        }
        try {
          bytes = await removeChromaBackground(bytes, chromaKey, { tolerance: 48 });
        } catch {
          bytes = (await processChromaBackground(bytes, chromaKey, { tolerance: 58 })).bytes;
        }
        const stamp = Date.now();
        const candidateName = `${id}-candidate-${stamp}.png`;
        await store.setBytes(libraryKey(candidateName), bytes);
        // Re-read so edits made while the image was generating are kept
        const latest = await loadImported(wId);
        const latestRecord = latest.find((item) => item.id === id);
        if (!latestRecord) return json(404, { error: "Wardrobe item not found" });
        const previous = latestRecord.pendingVersion?.file;
        if (previous) await store.delete(libraryKey(previous)).catch(() => {});
        latestRecord.pendingVersion = {
          file: candidateName,
          image: `${LIBRARY_ASSET_ROOT}/${candidateName}`,
          quality,
          fromOriginal: Boolean(original),
          note: direction || null,
          createdAt: new Date(stamp).toISOString(),
        };
        await saveImported(wId, latest);
        return json(200, latestRecord);
      }
      if (url.pathname === "/api/import/billing" && request.method === "GET") {
        return json(200, await billingSummary());
      }
      if (url.pathname === "/api/import/billing/balance" && request.method === "POST") {
        const input = await body(request);
        if (input.balanceUsd === null) {
          await store.delete(BALANCE_KEY).catch(() => {});
          return json(200, await billingSummary());
        }
        const balanceUsd = Number(input.balanceUsd);
        if (!Number.isFinite(balanceUsd) || balanceUsd < 0 || balanceUsd > 100000) return json(400, { error: "יש להזין סכום תקין בדולרים." });
        const log = (await store.getJSON(SPEND_KEY).catch(() => null)) || {};
        await store.setJSON(BALANCE_KEY, { balanceUsd, setAt: new Date().toISOString(), spentAtSet: log.totalUsd || 0 });
        return json(200, await billingSummary());
      }
      // ChatGPT route: the written request to copy, and photos made there to upload
      const modeledPromptMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/prompt$/i);
      if (modeledPromptMatch && request.method === "GET") {
        const record = (await loadImported(resolveWardrobeId(request, url))).find((item) => item.id === modeledPromptMatch[1]);
        if (!record) return json(404, { error: "Wardrobe item not found" });
        return json(200, { prompt: buildModeledPrompt(record, String(url.searchParams.get("note") || "").slice(0, 600), await bodyOf(resolveWardrobeId(request, url))) });
      }
      const modeledUploadMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/modeled-upload$/i);
      if (modeledUploadMatch && request.method === "POST") {
        const id = modeledUploadMatch[1];
        const wId = resolveWardrobeId(request, url);
        const bytes = await normalizeUpload(await body(request));
        const records = await loadImported(wId);
        const record = records.find((item) => item.id === id);
        if (!record) return json(404, { error: "Wardrobe item not found" });
        await store.setBytes(libraryKey(`${id}-modeled.png`), bytes);
        record.modeledImage = `${LIBRARY_ASSET_ROOT}/${id}-modeled.png?t=${Date.now()}`;
        await saveImported(wId, records);
        return json(200, record);
      }
      // Wishlist: pieces she does not have yet, saved from an inspiration photo. Saving
      // is free: the piece is cut out of the photo (no AI) and the whole photo is kept
      // too. A clean catalog photo can be made later with AI, on request.
      if (url.pathname === "/api/import/wishlist" && request.method === "GET") {
        return json(200, await loadWishlist(resolveWardrobeId(request, url)));
      }
      if (url.pathname === "/api/import/wishlist" && request.method === "POST") {
        const wId = resolveWardrobeId(request, url);
        const input = await body(request);
        const name = String(input.name || "").trim().slice(0, 60);
        if (!name) return json(400, { error: "חסר שם לפריט." });
        const id = randomUUID();
        const color = /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color : null;
        const colorName = String(input.colorName || "").trim().slice(0, 40);
        const description = String(input.description || "").trim().slice(0, 300);
        let hasImage = false;
        let hasPhoto = false;
        if (input.imageDataUrl) {
          try {
            const photo = await sharp(decodeImage(input).data, { failOnError: false }).rotate().flatten({ background: "#ffffff" }).toBuffer();
            const meta = await sharp(photo).metadata();
            // The whole inspiration photo, to go back to
            await store.setBytes(wishlistImageKey(wId, id, "photo"), await sharp(photo).resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer());
            hasPhoto = true;
            let crop = sharp(photo);
            const box = input.box;
            if (box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0) {
              // The AI's box is rough, so leave a margin around it
              const pad = 0.12;
              const x0 = Math.max(0, (box.x / 1000 - (box.width / 1000) * pad) * meta.width);
              const y0 = Math.max(0, (box.y / 1000 - (box.height / 1000) * pad) * meta.height);
              const x1 = Math.min(meta.width, ((box.x + box.width) / 1000 + (box.width / 1000) * pad) * meta.width);
              const y1 = Math.min(meta.height, ((box.y + box.height) / 1000 + (box.height / 1000) * pad) * meta.height);
              if (x1 - x0 > 24 && y1 - y0 > 24) crop = sharp(photo).extract({ left: Math.round(x0), top: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) });
            }
            // Full resolution of the original, high quality
            await store.setBytes(wishlistImageKey(wId, id), await crop.jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toBuffer());
            hasImage = true;
          } catch {}
        }
        const q = `?wardrobeId=${encodeURIComponent(wId)}`;
        const record = {
          id,
          name,
          part: String(input.part || "").slice(0, 20),
          color,
          colorName,
          description,
          note: String(input.note || "").trim().slice(0, 160),
          image: hasImage ? `/api/import/wishlist/${id}/image${q}` : null,
          photo: hasPhoto ? `/api/import/wishlist/${id}/photo${q}` : null,
          aiImage: null,
          createdAt: new Date().toISOString(),
        };
        const list = await loadWishlist(wId);
        await saveWishlist(wId, [record, ...list]);
        return json(200, record);
      }
      if (url.pathname === "/api/import/wishlist/analyze" && request.method === "POST") {
        // A screenshot or photo of pieces she wants: name, exact color and description
        // of each, and where it is in the picture (to cut it out). Nothing is saved here.
        const wId = resolveWardrobeId(request, url);
        const key = setting("OPENAI_API_KEY");
        if (!key) return json(400, { error: "צריך מפתח של OpenAI כדי לזהות את הפריטים." });
        const input = await body(request);
        const photo = await sharp(decodeImage(input).data, { failOnError: false }).rotate()
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
        const prompt = `The image is a photo or a screenshot (for example from a shop or Pinterest) of clothing, shoes or accessories the user wants to buy. List every distinct wearable piece that is a main subject of the image (at most 6; ignore tiny background items, the person's body, and interface elements like buttons or text). For each write:
- "name": a short Hebrew name (e.g. "חולצה לבנה מכופתרת", "משקפי שמש חומים")
- "part": a category id: upperbody = tops and shirts, wholebody_up = jackets and coats, lowerbody = trousers, skirts and shorts, dress, shoes, accessories_up = bags, belts, jewellery, hats, sunglasses
- "colorName": the exact Hebrew color name, as specific as possible (e.g. "חום קרמל", "בז' חולי", "כחול נייבי"), and "color": the hex color matching it exactly
- "description": an exact Hebrew description, 12-25 words: type, cut and fit, length, material and texture, neckline/collar, sleeves, closures, pattern and distinctive details
- "box": the piece's position as integers on a 1000 by 1000 grid (x, y of the top-left corner, width, height), tight around the piece`;
        const res = await fetch(`${apiBaseUrl()}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${checkApiKey(key, "OpenAI")}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: setting("OPENAI_VISION_MODEL", "gpt-4o-mini"),
            temperature: 0.2,
            messages: [{ role: "user", content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${photo.toString("base64")}`, detail: "high" } },
            ] }],
            response_format: { type: "json_schema", json_schema: { name: "wishlist_pieces", strict: true, schema: {
              type: "object", additionalProperties: false, required: ["pieces"],
              properties: { pieces: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "part", "color", "colorName", "description", "box"], properties: {
                name: { type: "string" },
                part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "dress", "shoes", "accessories_up"] },
                color: { type: "string" },
                colorName: { type: "string" },
                description: { type: "string" },
                box: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } } },
              } } } },
            } } },
          }),
        });
        const completion = await res.json().catch(() => ({}));
        if (!res.ok) throw openAIError(res.status, completion, "לא ניתן לזהות את הפריטים כרגע");
        await recordSpend("זיהוי פריטים ל-Wishlist", estimateTextUsd(completion.usage), wId);
        let parsed;
        try { parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}"); } catch { parsed = {}; }
        const pieces = (Array.isArray(parsed.pieces) ? parsed.pieces : []).slice(0, 6).map((piece) => ({
          name: String(piece.name || "").slice(0, 60),
          part: piece.part,
          color: /^#[0-9a-f]{6}$/i.test(piece.color) ? piece.color : null,
          colorName: String(piece.colorName || "").slice(0, 40),
          description: String(piece.description || "").slice(0, 300),
          box: piece.box && [piece.box.x, piece.box.y, piece.box.width, piece.box.height].every(Number.isFinite) ? piece.box : null,
        })).filter((piece) => piece.name);
        return json(200, { pieces });
      }
      const wishMatch = url.pathname.match(/^\/api\/import\/wishlist\/([a-f0-9-]{36})(?:\/(image|photo|ai|generate))?$/i);
      if (wishMatch) {
        const wId = resolveWardrobeId(request, url);
        const [, wishId, wishPart] = wishMatch;
        if (["image", "photo", "ai"].includes(wishPart) && (request.method === "GET" || request.method === "HEAD")) {
          const variant = wishPart === "image" ? undefined : wishPart;
          // (items saved earlier were kept as .jpg)
          const bytes = (await store.getBytes(wishlistImageKey(wId, wishId, variant)))
            || (!variant ? await store.getBytes(wishlistImageKey(wId, wishId).replace(/\.img$/, ".jpg")) : null);
          if (!bytes) return json(404, { error: "Not found" });
          return imageResponse(bytes, { contentType: bytes[0] === 0x89 ? "image/png" : "image/jpeg", cache: variant === "ai" ? "private, max-age=60" : undefined, head: request.method === "HEAD" });
        }
        if (wishPart === "generate" && request.method === "POST") {
          // A clean catalog photo of the piece, made from the cut-out, like a wardrobe photo
          const key = setting("OPENAI_API_KEY");
          if (!key) return json(400, { error: "צריך מפתח של OpenAI כדי להכין תמונה." });
          const list = await loadWishlist(wId);
          const record = list.find((entry) => entry.id === wishId);
          if (!record) return json(404, { error: "הפריט לא נמצא ב-Wishlist." });
          const input = await body(request);
          const quality = input.quality === "medium" ? "medium" : "low";
          const source = (input.source === "photo" ? await store.getBytes(wishlistImageKey(wId, wishId, "photo")) : null)
            || (await store.getBytes(wishlistImageKey(wId, wishId)))
            || (await store.getBytes(wishlistImageKey(wId, wishId).replace(/\.img$/, ".jpg")))
            || (await store.getBytes(wishlistImageKey(wId, wishId, "photo")));
          if (!source) return json(404, { error: "אין תמונה לפריט הזה." });
          const chromaKey = chooseChromaKey(record.color || "#808080");
          const prompt = buildGarmentPrompt({ name: record.name, part: record.part, color: record.color || undefined, tags: [record.colorName, record.description].filter(Boolean) }, chromaKey)
            + (record.description ? `\nExact description of the piece: ${record.description}` : "")
            + (record.colorName ? `\nExact color: ${record.colorName} (${record.color || "as in the photo"}). Match this color precisely.` : "");
          const generated = await openAIEdit({
            key,
            baseUrl: apiBaseUrl(),
            model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
            quality,
            size: "1024x1024",
            images: [{ data: await sharp(source).png().toBuffer(), mime: "image/png", name: "piece.png" }],
            prompt,
            action: "תמונת AI לפריט ב-Wishlist",
            wardrobeId: wId,
          });
          let clean;
          try { clean = await removeChromaBackground(generated, chromaKey, { tolerance: 48 }); } catch { clean = (await processChromaBackground(generated, chromaKey, { tolerance: 58 })).bytes; }
          await store.setBytes(wishlistImageKey(wId, wishId, "ai"), await sharp(clean).png().toBuffer());
          record.aiImage = `/api/import/wishlist/${wishId}/ai?wardrobeId=${encodeURIComponent(wId)}&t=${Date.now()}`;
          record.aiQuality = quality;
          await saveWishlist(wId, list);
          return json(200, record);
        }
        if (!wishPart && request.method === "DELETE") {
          const list = await loadWishlist(wId);
          await saveWishlist(wId, list.filter((entry) => entry.id !== wishId));
          for (const variant of [undefined, "photo", "ai"]) await store.delete(wishlistImageKey(wId, wishId, variant)).catch(() => {});
          await store.delete(wishlistImageKey(wId, wishId).replace(/\.img$/, ".jpg")).catch(() => {});
          return json(200, { deleted: true });
        }
      }
      if (url.pathname === "/api/import/inspiration" && request.method === "POST") {
        // An inspiration photo (Pinterest, a screenshot...): the AI names each piece
        // in it and picks the closest pieces from the wardrobe. One cheap text+image call.
        const wId = resolveWardrobeId(request, url);
        const key = setting("OPENAI_API_KEY");
        if (!key) return json(400, { error: "צריך מפתח של OpenAI כדי לנתח תמונת השראה." });
        const input = await body(request);
        const image = decodeImage(input);
        const photo = await sharp(image.data, { failOnError: false }).rotate()
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
        const records = await loadImported(wId);
        if (!records.length) return json(400, { error: "הארון ריק. הוסיפי בגדים כדי לקבל התאמות." });
        const list = records.map((g) => `- id: ${g.id} | ${g.name} | category: ${g.part} | color: ${g.color}${colorFamily(g.color) ? ` (${colorFamily(g.color)})` : ""}${g.secondaryColor ? ` + ${g.secondaryColor}` : ""} | tags: ${(g.tags || []).join(", ") || "none"}${g.fit?.length ? ` | length: ${g.fit.length}` : ""}${g.fit?.oversize ? " | oversize" : ""}`).join("\n");
        const prompt = `You are a personal stylist. The photo is an outfit the user wants to recreate from her own wardrobe.
1. List every visible garment, shoe and accessory in the photo (at most 8), from top to bottom. For each, write a short Hebrew name (e.g. "חולצה לבנה מכופתרת", "ג'ינס רחב בהיר"), a category id (upperbody = tops and shirts, wholebody_up = jackets and coats, lowerbody = trousers, skirts and shorts, dress, shoes, accessories_up = bags, belts, jewellery, hats, sunglasses), its kind in one English word (e.g. shirt, tshirt, sweater, blazer, coat, jeans, trousers, skirt, shorts, dress, sneakers, boots, heels, sandals, bag, belt, sunglasses, hat, necklace, earrings, watch, scarf), and its main hex color.
2. For each piece, write "kindName": the kind of item in Hebrew plural, without color (e.g. "משקפי שמש", "סוודרים", "ג'ינסים", "תיקים", "מגפיים").
3. In "sameKind", list EVERY item from the wardrobe below that is the same kind of item as the piece, in any color (all the sunglasses for sunglasses, all the bags for a bag, all trousers and jeans for trousers, all tops for a top of that kind). Never list an item of a different kind. For each, set "similar" to true if it could stand in for the piece in this look (a close color and a similar style; several items can be similar, e.g. every white shirt for a white shirt), otherwise false, and give a very short Hebrew reason (up to 8 words), e.g. "אותו צבע, גזרה קצת שונה" or "אותו סוג, צבע שחור במקום חום". Best first. Use only ids from the list, exactly as written. Return an empty list if the wardrobe has nothing of that kind.
3b. Only when "sameKind" is empty: in "alternatives", list the items from the same category id that would suit this look best, best first, each with a short Hebrew reason. Otherwise return an empty list.
3c. For every piece write "description": an exact Hebrew description of the piece as seen in the photo, 12-25 words: type, cut and fit, length, material and texture, neckline/collar, sleeves, closures, pattern and any distinctive details. Write "colorName": the exact Hebrew color name, as specific as possible (e.g. "חום קרמל", "בז' חולי", "כחול נייבי", "לבן שבור"), and make the hex color match it exactly. Write "search": a short Hebrew phrase naming the piece (e.g. "מכנסי פשתן בז' רחבים לנשים"), and "box": the piece's position in the photo as integers on a 1000 by 1000 grid (x, y of the top-left corner, width, height).
4. Write "summary": one Hebrew sentence describing the look's style. Write "tip" as an empty string.

Wardrobe:
${list}`;
        const res = await fetch(`${apiBaseUrl()}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${checkApiKey(key, "OpenAI")}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: setting("OPENAI_VISION_MODEL", "gpt-4o-mini"),
            temperature: 0.3,
            messages: [{ role: "user", content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${photo.toString("base64")}`, detail: "high" } },
            ] }],
            response_format: { type: "json_schema", json_schema: { name: "inspiration", strict: true, schema: {
              type: "object", additionalProperties: false, required: ["summary", "tip", "pieces"],
              properties: {
                summary: { type: "string" },
                tip: { type: "string" },
                pieces: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "part", "kind", "kindName", "color", "colorName", "description", "search", "box", "sameKind", "alternatives"], properties: {
                  name: { type: "string" },
                  colorName: { type: "string" },
                  description: { type: "string" },
                  kind: { type: "string" },
                  kindName: { type: "string" },
                  sameKind: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "similar", "reason"], properties: { id: { type: "string" }, similar: { type: "boolean" }, reason: { type: "string" } } } },
                  search: { type: "string" },
                  box: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } } },
                  alternatives: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "reason"], properties: { id: { type: "string" }, reason: { type: "string" } } } },
                  part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "dress", "shoes", "accessories_up"] },
                  color: { type: "string" },
                } } },
              },
            } } },
          }),
        });
        const completion = await res.json().catch(() => ({}));
        if (!res.ok) throw openAIError(res.status, completion, "לא ניתן לנתח את התמונה כרגע");
        await recordSpend("השראה מתמונה", estimateTextUsd(completion.usage), wId);
        let parsed;
        try { parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}"); } catch { parsed = {}; }
        const byId = new Map(records.map((item) => [item.id, item]));
        // Never offer a different kind of item: a match must be in the same group
        // (top / jacket / bottom / dress / shoes / accessory), and an accessory must
        // be the same accessory (sunglasses for sunglasses, a bag for a bag)
        const groupOf = (part) => ({ upperbody: "top", top: "top", wholebody_up: "jacket", outerwear: "jacket", jacket: "jacket", lowerbody: "bottom", bottom: "bottom", dress: "dress", wholebody: "dress", shoes: "shoes", accessories_up: "accessory", accessory: "accessory" }[part] || part);
        const ACCESSORY_WORDS = {
          sunglasses: /sunglass|glasses|משקפ/i,
          bag: /bag|purse|clutch|tote|backpack|תיק|ארנק|קלאץ/i,
          belt: /belt|חגור/i,
          hat: /hat|cap|beanie|כובע/i,
          necklace: /necklace|chain|pendant|שרשר/i,
          earrings: /earring|עגיל/i,
          bracelet: /bracelet|bangle|צמיד/i,
          ring: /\bring\b|טבעת/i,
          watch: /watch|שעון/i,
          scarf: /scarf|צעיף|כאפי/i,
        };
        const accessoryKind = (text) => Object.keys(ACCESSORY_WORDS).find((kind) => ACCESSORY_WORDS[kind].test(text || "")) || null;
        const sameKind = (piece, item) => {
          // Sunglasses, a bag... only ever match the same accessory, whatever category the AI gave
          const pieceAccessory = accessoryKind(`${piece.kind} ${piece.name}`);
          if (pieceAccessory && accessoryKind(`${item.name} ${(item.tags || []).join(" ")}`) !== pieceAccessory) return false;
          if (groupOf(piece.part) !== groupOf(item.part)) return false;
          if (groupOf(piece.part) !== "accessory") return true;
          const wanted = accessoryKind(`${piece.kind} ${piece.name}`);
          const have = accessoryKind(`${item.name} ${(item.tags || []).join(" ")}`);
          return Boolean(wanted && have && wanted === have);
        };
        const CATEGORY_LABELS = { top: "החולצות", jacket: "העליוניות", bottom: "המכנסיים והחצאיות", dress: "השמלות", shoes: "הנעליים", accessory: "האקססוריז" };
        const rgb = (hex) => (/^#[0-9a-f]{6}$/i.test(hex || "") ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null);
        // Three levels for every piece of the photo:
        //   match    - pieces like it (same kind, close color and style): only those
        //   kind     - the same kind in other colors: only those, saying the exact one is missing
        //   category - nothing of that kind: everything in the category (accessories for sunglasses)
        const pieces = (Array.isArray(parsed.pieces) ? parsed.pieces : []).slice(0, 8).map((piece) => {
          const name = String(piece.name || "").slice(0, 60);
          const kindName = String(piece.kindName || "").slice(0, 30) || name;
          const target = rgb(piece.color);
          const distance = (item) => {
            const own = rgb(item.color);
            return target && own ? own.reduce((total, value, i) => total + (value - target[i]) ** 2, 0) : 1e9;
          };
          const seen = new Set();
          const sameKindList = (Array.isArray(piece.sameKind) ? piece.sameKind : [])
            .filter((entry) => byId.has(entry.id) && sameKind(piece, byId.get(entry.id)) && !seen.has(entry.id) && seen.add(entry.id))
            .map((entry) => ({ id: entry.id, similar: entry.similar === true, reason: String(entry.reason || "").slice(0, 80) }));
          // Accessories are also checked by name, so a pair of sunglasses the AI skipped still counts
          if (groupOf(piece.part) === "accessory" && accessoryKind(`${piece.kind} ${piece.name}`)) {
            for (const item of records) {
              if (!seen.has(item.id) && sameKind(piece, item)) {
                seen.add(item.id);
                sameKindList.push({ id: item.id, similar: false, reason: "אותו סוג, צבע אחר" });
              }
            }
          }
          const similar = sameKindList.filter((entry) => entry.similar);
          let level;
          let options;
          let note = "";
          if (similar.length) {
            // Every relevant piece: the closest ones first, then the rest of that kind
            level = "match";
            options = [...similar, ...sameKindList.filter((entry) => !entry.similar)];
          } else if (sameKindList.length) {
            level = "kind";
            options = sameKindList;
            note = `אין בארון ${name} כמו בתמונה. מה שיש לך מאותו סוג:`;
          } else {
            const picks = (Array.isArray(piece.alternatives) ? piece.alternatives : [])
              .filter((entry) => byId.has(entry.id) && groupOf(byId.get(entry.id).part) === groupOf(piece.part) && !seen.has(entry.id) && seen.add(entry.id))
              .map((entry) => ({ id: entry.id, reason: String(entry.reason || "").slice(0, 80) }));
            const rest = records
              .filter((item) => groupOf(item.part) === groupOf(piece.part) && !seen.has(item.id))
              .sort((a, b) => distance(a) - distance(b))
              .map((item) => ({ id: item.id, reason: "" }));
            options = [...picks, ...rest];
            level = options.length ? "category" : "none";
            note = options.length
              ? `אין בארון ${kindName}. כל ${CATEGORY_LABELS[groupOf(piece.part)] || "הפריטים מאותה קטגוריה"} שלך:`
              : `אין בארון ${kindName}, ואין פריטים אחרים מאותה קטגוריה.`;
          }
          const box = piece.box && [piece.box.x, piece.box.y, piece.box.width, piece.box.height].every(Number.isFinite) ? piece.box : null;
          return {
            name,
            part: piece.part,
            kind: String(piece.kind || "").slice(0, 30),
            color: /^#[0-9a-f]{6}$/i.test(piece.color) ? piece.color : null,
            colorName: String(piece.colorName || "").slice(0, 40),
            description: String(piece.description || "").slice(0, 300),
            search: String(piece.search || piece.name || "").slice(0, 80),
            box,
            level,
            note,
            options: options.map(({ id, reason }) => ({ id, reason })),
          };
        });
        return json(200, { summary: String(parsed.summary || ""), pieces });
      }
      if (url.pathname === "/api/import/outfits/prompt" && request.method === "POST") {
        const input = await body(request);
        const records = await loadImported(resolveWardrobeId(request, url));
        const selected = (Array.isArray(input.garmentIds) ? input.garmentIds : []).map((id) => records.find((item) => item.id === id)).filter(Boolean);
        if (!selected.length) return json(400, { error: "יש לבחור לפחות פריט אחד." });
        const outfitName = String(input.name || "").trim() || defaultLookName(selected);
        return json(200, { prompt: buildLookPrompt(selected, { outfitName, backdrop: "a warm, natural daylight setting with minimalist architecture", notes: String(input.notes || "").slice(0, 600), body: await bodyOf(resolveWardrobeId(request, url)) }) });
      }
      const openVersionMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/open-version$/i);
      if (openVersionMatch && (request.method === "POST" || request.method === "DELETE")) {
        // A photo of a jacket lying open, made once with AI and reused for free in every flat lay
        const id = openVersionMatch[1];
        const wId = resolveWardrobeId(request, url);
        const records = await loadImported(wId);
        const record = records.find((item) => item.id === id);
        if (!record) return json(404, { error: "Wardrobe item not found" });
        if (request.method === "DELETE") {
          await store.delete(libraryKey(`${id}-open.png`)).catch(() => {});
          record.openImage = null;
          await saveImported(wId, records);
          return json(200, record);
        }
        const input = await body(request);
        const key = setting("OPENAI_API_KEY");
        if (!key) return json(400, { error: "צריך מפתח של OpenAI כדי ליצור גרסה פתוחה." });
        const garment = await store.getBytes(libraryKey(`${id}-garment.png`));
        if (!garment) return json(404, { error: "לא נמצאה תמונה של הפריט." });
        const source = await sharp(garment).flatten({ background: "#ffffff" }).png().toBuffer();
        const quality = ["low", "medium"].includes(input.quality) ? input.quality : "low";
        const chromaKey = chooseChromaKey(record.color);
        const direction = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 600) : "";
        const prompt = `${buildGarmentPrompt(record, chromaKey)}
Reference note: the input is an existing product cutout of this garment on white.
Open-garment request: Show this exact same garment laid flat and fully OPEN, as in a flat-lay outfit photo. Undo its real front closure (zipper, buttons or snaps) and spread the two front panels apart to the left and right, as if worn open over an invisible body. Keep both sleeves, the collar and the true length. Draw ONLY the outside of the two front panels, the sleeves and the collar: the vertical gap between the open fronts must be the plain flat chroma background, with no lining, no inside back panel and nothing worn inside, so another top can be placed in that gap later. If the garment has no real front opening, keep it closed exactly as it is.${direction ? `
User direction: ${direction}` : ""}`;
        let bytes;
        try {
          bytes = await openAIEdit({
            key,
            baseUrl: apiBaseUrl(),
            model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
            quality,
            size: "1024x1024",
            images: [{ data: source, mime: "image/png", name: "source.png" }],
            prompt,
            action: "ז'קט פתוח",
          });
        } catch (error) {
          return json(error.accountProblem ? 402 : 502, { error: error.message });
        }
        try {
          bytes = await removeChromaBackground(bytes, chromaKey, { tolerance: 48 });
        } catch {
          bytes = (await processChromaBackground(bytes, chromaKey, { tolerance: 58 })).bytes;
        }
        await store.setBytes(libraryKey(`${id}-open.png`), bytes);
        // Re-read so edits made while the image was generating are kept
        const latest = await loadImported(wId);
        const latestRecord = latest.find((item) => item.id === id);
        if (!latestRecord) return json(404, { error: "Wardrobe item not found" });
        latestRecord.openImage = `${LIBRARY_ASSET_ROOT}/${id}-open.png?t=${Date.now()}`;
        latestRecord.openQuality = quality;
        await saveImported(wId, latest);
        return json(200, latestRecord);
      }
      const wardrobeVersionMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/version$/i);
      if (wardrobeVersionMatch && request.method === "POST") {
        // Decide what to do with a new version: use it, keep it as another item, or discard it
        const id = wardrobeVersionMatch[1];
        const wId = resolveWardrobeId(request, url);
        const { action } = await body(request);
        const records = await loadImported(wId);
        const record = records.find((item) => item.id === id);
        const pending = record?.pendingVersion;
        if (!record || !pending) return json(404, { error: "אין גרסה חדשה לבחירה." });
        const candidate = await store.getBytes(libraryKey(pending.file));
        let created = null;
        if (action === "use" && candidate) {
          await store.setBytes(libraryKey(`${id}-garment.png`), candidate);
          record.image = `${LIBRARY_ASSET_ROOT}/${id}-garment.png?t=${Date.now()}`;
          record.thumbnail = record.image;
          record.catalogQuality = pending.quality;
        } else if (action === "keep-both" && candidate) {
          const newId = `import-${randomUUID()}`;
          await store.setBytes(libraryKey(`${newId}-garment.png`), candidate);
          const original = await store.getBytes(libraryKey(`${id}-original.png`));
          if (original) await store.setBytes(libraryKey(`${newId}-original.png`), original);
          created = {
            ...record,
            id: newId,
            name: `${record.name || "פריט"} (גרסה נוספת)`,
            image: `${LIBRARY_ASSET_ROOT}/${newId}-garment.png`,
            thumbnail: `${LIBRARY_ASSET_ROOT}/${newId}-garment.png`,
            modeledImage: null,
            originalImage: original ? `${LIBRARY_ASSET_ROOT}/${newId}-original.png` : null,
            catalogQuality: pending.quality,
            pendingVersion: null,
            createdAt: new Date().toISOString(),
          };
          records.push(created);
        } else if (action !== "discard") {
          return json(400, { error: "Unknown action" });
        }
        await store.delete(libraryKey(pending.file)).catch(() => {});
        record.pendingVersion = null;
        await saveImported(wId, records);
        return json(200, { item: record, created });
      }
      const wardrobeModeledMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/modeled$/i);
      if (wardrobeModeledMatch && request.method === "POST") {
        const id = wardrobeModeledMatch[1];
        const wId = resolveWardrobeId(request, url);
        // Optional note from the user, e.g. "maxi dress" or "bodysuit"
        const modeledNote = String((await body(request)).notes || "").trim().slice(0, 600);
        const records = await loadImported(wId);
        const record = records.find((item) => item.id === id);
        if (!record) return json(404, { error: "Wardrobe item not found" });

        const modelData = await loadModelReference(wId);
        if (!modelData) {
          return json(400, { error: "Reference photo is required. Please upload your reference photo first so the AI can model the look on you." });
        }
        const key = setting("OPENAI_API_KEY");
        const garmentData = await requireBytes(libraryKey(`${id}-garment.png`), "Garment image not found");

        const model = { data: modelData, mime: "image/png", name: "model.png" };
        const garment = { data: garmentData, mime: "image/png", name: "garment.png" };
        const basePrompt = buildModeledPrompt(record, "", await bodyOf(wId));

        let bytes;
        if (!key) {
          bytes = await fitItemOnModel(model.data, garment.data, {
            name: record.name,
            part: record.part,
          });
        } else {
          try {
            bytes = await openAIEdit({
              key,
              baseUrl: apiBaseUrl(),
              model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
              // Photos of a garment on the user default to medium quality (cheaper)
              quality: setting("OPENAI_MODELED_QUALITY", "medium"),
              size: "1536x1024",
              images: [model, garment],
              prompt: modeledNote ? `${basePrompt}
User direction about this garment and how it is worn: ${modeledNote}` : basePrompt,
            });
          } catch (modelError) {
            if (modelError.accountProblem) return json(402, { error: modelError.message });
            bytes = await fitItemOnModel(model.data, garment.data, {
              name: record.name,
              part: record.part,
            });
          }
        }

        const modeledName = `${id}-modeled.png`;
        await store.setBytes(libraryKey(modeledName), bytes);
        // Re-read so edits made while the image was generating are kept
        const latest = await loadImported(wId);
        const latestRecord = latest.find((item) => item.id === id);
        if (!latestRecord) return json(404, { error: "Wardrobe item not found" });
        latestRecord.modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}?t=${Date.now()}`;
        await saveImported(wId, latest);

        return json(200, latestRecord);
      }
      if (url.pathname === "/api/import/outfits/preview-flatlay" && request.method === "POST") {
        const input = await body(request);
        const wId = resolveWardrobeId(request, url);
        const garmentIds = Array.isArray(input.garmentIds) ? input.garmentIds : [];
        const records = await loadImported(wId);
        const selectedGarments = garmentIds.map((id) => records.find((item) => item.id === id)).filter(Boolean);
        const garmentEntries = [];
        for (const g of selectedGarments) {
          const buffer = await store.getBytes(libraryKey(`${g.id}-garment.png`));
          if (buffer) garmentEntries.push({ buffer, item: g });
        }
        if (!garmentEntries.length) {
          return json(400, { error: "יש לבחור לפחות פריט אחד מהמלתחה." });
        }
        const bytes = await generateFlatLayOutfit(garmentEntries);
        const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
        return json(200, { image: dataUrl });
      }
      if (url.pathname === "/api/import/outfits" && request.method === "GET") {
        const wId = resolveWardrobeId(request, url);
        const outfits = await loadOutfits(wId);
        return json(200, outfits.map((o) => ({
          ...o,
          image: o.image?.startsWith("outfit-images/")
            ? `/api/import/outfits/images/${path.basename(o.image)}`
            : o.image,
        })));
      }
      if (url.pathname === "/api/import/outfits/ai-complete" && request.method === "POST") {
        const input = await body(request);
        const wId = resolveWardrobeId(request, url);
        const result = await completeOutfitWithAI({ ...input, wardrobeId: wId });
        return json(200, result);
      }
      if (url.pathname === "/api/import/outfits/auto-generate" && request.method === "POST") {
        const input = await body(request);
        const wId = resolveWardrobeId(request, url);
        const created = await autoGenerateOutfits({ ...input, wardrobeId: wId });
        return json(200, created);
      }
      if (url.pathname === "/api/import/outfits/generate" && request.method === "POST") {
        const input = await body(request);
        const wId = resolveWardrobeId(request, url);
        const outfit = await generateOutfitLook({ ...input, wardrobeId: wId });
        return json(200, outfit);
      }
      if (url.pathname === "/api/import/outfits/save" && request.method === "POST") {
        const input = await body(request);
        const wId = resolveWardrobeId(request, url);
        const outfit = await saveCustomOutfit(input.outfit || input, wId);
        return json(200, outfit);
      }
      const outfitDeleteMatch = url.pathname.match(/^\/api\/import\/outfits\/([\w-]+)$/i);
      if (outfitDeleteMatch && request.method === "DELETE") {
        const id = outfitDeleteMatch[1];
        const wId = resolveWardrobeId(request, url);
        const outfits = await loadOutfits(wId);
        const next = outfits.filter((o) => o.id !== id);
        await saveOutfits(wId, next);
        await store.delete(outfitImageKey(`${id}.png`));
        return json(200, { deleted: true, id });
      }
      if (url.pathname === "/api/import/suitcases" && request.method === "GET") {
        const wId = resolveWardrobeId(request, url);
        const suitcases = await loadSuitcases(wId);
        return json(200, suitcases);
      }
      if (url.pathname === "/api/import/suitcases" && request.method === "POST") {
        const input = await body(request);
        const wId = resolveWardrobeId(request, url);
        const suitcases = await loadSuitcases(wId);
        const suitcaseId = input.id || `suitcase-${wId}`;
        const suitcase = {
          ...input,
          id: suitcaseId,
          updatedAt: new Date().toISOString(),
          createdAt: input.createdAt || new Date().toISOString(),
          wardrobeId: wId,
        };
        const next = [suitcase, ...suitcases.filter((s) => s.id !== suitcaseId)];
        await saveSuitcases(wId, next);
        return json(200, suitcase);
      }
      const suitcaseDeleteMatch = url.pathname.match(/^\/api\/import\/suitcases\/([\w-]+)$/i);
      if (suitcaseDeleteMatch && request.method === "DELETE") {
        const id = suitcaseDeleteMatch[1];
        const wId = resolveWardrobeId(request, url);
        const suitcases = await loadSuitcases(wId);
        const next = suitcases.filter((s) => s.id !== id);
        await saveSuitcases(wId, next);
        return json(200, { deleted: true, id });
      }
      if (url.pathname === "/api/import/user" && request.method === "GET") {
        const wId = resolveWardrobeId(request, url);
        const user = await loadUserProfile(wId);
        return json(200, user);
      }
      if (url.pathname === "/api/import/user" && request.method === "POST") {
        const input = await body(request);
        const wId = resolveWardrobeId(request, url);
        const current = await loadUserProfile(wId);
        const updated = { ...current, ...input, ...(input.body !== undefined ? { body: normalizeBody(input.body) } : {}), lastSync: new Date().toISOString() };
        await saveUserProfile(wId, updated);
        return json(200, updated);
      }
      if (url.pathname === "/api/import/user/sync" && request.method === "POST") {
        const input = await body(request);
        const current = (await store.getJSON("user-sync.json").catch(() => null)) || {};
        const merged = { ...current, ...input, syncedAt: new Date().toISOString() };
        await store.setJSON("user-sync.json", merged);
        return json(200, merged);
      }
      if (url.pathname === "/api/import/user/sync" && request.method === "GET") {
        return json(200, (await store.getJSON("user-sync.json").catch(() => null)) || {});
      }
      const outfitImageMatch = url.pathname.match(/^\/api\/import\/outfits\/images\/([\w.-]+)$/i);
      if (outfitImageMatch && request.method === "GET") {
        const name = path.basename(outfitImageMatch[1]);
        const width = variantWidth(url);
        if (width) {
          const variant = await imageVariant(`outfit-${name}`, url, width, false, () => store.getBytes(outfitImageKey(name)));
          if (variant) return imageResponse(variant, { contentType: "image/webp" });
        }
        const data = await store.getBytes(outfitImageKey(name));
        if (!data) return json(404, { error: "Outfit image not found" });
        return imageResponse(data);
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && request.method === "GET") {
        const name = path.basename(libraryAssetMatch[1]);
        // ?fit=1 serves the garment cropped and centred for an even wardrobe grid
        const fit = url.searchParams.get("fit") === "1" && name.endsWith("-garment.png");
        const width = variantWidth(url);
        if (width) {
          // Small WebP copies for the grid; made once and kept, so later visits are fast
          const variant = await imageVariant(name, url, width, fit, () => store.getBytes(libraryKey(name)));
          if (variant) return imageResponse(variant, { contentType: "image/webp" });
        }
        const bytes = await requireBytes(libraryKey(name));
        if (fit) return imageResponse(await fitGarmentToSquare(bytes));
        return imageResponse(bytes);
      }
      const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
      if (assetMatch && request.method === "GET") {
        const name = path.basename(assetMatch[2]);
        const data = await requireBytes(jobKey(assetMatch[1], name));
        return imageResponse(data, { contentType: name.endsWith(".svg") ? "image/svg+xml" : "image/png", cache: "no-store" });
      }
      if (url.pathname === API_ROOT && request.method === "POST") {
        const wId = resolveWardrobeId(request, url);
        const input = await body(request);
        const image = decodeImage(input);
        const normalizedImage = await normalizeImage(image.data);
        const key = setting("OPENAI_API_KEY");
        // Free mode: no AI detection; the browser removes the background itself
        const free = input.mode === "free";
        // Catalog: AI detection and a cheap AI product shot, without dressing it on the model
        const catalog = input.mode === "catalog";
        let detected = [];
        let warning = null;
        if (!free && process.env.GEMINI_API_KEY) {
          try {
            detected = (await geminiAnalyze({ image: normalizedImage, mime: "image/png" })).map(normalizeMetadata);
          } catch {}
        }
        if (!free && !detected.length && key) {
          try {
            detected = (await openAIAnalyze({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-4o-mini"), image: normalizedImage, mime: "image/png" })).map(normalizeMetadata);
          } catch (analysisError) {
            // Continue with the whole photo as one item, but tell the user why
            if (analysisError.accountProblem) warning = analysisError.message;
          }
        }
        if (!detected.length) {
          let dominantHex = "#d8d0c2";
          try {
            const stats = await sharp(normalizedImage).stats();
            const [r, g, b] = stats.channels.slice(0, 3).map((ch) => Math.round(ch.mean));
            dominantHex = `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
          } catch {}
          // Free imports send the category and colour the browser recognised
          detected = [normalizeMetadata({
            name: input.metadata?.name || "New piece",
            part: (free && input.metadata?.part) || "upperbody",
            color: (free && input.metadata?.color) || dominantHex,
            boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
            tags: free ? [] : ["יומיומי"],
          })];
        }
        const jobs = [];
        for (const metadata of detected) {
          const id = randomUUID();
          const originalFile = "original.png";
          const cropFile = "crop.png";
          const croppedImage = await cropDetectedItem(normalizedImage, metadata.boundingBox);
          await store.setBytes(jobKey(id, originalFile), normalizedImage);
          await store.setBytes(jobKey(id, cropFile), croppedImage);
          const now = new Date().toISOString();
          const cropStage = { ...stageState(), status: free || catalog ? "approved" : "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
          const job = { id, wardrobeId: wId, mode: free ? "free" : catalog ? "catalog" : "ai", status: "active", metadata, stages: { crop: cropStage, garment: stageState(), modeled: stageState() }, createdAt: now, updatedAt: now, internal: { originalFile, cropFile, originalMime: "image/png" } };
          job.originalAssetUrl = `${ASSET_ROOT}/${id}/${originalFile}`;
          await saveJob(job); jobs.push(publicJob(job));
          // Catalog skips the crop review and starts the product shot right away
          if (catalog) await startStage(job.id, "garment");
        }
        return json(202, { jobs, noClothingDetected: jobs.length === 0, warning });
      }
      if (url.pathname === API_ROOT && request.method === "GET") {
        const ids = await store.listDirs("jobs").catch(() => []);
        const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter(Boolean);
        const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected");
        await Promise.all(hiddenJobs.map((job) => deleteJob(job.id)));
        const wId = resolveWardrobeId(request, url);
        const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job) && (job.wardrobeId || "user-shani") === wId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(200, jobs.map(publicJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(404, { error: "Not found" });
      const job = await loadJob(match[1]);
      if (!job) {
        // A finished import is removed once the piece is in the wardrobe. If the
        // answer to "save" got lost (a weak connection) and save is pressed again,
        // the piece is already saved: say so instead of failing.
        const wId = resolveWardrobeId(request, url);
        const records = await loadImported(wId);
        const savedRecord = records.find((record) => record.id === `import-${match[1]}`);
        const action = match[2] || "";
        if (savedRecord && (action === "metadata" || /^stages\/(garment|modeled)\/approve$/.test(action))) {
          if (action === "metadata" && request.method === "PATCH") {
            const input = await body(request);
            const metadata = normalizeMetadata({ ...input.metadata });
            Object.assign(savedRecord, {
              name: metadata.name || savedRecord.name,
              part: metadata.part || savedRecord.part,
              color: metadata.color || savedRecord.color,
              secondaryColor: metadata.secondaryColor ?? savedRecord.secondaryColor ?? null,
              palette: [metadata.color || savedRecord.color, metadata.secondaryColor ?? savedRecord.secondaryColor].filter(Boolean),
              tags: Array.isArray(metadata.tags) ? metadata.tags : savedRecord.tags,
              fit: normalizeFit(metadata.fit),
            });
            await saveImported(wId, records);
          }
          return json(200, { id: match[1], status: "complete", alreadySaved: true, metadata: savedRecord, stages: {} });
        }
        return json(404, { error: "הפריט כבר לא בתהליך הייבוא. אם שמרת אותו, הוא נמצא בארון." });
      }
      const action = match[2] || "";
      if (!action && request.method === "GET") return json(200, publicJob(job));
      if (!action && request.method === "DELETE") {
        await deleteJob(job.id);
        return json(200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (request.method === "PATCH" || request.method === "PUT")) {
        const input = await body(request);
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
        job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata }); await saveJob(job);
        return json(200, publicJob(job));
      }
      if (action === "stages/garment/upload" && request.method === "POST") {
        // Free mode: the browser sends a cutout with a transparent background
        if (job.mode !== "free") throw Object.assign(new Error("Only free-mode imports accept uploaded cutouts"), { status: 409 });
        const input = await body(request);
        const image = decodeImage(input);
        let framed;
        try {
          framed = await frameTransparentGarment(await normalizeImage(image.data), 1024, 0.88);
        } catch {
          throw Object.assign(new Error("לא נמצא בגד בתמונה אחרי הסרת הרקע. נסו תמונה של הבגד לבד על רקע פשוט."), { status: 400 });
        }
        const stage = job.stages.garment;
        stage.attempts += 1;
        const outputName = `garment-${stage.attempts}.png`;
        await store.setBytes(jobKey(job.id, outputName), framed);
        Object.assign(stage, { status: "review", decision: null, error: null, assetUrl: `${ASSET_ROOT}/${job.id}/${outputName}`, updatedAt: new Date().toISOString() });
        await saveJob(job);
        return json(200, publicJob(job));
      }
      const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
      if (cleanupAction && request.method === "POST") {
        const stage = job.stages.garment;
        if (stage.status !== "failed" || !stage.failedAssetUrl) {
          throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
        }
        const input = await body(request);
        const tolerance = cleanupTolerance(input.tolerance);
        const sourceName = path.basename(new URL(stage.failedAssetUrl, "http://localhost").pathname);
        const source = await requireBytes(jobKey(job.id, sourceName));
        const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
        const cleaned = await processChromaBackground(source, key, { tolerance });
        const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
        const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
        await store.setBytes(jobKey(job.id, previewName), cleaned.bytes);
        stage.chromaKey = key;
        stage.cleanupTolerance = cleaned.tolerance;
        stage.cleanupDiagnostics = cleaned.verification;
        stage.cleanupPreviewUrl = previewUrl;
        stage.updatedAt = new Date().toISOString();
        if (cleanupAction[1] === "cleanup-accept") {
          stage.status = "review";
          stage.decision = null;
          stage.error = null;
          stage.assetUrl = previewUrl;
        }
        await saveJob(job);
        return json(200, publicJob(job));
      }
      const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
      if (stageMatch && request.method === "POST") {
        const [, stageName, decision] = stageMatch;
        if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
        if (decision === "regenerate") {
          if (job.mode === "free") throw Object.assign(new Error("בייבוא החינמי אין יצירה מחדש. מחקו את הפריט והעלו שוב."), { status: 400 });
          if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
          const input = await body(request);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          // "Redo at medium quality" for a garment the cheap pass did not capture well
          if (stageName === "garment" && ["low", "medium", "high"].includes(input.quality)) job.stages.garment.quality = input.quality;
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job);
          await startStage(job.id, stageName);
          return json(202, publicJob(job));
        }
        if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const currentSetup = await setupStatus(job.wardrobeId);
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        const skipModeled = ["free", "catalog"].includes(job.mode) || !currentSetup.hasModelReference;
        const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending" && !skipModeled;
        if (stageName === "garment" && decision === "approve" && skipModeled) {
          job.stages.modeled.status = "skipped";
          job.status = "complete";
        }
        if (stageName === "modeled" && decision === "approve") job.status = "complete";
        // A finished job is saved only after the piece is in the wardrobe, so the
        // queue's clean-up can never remove its files halfway through saving
        if (job.status !== "complete") await saveJob(job);
        if (decision === "approve" && stageName !== "crop") {
          try {
            await persistImported(job, stageName === "modeled");
          } catch (error) {
            job.stages[stageName].status = previousStatus;
            job.stages[stageName].decision = previousDecision;
            job.status = previousJobStatus;
            await saveJob(job);
            throw error;
          }
        }
        if (decision === "reject") await deleteJob(job.id);
        if (startGarment) await startStage(job.id, "garment");
        if (startModeled) await startStage(job.id, "modeled");
        const response = publicJob(job);
        if (job.status === "complete") await deleteJob(job.id);
        return json(200, response);
      }
      return json(404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.status || 500;
      if (statusCode === 500) console.error(error);
      // The API is behind the site password, so the real reason is safe to show and helps diagnose problems
      return json(statusCode, { error: statusCode === 500 ? `שגיאת שרת: ${error.message}` : error.message });
    }
  }

  return { handle, runDeferred, resumeJobs, isLongRequest, enqueueRequest };
}
