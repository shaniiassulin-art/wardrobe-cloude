import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes", "dress", "wholebody"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
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

  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;
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
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) {
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
  }
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < framedData.length; index += 4) {
    if (framedData[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + framedData[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + framedData[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(framedData, index, keyedChannels, neutralLevel);
  }
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
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
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

export async function generateFlatLayOutfit(garmentEntries = []) {
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
      processed.push({
        buffer: imgBuffer,
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
  const shoes = processed.filter(isShoe);
  const bags = processed.filter((e) => isBag(e) && !shoes.includes(e));

  // Anything not categorized yet:
  const assigned = new Set([
    ...headwear,
    ...outerwear,
    ...dresses,
    ...tops,
    ...belts,
    ...bottoms,
    ...shoes,
    ...bags,
  ]);
  const otherAccessories = processed.filter((e) => !assigned.has(e));

  const composites = [];
  const placedBoxes = [];

  // Helper to place item with realistic drop shadow
  async function placeItem(item, { targetW, targetH, left, top, blur = 6, opacity = 0.22 }) {
    const w = Math.max(40, Math.round(targetW));
    const h = Math.max(40, Math.round(targetH));
    const l = Math.round(left);
    const t = Math.round(top);

    const resized = await sharp(item.buffer)
      .resize({
        width: w,
        height: h,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    const shadow = await sharp(resized)
      .tint({ r: 35, g: 30, b: 25 })
      .blur(blur)
      .linear(opacity, 0)
      .png()
      .toBuffer();

    composites.push({ input: shadow, top: t + 4, left: l + 2 });
    composites.push({ input: resized, top: t, left: l });

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

  // 2. Tops / Outerwear / Dresses
  const allUpper = [...outerwear, ...tops, ...dresses];
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

    if (hasOuter) {
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

async function openAIEdit({ key, baseUrl, model, prompt, images, size, background, quality }) {
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
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI response did not contain image data");
  return Buffer.from(encoded, "base64");
}

async function openAIAnalyze({ key, baseUrl, model, image, mime }) {
  const validVisionModel = (!model || model.includes("5.4") || !model.includes("gpt-4")) ? "gpt-4o-mini" : model;
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: validVisionModel,
      input: [{ role: "user", content: [
        { type: "input_text", text: "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags." },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", minItems: 0, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, maxItems: 4 }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"] } } }, required: ["items"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI analysis failed (${response.status})`);
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
  const prompt = "Identify every distinct wearable clothing item visible in this image. Return one record per actual item. Include integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner (0-999), followed by width and height (1-1000). Use only category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Suggest a concise specific name, primary six-digit hex color (#rrggbb), optional secondary hex color, and 1-4 detail tags.";
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

export function wardrobeImportApi(options = {}) {
  let root;
  let dataDir;
  let jobsDir;
  let importedFile;
  let libraryAssetDir;
  let outfitsFile;
  let outfitsAssetDir;
  let suitcasesFile;
  let userProfileFile;
  let serverSettings = {};
  const running = new Map();

  const setting = (name, fallback = "") =>
    serverSettings[name] || options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  function resolveWardrobeId(req, url) {
    const fromHeader = req?.headers ? (req.headers["x-wardrobe-id"] || req.headers["x-wardrobe"]) : null;
    const fromQuery = url?.searchParams ? (url.searchParams.get("wardrobeId") || url.searchParams.get("wardrobe") || url.searchParams.get("email") || url.searchParams.get("user")) : null;
    const raw = (fromHeader || fromQuery || "user-shani").toString().trim();
    if (!raw || raw === "default" || raw === "user-shani" || raw.toLowerCase() === "shaniiassulin@gmail.com") {
      return "user-shani";
    }
    const sanitized = raw.toLowerCase().replace(/@/g, "-at-").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
    return sanitized || "user-shani";
  }

  function getWardrobePaths(wardrobeId = "user-shani") {
    if (!wardrobeId || wardrobeId === "user-shani" || wardrobeId === "default") {
      return {
        dir: null,
        importedFile: path.join(dataDir, "library.json"),
        suitcasesFile: path.join(dataDir, "suitcases.json"),
        outfitsFile: path.join(dataDir, "outfits.json"),
        userProfileFile: path.join(dataDir, "user-profile.json"),
      };
    }
    const dir = path.join(dataDir, "wardrobes", wardrobeId);
    return {
      dir,
      importedFile: path.join(dir, "library.json"),
      suitcasesFile: path.join(dir, "suitcases.json"),
      outfitsFile: path.join(dir, "outfits.json"),
      userProfileFile: path.join(dir, "user-profile.json"),
    };
  }

  async function loadOutfits(wardrobeId = "user-shani") {
    const { dir, outfitsFile: f } = getWardrobePaths(wardrobeId);
    if (dir) await mkdir(dir, { recursive: true });
    try {
      const data = JSON.parse(await readFile(f, "utf8"));
      return Array.isArray(data.outfits) ? data.outfits : Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function saveOutfits(wardrobeId = "user-shani", outfits) {
    const { dir, outfitsFile: f } = getWardrobePaths(wardrobeId);
    if (dir) await mkdir(dir, { recursive: true });
    await atomicJson(f, { version: 1, outfits });
  }

  async function loadSuitcases(wardrobeId = "user-shani") {
    const { dir, suitcasesFile: f } = getWardrobePaths(wardrobeId);
    if (dir) await mkdir(dir, { recursive: true });
    try {
      const data = JSON.parse(await readFile(f, "utf8"));
      return Array.isArray(data.suitcases) ? data.suitcases : Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function saveSuitcases(wardrobeId = "user-shani", suitcases) {
    const { dir, suitcasesFile: f } = getWardrobePaths(wardrobeId);
    if (dir) await mkdir(dir, { recursive: true });
    await atomicJson(f, { version: 1, suitcases });
  }

  async function loadUserProfile(wardrobeId = "user-shani") {
    const { dir, userProfileFile: f } = getWardrobePaths(wardrobeId);
    if (dir) await mkdir(dir, { recursive: true });
    try {
      return JSON.parse(await readFile(f, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
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
      throw error;
    }
  }

  async function saveUserProfile(wardrobeId = "user-shani", profile) {
    const { dir, userProfileFile: f } = getWardrobePaths(wardrobeId);
    if (dir) await mkdir(dir, { recursive: true });
    await atomicJson(f, {
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

    const wardrobesDir = path.join(dataDir, "wardrobes");
    try {
      await mkdir(wardrobesDir, { recursive: true });
      const entries = await readdir(wardrobesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "user-shani") {
          const wId = entry.name;
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

    const { dir, importedFile: libF, suitcasesFile: suitF, outfitsFile: outF } = getWardrobePaths(targetId);
    if (dir) await mkdir(dir, { recursive: true });

    // Initialize files if not existing
    try {
      await readFile(libF, "utf8");
    } catch {
      await atomicJson(libF, []);
    }
    try {
      await readFile(suitF, "utf8");
    } catch {
      await atomicJson(suitF, { version: 1, suitcases: [] });
    }
    try {
      await readFile(outF, "utf8");
    } catch {
      await atomicJson(outF, { version: 1, outfits: [] });
    }

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
    const { dir } = getWardrobePaths(wardrobeId);
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
    return true;
  }

  async function generateOutfitLook(input = {}) {
    const { name, garmentIds = [], occasion, settingDirection, notes, save = true, mode, noModel, wardrobeId = "user-shani" } = input;
    const isFlatlay = mode === "flatlay" || noModel === true;

    const records = await loadImported(wardrobeId);
    const selectedGarments = [];
    const garmentImages = [];

    for (let i = 0; i < garmentIds.length; i++) {
      const id = garmentIds[i];
      const record = records.find((item) => item.id === id);
      if (!record) continue;
      selectedGarments.push(record);
      const garmentFile = path.join(libraryAssetDir, `${id}-garment.png`);
      const garmentData = await readFile(garmentFile);
      garmentImages.push({
        data: garmentData,
        mime: "image/png",
        name: `garment-${i + 1}.png`,
      });
    }

    if (!selectedGarments.length) throw new Error("אנא בחרו לפחות פריט אחד מהמלתחה ליצירת לוק.");

    const outfitName = name || selectedGarments.map((g) => g.name).join(" + ") || "לוק מעוצב";
    const backdrop = settingDirection || "a warm, natural daylight setting with minimalist architecture";

    let bytes;
    const garmentEntries = selectedGarments.map((g, idx) => ({
      buffer: garmentImages[idx].data,
      item: g,
    }));

    if (isFlatlay) {
      bytes = await generateFlatLayOutfit(garmentEntries);
    } else {
      const key = setting("OPENAI_API_KEY");
      const setup = await setupStatus();

      if (!key || !setup.hasModelReference) {
        if (setup.hasModelReference) {
          try {
            const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
            const modelData = await readFile(modelPath);
            bytes = await fitMultipleGarmentsOnModel(modelData, garmentEntries);
          } catch (_) {
            bytes = await generateFlatLayOutfit(garmentEntries);
          }
        } else {
          bytes = await generateFlatLayOutfit(garmentEntries);
        }
      } else {
        const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
        const modelData = await readFile(modelPath);
        const model = { data: modelData, mime: "image/png", name: "model.png" };

        const garmentListDesc = selectedGarments.map((g, idx) => `Garment ${idx + 1}: ${g.name} (${g.part}, color: ${g.color || "as shown"})`).join(", ");
        const notesPrompt = notes?.trim()
          ? `\nStyling & fit instructions: ${notes.trim()}\nFollow these exact styling instructions precisely (e.g. open/closed, untucked/tucked, rolled sleeves, or shoulder tie).`
          : "";

        const hasOuter = selectedGarments.some((g) => g.part === "wholebody_up" || g.part === "outerwear" || g.part === "jacket");
        const layeredClause = hasOuter
          ? `\nLayered-look clause: Layer the exact inner top and outer layer naturally so both remain visibly identifiable. First inspect the outer reference. If it has a real full front button or zipper closure, it may be worn naturally open or partly open using only that closure. If it is a pullover or has no full front opening, keep it closed exactly as designed and reveal the inner top only at its real collar or neckline, sleeve or cuff edge, or a natural 2–4 cm untucked hem below the outer layer. Never invent, add, split, unzip, unbutton, or simulate a closure. Keep the outer garment at its true length even when it overlaps the waistband.`
          : "";

        const prompt = `Use case: identity-preserve
Asset type: square outfit gallery photograph

Image 1: identity reference for the exact person to preserve.
${selectedGarments.map((g, idx) => `Image ${idx + 2}: exact ${g.part} reference (${g.name})`).join("\n")}

Primary request: Create a professional square editorial fashion photograph of the person from Image 1 wearing all of the exact referenced garments (${garmentListDesc}), and only those garments.

Outfit: ${outfitName}
Scene/backdrop: ${backdrop}
${notesPrompt}

Subject: Preserve the same person's recognizable face, hair, age, build, skin texture, and body proportions. Dress them in the exact referenced garments. Plain understated shoes and invisible basics such as socks are allowed where needed. Do not add, replace, or invent any other visible clothing or accessory.

Style/medium: Photorealistic natural editorial fashion campaign with authentic skin and fabric texture and no synthetic AI polish.

Composition/framing: Square 1:1 image. Show the complete person and outfit from head through shoes. Keep the person centered and occupying most of the frame with modest breathing room. Use a relaxed, mostly front-facing pose with arms away from the torso so every item remains readable.

Lighting/mood: Warm professional natural light, realistic shadows, and restrained editorial color grading.

Garment fidelity: Preserve every referenced garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, and distinctive details. Keep each piece recognizable without changing its natural length, tuck, or construction.
${layeredClause}

Avoid: Completely hidden selected garments, invented zippers, buttons, openings, unnatural layering, extra people, text overlays, watermarks, studio cutout appearance, or synthetic AI polish.`;

        try {
          bytes = await openAIEdit({
            key,
            baseUrl: apiBaseUrl(),
            model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
            quality: setting("OPENAI_IMAGE_QUALITY", "high"),
            size: "1024x1024",
            images: [model, ...garmentImages],
            prompt,
          });
        } catch (err) {
          console.warn("OpenAI outfit generation error, fallback to fitting:", err.message);
        }

        if (!bytes) {
          bytes = await fitMultipleGarmentsOnModel(model.data, garmentEntries);
        }
      }
    }

    const outfitId = `outfit-${randomUUID().slice(0, 8)}`;
    const filename = `${outfitId}.png`;
    await writeFile(path.join(outfitsAssetDir, filename), bytes);

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

    if (!outfitImage || outfitData.mode === "flatlay" || outfitImage.startsWith("data:")) {
      try {
        const garmentEntries = [];
        for (const g of selectedGarments) {
          const garmentPath = path.join(libraryAssetDir, `${g.id}-garment.png`);
          try {
            const buffer = await readFile(garmentPath);
            garmentEntries.push({ buffer, item: g });
          } catch (_) {}
        }
        if (garmentEntries.length) {
          const bytes = await generateFlatLayOutfit(garmentEntries);
          const filename = `${outfitId}.png`;
          await writeFile(path.join(outfitsAssetDir, filename), bytes);
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
      name: outfitData.name || selectedGarments.map((g) => g.name).join(" + ") || "Custom Look",
      occasion: outfitData.occasion || ["casual"],
      garmentIds: outfitData.garmentIds,
      garments: selectedGarments.map((g) => ({
        id: g.id,
        name: g.name,
        part: g.part,
        thumbnail: g.thumbnail || g.image,
      })),
      notes: outfitData.notes || null,
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

  async function autoGenerateOutfits({ count = 1, occasion = "everyday", season = "", settingDirection = "", wardrobeId = "user-shani" } = {}) {
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
      throw Object.assign(new Error("You need tops and bottoms (or dresses) in your wardrobe to auto-generate outfits."), { status: 400 });
    }

    const existingOutfits = await loadOutfits(wardrobeId);
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
        const outfitTitle = secondary
          ? `${primary.name} + ${secondary.name}`
          : `${primary.name} Look`;

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
            "Authorization": `Bearer ${key}`,
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
    const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
    const referencePath = path.resolve(root, referenceSetting);
    const { dir: wDir } = getWardrobePaths(wardrobeId);
    const wRefPath = wDir ? path.join(wDir, "model-reference.png") : null;
    let hasModelReference = false;
    try {
      if (wRefPath && (await stat(wRefPath).catch(() => null))?.isFile()) {
        hasModelReference = true;
      } else {
        hasModelReference = (await stat(referencePath)).isFile();
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      ready: true,
      hasApiKey,
      hasModelReference,
      modelReference: referenceSetting,
    };
  }

  async function loadJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    try { return JSON.parse(await readFile(path.join(jobsDir, id, "job.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await atomicJson(path.join(jobsDir, job.id, "job.json"), job);
  }

  async function loadImported(wardrobeId = "user-shani") {
    const { dir, importedFile: f } = getWardrobePaths(wardrobeId);
    if (dir) await mkdir(dir, { recursive: true });
    try { return JSON.parse(await readFile(f, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function saveImported(wardrobeId = "user-shani", records = []) {
    const { dir, importedFile: f } = getWardrobePaths(wardrobeId);
    if (dir) await mkdir(dir, { recursive: true });
    await atomicJson(f, records);
  }

  async function persistImported(job, includeModeled = false, wardrobeId = "user-shani") {
    const wId = wardrobeId || job.wardrobeId || "user-shani";
    const id = `import-${job.id}`;
    await mkdir(libraryAssetDir, { recursive: true });
    const garmentName = `${id}-garment.png`;
    const garmentSource = job.stages.garment.assetUrl
      ? path.basename(new URL(job.stages.garment.assetUrl, "http://localhost").pathname)
      : `garment-${job.stages.garment.attempts}.png`;
    await copyFile(path.join(jobsDir, job.id, garmentSource), path.join(libraryAssetDir, garmentName));
    let modeledImage = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      const modeledSource = job.stages.modeled.assetUrl
        ? path.basename(new URL(job.stages.modeled.assetUrl, "http://localhost").pathname)
        : `modeled-${job.stages.modeled.attempts}.png`;
      await copyFile(path.join(jobsDir, job.id, modeledSource), path.join(libraryAssetDir, modeledName));
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
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
      wardrobeId: wId,
    };
    const next = [...records.filter((item) => item.id !== id), record];
    await saveImported(wId, next);
    return record;
  }

  async function generate(job, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const current = await loadJob(job.id);
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current);
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      try {
        const dir = path.join(jobsDir, current.id);
        const output = path.join(dir, `${stageName}-${stage.attempts}.png`);
        const key = setting("OPENAI_API_KEY");
        const sourceFile = stageName === "garment" && current.internal.cropFile ? current.internal.cropFile : current.internal.originalFile;
        const original = { data: await readFile(path.join(dir, sourceFile)), mime: "image/png", name: sourceFile };
        let bytes;
        if (stageName === "garment") {
          chromaKeyUsed = chooseChromaKey(current.metadata.color);
          const basePrompt = options.garmentPrompt || buildGarmentPrompt(current.metadata, chromaKeyUsed);
          if (key) {
            bytes = await openAIEdit({
              key,
              baseUrl: apiBaseUrl(),
              model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
              quality: setting("OPENAI_IMAGE_QUALITY", "high"),
              size: "1024x1024",
              images: [original],
              prompt: current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt,
            });
            const rawName = `${stageName}-${stage.attempts}-source.png`;
            await writeFile(path.join(dir, rawName), bytes);
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
          const garmentFile = path.join(dir, garmentName);
          const garment = { data: await readFile(garmentFile), mime: "image/png", name: "garment.png" };
          const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
          let modelData;
          try {
            modelData = await readFile(modelPath);
          } catch (error) {
            if (error.code === "ENOENT") {
              const fresh = await loadJob(current.id);
              fresh.stages.modeled.status = "skipped";
              fresh.status = "complete";
              await saveJob(fresh);
              return;
            }
            throw error;
          }
          const model = { data: modelData, mime: "image/png", name: "model.png" };
          const basePrompt = options.modeledPrompt || "Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.";
          if (key) {
            try {
              bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1536x1024", images: [model, garment], prompt: current.stages.modeled.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.modeled.prompt}` : basePrompt });
            } catch (modelError) {
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
        await writeFile(output, bytes);
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "review";
        fresh.stages[stageName].assetUrl = `${ASSET_ROOT}/${fresh.id}/${path.basename(output)}`;
        fresh.stages[stageName].failedAssetUrl = null;
        fresh.stages[stageName].cleanupPreviewUrl = null;
        fresh.stages[stageName].cleanupDiagnostics = null;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        fresh.stages[stageName].updatedAt = new Date().toISOString();
        await saveJob(fresh);
      } catch (error) {
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
        if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        await saveJob(fresh);
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/import/")) return next();
    try {
      if (url.pathname === "/api/import/wardrobes" && req.method === "GET") {
        return json(res, 200, await listWardrobes());
      }
      if (url.pathname === "/api/import/wardrobes" && req.method === "POST") {
        const input = await body(req);
        const profile = await createOrConnectWardrobe(input);
        return json(res, 200, { success: true, wardrobe: profile });
      }
      const wardrobeManageDeleteMatch = url.pathname.match(/^\/api\/import\/wardrobes\/([\w-]+)$/i);
      if (wardrobeManageDeleteMatch && req.method === "DELETE") {
        const targetId = wardrobeManageDeleteMatch[1];
        try {
          await deleteWardrobe(targetId);
          return json(res, 200, { deleted: true, id: targetId });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (url.pathname === "/api/import/wardrobe" && req.method === "GET") {
        const wId = resolveWardrobeId(req, url);
        return json(res, 200, await loadImported(wId));
      }
      if (url.pathname === "/api/import/config" && req.method === "GET") {
        const wId = resolveWardrobeId(req, url);
        return json(res, 200, await setupStatus(wId));
      }
      if (url.pathname === "/api/import/model-reference" && req.method === "POST") {
        const wId = resolveWardrobeId(req, url);
        try {
          const input = await body(req, 50 * 1024 * 1024);
          const image = decodeImage(input);
          const normalized = await normalizeImage(image.data);
          const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
          const referencePath = path.resolve(root, referenceSetting);
          await mkdir(path.dirname(referencePath), { recursive: true });
          await writeFile(referencePath, normalized);

          const { dir: wDir } = getWardrobePaths(wId);
          if (wDir) {
            await mkdir(wDir, { recursive: true });
            await writeFile(path.join(wDir, "model-reference.png"), normalized);
          }

          const status = await setupStatus(wId);
          json(res, 200, { success: true, ...status, wardrobeId: wId });

          // Run batch updates in background without blocking response
          setImmediate(async () => {
            try {
              const { importedFile: wImportedFile } = getWardrobePaths(wId);
              const records = await loadImported(wId);
              let changed = false;
              for (const item of records) {
                const garmentPath = path.join(libraryAssetDir, `${item.id}-garment.png`);
                try {
                  const garmentBuf = await readFile(garmentPath);
                  const modeledBuf = await fitItemOnModel(normalized, garmentBuf, item);
                  const modeledPath = path.join(libraryAssetDir, `${item.id}-modeled.png`);
                  await writeFile(modeledPath, modeledBuf);
                  item.modeledImage = `${LIBRARY_ASSET_ROOT}/${item.id}-modeled.png?t=${Date.now()}`;
                  changed = true;
                } catch (_) {}
              }
              if (changed) {
                await atomicJson(wImportedFile, records);
              }
            } catch (updateErr) {
              console.warn("Could not batch update modeled photos:", updateErr.message);
            }
          });
          return;
        } catch (uploadErr) {
          console.error("Model reference upload failed:", uploadErr);
          return json(res, 400, { error: uploadErr.message || "שגיאה בעיבוד תמונת המודל" });
        }
      }
      if (url.pathname === "/api/import/model-reference" && (req.method === "GET" || req.method === "HEAD")) {
        const wId = resolveWardrobeId(req, url);
        const { dir: wDir } = getWardrobePaths(wId);
        const wRefPath = wDir ? path.join(wDir, "model-reference.png") : null;
        const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
        const referencePath = path.resolve(root, referenceSetting);
        try {
          let data = null;
          if (wRefPath) {
            try { data = await readFile(wRefPath); } catch {}
          }
          if (!data) {
            data = await readFile(referencePath);
          }
          res.setHeader("Content-Type", "image/png");
          return res.end(data);
        } catch {
          return json(res, 404, { error: "No model reference photo found" });
        }
      }
      const wardrobeDeleteMatch = url.pathname.match(/^\/api\/import\/wardrobe\/([\w-]+)$/i);
      if (wardrobeDeleteMatch && req.method === "DELETE") {
        const id = wardrobeDeleteMatch[1];
        const wId = resolveWardrobeId(req, url);
        const { importedFile: wImportedFile } = getWardrobePaths(wId);
        const records = await loadImported(wId);
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "Wardrobe item not found" });
        await atomicJson(wImportedFile, next);
        await Promise.all([
          rm(path.join(libraryAssetDir, `${id}-garment.png`), { force: true }).catch(() => {}),
          rm(path.join(libraryAssetDir, `${id}-modeled.png`), { force: true }).catch(() => {}),
        ]);
        return json(res, 200, { deleted: true, id });
      }
      const wardrobeUpdateMatch = url.pathname.match(/^\/api\/import\/wardrobe\/([\w-]+)$/i);
      if (wardrobeUpdateMatch && (req.method === "PUT" || req.method === "PATCH")) {
        const id = wardrobeUpdateMatch[1];
        const wId = resolveWardrobeId(req, url);
        const { importedFile: wImportedFile } = getWardrobePaths(wId);
        const input = await body(req);
        const records = await loadImported(wId);
        const index = records.findIndex((record) => record.id === id);
        if (index === -1) return json(res, 404, { error: "Wardrobe item not found" });
        records[index] = {
          ...records[index],
          ...input,
          id,
          updatedAt: new Date().toISOString(),
        };
        await atomicJson(wImportedFile, records);
        return json(res, 200, records[index]);
      }
      const wardrobeModeledMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/modeled$/i);
      if (wardrobeModeledMatch && req.method === "POST") {
        const id = wardrobeModeledMatch[1];
        const wId = resolveWardrobeId(req, url);
        const { importedFile: wImportedFile } = getWardrobePaths(wId);
        const records = await loadImported(wId);
        const record = records.find((item) => item.id === id);
        if (!record) return json(res, 404, { error: "Wardrobe item not found" });

        const setup = await setupStatus();
        if (!setup.hasModelReference) {
          return json(res, 400, { error: "Reference photo is required. Please upload your reference photo first so the AI can model the look on you." });
        }
        const key = setting("OPENAI_API_KEY");
        const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
        const modelData = await readFile(modelPath);
        const garmentFile = path.join(libraryAssetDir, `${id}-garment.png`);
        const garmentData = await readFile(garmentFile);

        const model = { data: modelData, mime: "image/png", name: "model.png" };
        const garment = { data: garmentData, mime: "image/png", name: "garment.png" };
        const basePrompt = `Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail (${record.name}, ${record.part}). Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.`;

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
              quality: setting("OPENAI_IMAGE_QUALITY", "high"),
              size: "1536x1024",
              images: [model, garment],
              prompt: basePrompt,
            });
          } catch (modelError) {
            bytes = await fitItemOnModel(model.data, garment.data, {
              name: record.name,
              part: record.part,
            });
          }
        }

        const modeledName = `${id}-modeled.png`;
        await writeFile(path.join(libraryAssetDir, modeledName), bytes);
        record.modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}?t=${Date.now()}`;
        await atomicJson(wImportedFile, records);

        return json(res, 200, record);
      }
      if (url.pathname === "/api/import/outfits/preview-flatlay" && req.method === "POST") {
        const input = await body(req);
        const wId = resolveWardrobeId(req, url);
        const garmentIds = Array.isArray(input.garmentIds) ? input.garmentIds : [];
        const records = await loadImported(wId);
        const selectedGarments = garmentIds.map((id) => records.find((item) => item.id === id)).filter(Boolean);
        const garmentEntries = [];
        for (const g of selectedGarments) {
          const garmentPath = path.join(libraryAssetDir, `${g.id}-garment.png`);
          try {
            const buffer = await readFile(garmentPath);
            garmentEntries.push({ buffer, item: g });
          } catch (_) {}
        }
        if (!garmentEntries.length) {
          return json(res, 400, { error: "יש לבחור לפחות פריט אחד מהמלתחה." });
        }
        const bytes = await generateFlatLayOutfit(garmentEntries);
        const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
        return json(res, 200, { image: dataUrl });
      }
      if (url.pathname === "/api/import/outfits" && req.method === "GET") {
        const wId = resolveWardrobeId(req, url);
        const outfits = await loadOutfits(wId);
        return json(res, 200, outfits.map((o) => ({
          ...o,
          image: o.image?.startsWith("outfit-images/")
            ? `/api/import/outfits/images/${path.basename(o.image)}`
            : o.image,
        })));
      }
      if (url.pathname === "/api/import/outfits/ai-complete" && req.method === "POST") {
        const input = await body(req);
        const wId = resolveWardrobeId(req, url);
        const result = await completeOutfitWithAI({ ...input, wardrobeId: wId });
        return json(res, 200, result);
      }
      if (url.pathname === "/api/import/outfits/auto-generate" && req.method === "POST") {
        const input = await body(req);
        const wId = resolveWardrobeId(req, url);
        const created = await autoGenerateOutfits({ ...input, wardrobeId: wId });
        return json(res, 200, created);
      }
      if (url.pathname === "/api/import/outfits/generate" && req.method === "POST") {
        const input = await body(req);
        const wId = resolveWardrobeId(req, url);
        const outfit = await generateOutfitLook({ ...input, wardrobeId: wId });
        return json(res, 200, outfit);
      }
      if (url.pathname === "/api/import/outfits/save" && req.method === "POST") {
        const input = await body(req);
        const wId = resolveWardrobeId(req, url);
        const outfit = await saveCustomOutfit(input.outfit || input, wId);
        return json(res, 200, outfit);
      }
      const outfitDeleteMatch = url.pathname.match(/^\/api\/import\/outfits\/([\w-]+)$/i);
      if (outfitDeleteMatch && req.method === "DELETE") {
        const id = outfitDeleteMatch[1];
        const wId = resolveWardrobeId(req, url);
        const outfits = await loadOutfits(wId);
        const next = outfits.filter((o) => o.id !== id);
        await saveOutfits(wId, next);
        await rm(path.join(outfitsAssetDir, `${id}.png`), { force: true });
        return json(res, 200, { deleted: true, id });
      }
      if (url.pathname === "/api/import/suitcases" && req.method === "GET") {
        const wId = resolveWardrobeId(req, url);
        const suitcases = await loadSuitcases(wId);
        return json(res, 200, suitcases);
      }
      if (url.pathname === "/api/import/suitcases" && req.method === "POST") {
        const input = await body(req);
        const wId = resolveWardrobeId(req, url);
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
        return json(res, 200, suitcase);
      }
      const suitcaseDeleteMatch = url.pathname.match(/^\/api\/import\/suitcases\/([\w-]+)$/i);
      if (suitcaseDeleteMatch && req.method === "DELETE") {
        const id = suitcaseDeleteMatch[1];
        const wId = resolveWardrobeId(req, url);
        const suitcases = await loadSuitcases(wId);
        const next = suitcases.filter((s) => s.id !== id);
        await saveSuitcases(wId, next);
        return json(res, 200, { deleted: true, id });
      }
      if (url.pathname === "/api/import/user" && req.method === "GET") {
        const wId = resolveWardrobeId(req, url);
        const user = await loadUserProfile(wId);
        return json(res, 200, user);
      }
      if (url.pathname === "/api/import/user" && req.method === "POST") {
        const input = await body(req);
        const wId = resolveWardrobeId(req, url);
        const current = await loadUserProfile(wId);
        const updated = { ...current, ...input, lastSync: new Date().toISOString() };
        await saveUserProfile(wId, updated);
        return json(res, 200, updated);
      }
      if (url.pathname === "/api/import/user/sync" && req.method === "POST") {
        const input = await body(req);
        const userSyncFile = path.join(dataDir, "user-sync.json");
        const current = await (async () => {
          try { return JSON.parse(await readFile(userSyncFile, "utf8")); } catch { return {}; }
        })();
        const merged = { ...current, ...input, syncedAt: new Date().toISOString() };
        await atomicJson(userSyncFile, merged);
        return json(res, 200, merged);
      }
      if (url.pathname === "/api/import/user/sync" && req.method === "GET") {
        const userSyncFile = path.join(dataDir, "user-sync.json");
        try {
          const data = JSON.parse(await readFile(userSyncFile, "utf8"));
          return json(res, 200, data);
        } catch {
          return json(res, 200, {});
        }
      }
      const outfitImageMatch = url.pathname.match(/^\/api\/import\/outfits\/images\/([\w.-]+)$/i) || url.pathname.match(/^\/outfit-images\/([\w.-]+)$/i);
      if (outfitImageMatch && req.method === "GET") {
        const file = path.join(outfitsAssetDir, path.basename(outfitImageMatch[1]));
        try {
          const data = await readFile(file);
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          return res.end(data);
        } catch {
          return json(res, 404, { error: "Outfit image not found" });
        }
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && req.method === "GET") {
        const file = path.join(libraryAssetDir, path.basename(libraryAssetMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }
      const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const file = path.join(jobsDir, assetMatch[1], path.basename(assetMatch[2]));
        await stat(file);
        res.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.end(await readFile(file));
      }
      if (url.pathname === API_ROOT && req.method === "POST") {
        const wId = resolveWardrobeId(req, url);
        const input = await body(req);
        const image = decodeImage(input);
        const normalizedImage = await normalizeImage(image.data);
        const key = setting("OPENAI_API_KEY");
        let detected = [];
        if (process.env.GEMINI_API_KEY) {
          try {
            detected = (await geminiAnalyze({ image: normalizedImage, mime: "image/png" })).map(normalizeMetadata);
          } catch {}
        }
        if (!detected.length && key) {
          try {
            detected = (await openAIAnalyze({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-4o-mini"), image: normalizedImage, mime: "image/png" })).map(normalizeMetadata);
          } catch {}
        }
        if (!detected.length) {
          let dominantHex = "#d8d0c2";
          try {
            const stats = await sharp(normalizedImage).stats();
            const [r, g, b] = stats.channels.slice(0, 3).map((ch) => Math.round(ch.mean));
            dominantHex = `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
          } catch {}
          detected = [normalizeMetadata({
            name: input.metadata?.name || "New piece",
            part: "upperbody",
            color: dominantHex,
            boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
            tags: ["casual"],
          })];
        }
        const jobs = [];
        for (const metadata of detected) {
          const id = randomUUID();
          const dir = path.join(jobsDir, id); await mkdir(dir, { recursive: true });
          const originalFile = "original.png";
          const cropFile = "crop.png";
          const croppedImage = await cropDetectedItem(normalizedImage, metadata.boundingBox);
          await writeFile(path.join(dir, originalFile), normalizedImage);
          await writeFile(path.join(dir, cropFile), croppedImage);
          const now = new Date().toISOString();
          const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
          const job = { id, wardrobeId: wId, status: "active", metadata, stages: { crop: cropStage, garment: stageState(), modeled: stageState() }, createdAt: now, updatedAt: now, internal: { originalFile, cropFile, originalMime: "image/png" } };
          job.originalAssetUrl = `${ASSET_ROOT}/${id}/${originalFile}`;
          await saveJob(job); jobs.push(publicJob(job));
        }
        return json(res, 202, { jobs, noClothingDetected: jobs.length === 0 });
      }
      if (url.pathname === API_ROOT && req.method === "GET") {
        const ids = await readdir(jobsDir).catch(() => []);
        const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter(Boolean);
        const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected");
        await Promise.all(hiddenJobs.map((job) => rm(path.join(jobsDir, job.id), { recursive: true, force: true })));
        const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(res, 200, jobs.map(publicJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(res, 404, { error: "Not found" });
      const job = await loadJob(match[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      const action = match[2] || "";
      if (!action && req.method === "GET") return json(res, 200, publicJob(job));
      if (!action && req.method === "DELETE") {
        await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
        const input = await body(req);
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
        job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata }); await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
      if (cleanupAction && req.method === "POST") {
        const stage = job.stages.garment;
        if (stage.status !== "failed" || !stage.failedAssetUrl) {
          throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
        }
        const input = await body(req);
        const tolerance = cleanupTolerance(input.tolerance);
        const sourceName = path.basename(new URL(stage.failedAssetUrl, "http://localhost").pathname);
        const source = await readFile(path.join(jobsDir, job.id, sourceName));
        const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
        const cleaned = await processChromaBackground(source, key, { tolerance });
        const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
        const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
        await writeFile(path.join(jobsDir, job.id, previewName), cleaned.bytes);
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
        return json(res, 200, publicJob(job));
      }
      const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
      if (stageMatch && req.method === "POST") {
        const [, stageName, decision] = stageMatch;
        if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
        if (decision === "regenerate") {
          if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
          const input = await body(req);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job);
          void generate(job, stageName);
          return json(res, 202, publicJob(job));
        }
        if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const currentSetup = await setupStatus();
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending" && currentSetup.hasModelReference;
        if (stageName === "garment" && decision === "approve" && !currentSetup.hasModelReference) {
          job.stages.modeled.status = "skipped";
          job.status = "complete";
        }
        if (stageName === "modeled" && decision === "approve") job.status = "complete";
        await saveJob(job);
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
        if (decision === "reject") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        if (startGarment) void generate(job, "garment");
        if (startModeled) void generate(job, "modeled");
        const response = publicJob(job);
        if (job.status === "complete") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, response);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message, ...(process.env.NODE_ENV === "development" && statusCode === 500 ? { detail: error.message } : {}) });
    }
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      try {
        serverSettings = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
      } catch {
        serverSettings = {};
      }
      jobsDir = path.join(dataDir, "jobs");
      importedFile = path.join(dataDir, "library.json");
      libraryAssetDir = path.join(dataDir, "imported");
      outfitsFile = path.join(dataDir, "outfits.json");
      outfitsAssetDir = path.join(dataDir, "outfit-images");
      suitcasesFile = path.join(dataDir, "suitcases.json");
      userProfileFile = path.join(dataDir, "user-profile.json");
      await mkdir(jobsDir, { recursive: true });
      await mkdir(libraryAssetDir, { recursive: true });
      await mkdir(outfitsAssetDir, { recursive: true });
      const ids = await readdir(jobsDir).catch(() => []);
      for (const id of ids) {
        const job = await loadJob(id);
        if (!job) continue;
        if (job.status === "complete") {
          try {
            await persistImported(job, true);
            await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
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
          await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          continue;
        }
        if (job.stages.crop && job.stages.crop.status !== "approved") continue;
        if (["processing", "queued"].includes(job.stages.garment.status)) {
          job.stages.garment.status = "pending";
          await saveJob(job);
          void generate(job, "garment");
        } else if (job.stages.garment.status === "approved" && ["pending", "processing", "queued"].includes(job.stages.modeled.status)) {
          job.stages.modeled.status = "pending";
          await saveJob(job);
          void generate(job, "modeled");
        }
      }
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
