import * as ort from "onnxruntime-web";
import { removeBackground } from "@imgly/background-removal";

// Free import, fully on this device:
// 1. @imgly/background-removal gives a clean matte of the subject (good edges).
// 2. A SegFormer clothes-parsing model labels every pixel (shirt, pants, face,
//    hair, arms, bag...). Each garment becomes its own cutout, so faces, skin
//    and accessories are dropped.
// Photos without a person (a garment laid flat) keep the plain matte.

const SEGMENTER_URL = "https://huggingface.co/Xenova/segformer_b2_clothes/resolve/main/onnx/model_quantized.onnx";
const MODEL_CACHE = "wardrobe-models-v1";
const SIZE = 512;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Label ids from mattmdjaga/segformer_b2_clothes
const PERSON_LABELS = [2, 11, 12, 13, 14, 15]; // hair, face, legs, arms
const GARMENTS = [
  { labels: [7], part: "dress", name: "שמלה" },
  { labels: [4], part: "upperbody", name: "חולצה" },
  { labels: [6], part: "lowerbody", name: "מכנסיים" },
  { labels: [5], part: "lowerbody", name: "חצאית" },
  { labels: [9, 10], part: "shoes", name: "נעליים", minShare: 0.003 },
];
const MIN_GARMENT_SHARE = 0.015;
// Garment probability that maps to fully opaque / fully transparent. A strict
// window keeps hands and arms resting on a garment out of the cutout.
const MASK_LOW = 0.5;
const MASK_HIGH = 0.7;
const MIN_PERSON_SHARE = 0.01;

const progress = (key, current, total) => self.postMessage({ type: "progress", key, current, total });

async function loadSegmenter() {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  let response = await cache?.match(SEGMENTER_URL);
  if (!response) {
    const download = await fetch(SEGMENTER_URL);
    if (!download.ok) throw new Error(`Could not download the clothes model (${download.status})`);
    const total = Number(download.headers.get("content-length")) || 0;
    const reader = download.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) progress("fetch:clothes-model", received, total);
    }
    response = new Response(new Blob(chunks));
    await cache?.put(SEGMENTER_URL, response.clone()).catch(() => {});
  }
  return ort.InferenceSession.create(new Uint8Array(await response.arrayBuffer()), { executionProviders: ["wasm"] });
}

function pixelsOf(bitmap, width = bitmap.width, height = bitmap.height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

// Returns per-label probabilities at the model's output resolution
async function segment(session, bitmap) {
  const { data } = pixelsOf(bitmap, SIZE, SIZE);
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0, p = 0; p < SIZE * SIZE; i += 4, p += 1) {
    for (let c = 0; c < 3; c += 1) input[c * SIZE * SIZE + p] = (data[i + c] / 255 - MEAN[c]) / STD[c];
  }
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) };
  const output = (await session.run(feeds))[session.outputNames[0]];
  const [, labels, height, width] = output.dims;
  const logits = output.data;
  const plane = width * height;
  const probs = new Float32Array(labels * plane);
  for (let p = 0; p < plane; p += 1) {
    let max = -Infinity;
    for (let l = 0; l < labels; l += 1) max = Math.max(max, logits[l * plane + p]);
    let sum = 0;
    for (let l = 0; l < labels; l += 1) sum += (probs[l * plane + p] = Math.exp(logits[l * plane + p] - max));
    for (let l = 0; l < labels; l += 1) probs[l * plane + p] /= sum;
  }
  return { probs, width, height, plane };
}

// Where each garment may sit on the body, as a fraction of the body height
// (0 = top of the head, 1 = feet). Pieces outside it are other objects.
const BODY_ZONES = { upperbody: [0, 0.65], lowerbody: [0.3, 1], shoes: [0.7, 1], dress: [0, 1] };

// Keeps the connected regions of a garment that are big enough and in the
// right body zone (drops e.g. a camera mistaken for a shoe)
function keepRegions(seg, labels, part) {
  const { width, height, plane } = seg;
  const inGroup = new Uint8Array(plane);
  let top = height, bottom = -1;
  for (let p = 0; p < plane; p += 1) {
    let value = 0;
    for (const label of labels) value += seg.probs[label * plane + p];
    inGroup[p] = value > 0.5 ? 1 : 0;
    if (seg.probs[p] < 0.5) { const y = Math.floor(p / width); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  const region = new Int32Array(plane).fill(-1);
  const regions = [];
  for (let start = 0; start < plane; start += 1) {
    if (!inGroup[start] || region[start] !== -1) continue;
    const id = regions.length;
    const stack = [start];
    region[start] = id;
    let area = 0, sumY = 0;
    while (stack.length) {
      const p = stack.pop();
      area += 1; sumY += Math.floor(p / width);
      const x = p % width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q >= 0 && q < plane && inGroup[q] && region[q] === -1) { region[q] = id; stack.push(q); }
      }
    }
    regions.push({ area, centerY: sumY / area });
  }
  const largest = Math.max(0, ...regions.map((r) => r.area));
  const [zoneTop, zoneBottom] = BODY_ZONES[part] || [0, 1];
  const span = Math.max(1, bottom - top);
  const keep = regions.map((r) => {
    const t = (r.centerY - top) / span;
    return r.area >= largest * 0.12 && t >= zoneTop && t <= zoneBottom;
  });
  const out = new Uint8Array(plane);
  for (let p = 0; p < plane; p += 1) {
    // Keep soft edges next to kept regions, drop everything belonging to dropped ones
    out[p] = region[p] === -1 ? 1 : keep[region[p]] ? 1 : 0;
  }
  return out;
}

// Soft mask for a group of labels, upscaled smoothly to the photo size
function groupMask(seg, labels, width, height, keep) {
  const small = new ImageData(seg.width, seg.height);
  for (let p = 0; p < seg.plane; p += 1) {
    if (keep && !keep[p]) continue;
    let value = 0;
    for (const label of labels) value += seg.probs[label * seg.plane + p];
    const level = Math.round(Math.max(0, Math.min(1, (value - MASK_LOW) / (MASK_HIGH - MASK_LOW))) * 255);
    small.data[p * 4 + 3] = level;
  }
  const smallCanvas = new OffscreenCanvas(seg.width, seg.height);
  smallCanvas.getContext("2d").putImageData(small, 0, 0);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(smallCanvas, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const mask = new Uint8ClampedArray(width * height);
  for (let p = 0; p < mask.length; p += 1) mask[p] = data[p * 4 + 3];
  return mask;
}

function share(seg, labels) {
  let total = 0;
  for (let p = 0; p < seg.plane; p += 1) {
    let value = 0;
    for (const label of labels) value += seg.probs[label * seg.plane + p];
    if (value > 0.5) total += 1;
  }
  return total / seg.plane;
}

function hex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

// Crops the visible part of an RGBA image and returns it as a PNG plus its main colour
async function toCutout(rgba, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1, r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = rgba[i + 3];
      if (alpha <= 8) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (alpha > 200) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n += 1; }
    }
  }
  if (maxX < minX) return null;
  const full = new OffscreenCanvas(width, height);
  full.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const scale = Math.min(1, 1100 / Math.max(cropW, cropH));
  const out = new OffscreenCanvas(Math.max(1, Math.round(cropW * scale)), Math.max(1, Math.round(cropH * scale)));
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, minX, minY, cropW, cropH, 0, 0, out.width, out.height);
  return { blob: await out.convertToBlob({ type: "image/png" }), color: n ? hex(r / n, g / n, b / n) : null };
}

self.onmessage = async ({ data }) => {
  try {
    const bitmap = await createImageBitmap(data.blob);
    const { width, height } = bitmap;
    const original = pixelsOf(bitmap).data;

    const matteBlob = await removeBackground(data.blob, { model: "isnet_quint8", output: { format: "image/png" }, progress });
    const matte = pixelsOf(await createImageBitmap(matteBlob), width, height).data;

    let seg = null;
    try {
      progress("compute:clothes", 0, 1);
      seg = await segment(await loadSegmenter(), bitmap);
    } catch (error) {
      // Without the clothes model we still have a usable background-free cutout
      console.warn("Clothes segmentation unavailable:", error);
    }

    const garments = [];
    if (seg && share(seg, PERSON_LABELS) >= MIN_PERSON_SHARE) {
      for (const garment of GARMENTS) {
        if (share(seg, garment.labels) < (garment.minShare ?? MIN_GARMENT_SHARE)) continue;
        const mask = groupMask(seg, garment.labels, width, height, keepRegions(seg, garment.labels, garment.part));
        const rgba = new Uint8ClampedArray(original);
        for (let p = 0; p < mask.length; p += 1) rgba[p * 4 + 3] = Math.min(matte[p * 4 + 3], mask[p]);
        const cutout = await toCutout(rgba, width, height);
        if (cutout) garments.push({ part: garment.part, name: garment.name, ...cutout });
      }
    }

    if (!garments.length) {
      // No person in the photo (or nothing recognised): keep the whole matted subject
      const rgba = new Uint8ClampedArray(original);
      for (let p = 0; p < width * height; p += 1) rgba[p * 4 + 3] = matte[p * 4 + 3];
      const cutout = await toCutout(rgba, width, height);
      if (!cutout) throw new Error("לא נמצא בגד בתמונה. נסו תמונה של הבגד לבד על רקע פשוט.");
      let part = null;
      if (seg) {
        const best = GARMENTS.map((g) => ({ g, s: share(seg, g.labels) })).sort((a, b) => b.s - a.s)[0];
        if (best.s >= MIN_GARMENT_SHARE) part = best.g.part;
      }
      garments.push({ part, name: null, ...cutout });
    }

    self.postMessage({ type: "done", garments });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};
