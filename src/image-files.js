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
