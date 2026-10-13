import { removeBackground } from "@imgly/background-removal";

// Runs the background-removal model off the main thread so the page stays
// responsive while a photo is processed (inference takes several seconds).
self.onmessage = async ({ data }) => {
  try {
    const cutout = await removeBackground(data.blob, {
      model: "isnet_quint8",
      output: { format: "image/png" },
      progress: (key, current, total) => self.postMessage({ type: "progress", key, current, total }),
    });
    self.postMessage({ type: "done", blob: cutout });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};
