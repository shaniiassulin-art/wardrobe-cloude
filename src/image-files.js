// iPhone photos are often HEIC. Chrome on Windows/Android cannot decode them (and
// sometimes reports an empty MIME type), so convert them to JPEG before upload.

export const isHeic = (file) => /image\/hei[cf]/i.test(file?.type || "") || /\.(heic|heif)$/i.test(file?.name || "");

export const isImageFile = (file) =>
  Boolean(file) && ((file.type || "").startsWith("image/") || isHeic(file) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name || ""));

export async function toBrowserImage(file) {
  if (!isHeic(file)) return file;
  const { default: heic2any } = await import("heic2any");
  let converted;
  try {
    converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  } catch {
    throw new Error(`לא הצלחנו לפתוח את ${file.name} (קובץ HEIC). נסו לייצא אותו כ-JPG ולהעלות שוב.`);
  }
  const blob = Array.isArray(converted) ? converted[0] : converted;
  return new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), { type: "image/jpeg" });
}

// Wardrobe garment images, cropped and centred by the server so all items look
// the same size. Other images (photos on the model, outfits) are left as they are.
export function fittedImage(url) {
  if (typeof url !== "string" || !url.startsWith("/api/import/library/") || !url.split("?")[0].endsWith("-garment.png")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}fit=1`;
}

// Small copy of a stored photo, `width` pixels wide (served as WebP by the server)
export function thumbUrl(url, width = 320) {
  if (typeof url !== "string") return url;
  const path = url.split(/[?#]/, 1)[0];
  if (!path.startsWith("/api/import/library/") && !path.startsWith("/api/import/outfits/images/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}

// If a small copy cannot load, show the original photo instead (once)
export const imageFallback = (plain) => (event) => {
  const image = event.currentTarget;
  if (!plain || image.dataset.fellBack) return;
  image.dataset.fellBack = "1";
  image.removeAttribute("srcset");
  image.src = plain;
};

// A photo picked by the user, turned into a JPEG data URL no larger than `max`
// pixels on its longest side (small enough to upload quickly)
export async function fileToUploadDataUrl(file, max = 1600, quality = 0.88) {
  const source = await toBrowserImage(file);
  const bitmap = await createImageBitmap(source).catch(() => null);
  const image = bitmap || await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("לא ניתן לפתוח את התמונה."));
    element.src = URL.createObjectURL(source);
  });
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  const scale = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

// Copies text, with a fallback for browsers without the clipboard API
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  }
}
