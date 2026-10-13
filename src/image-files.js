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
