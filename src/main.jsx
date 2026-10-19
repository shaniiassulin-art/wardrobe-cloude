import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { AuthGate } from "./AuthGate.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import "./styles.css";
import "./wardrobe-ui.css";
import "./soft-theme.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </React.StrictMode>,
);

// The site should never zoom. iPhone Safari ignores user-scalable=no in the
// viewport tag, so block pinch gestures here as well.
const stopZoom = (event) => event.preventDefault();
document.addEventListener("gesturestart", stopZoom, { passive: false });
document.addEventListener("gesturechange", stopZoom, { passive: false });
document.addEventListener("touchmove", (event) => {
  if (event.touches.length > 1 || (typeof event.scale === "number" && event.scale !== 1)) event.preventDefault();
}, { passive: false });

// After an update to the site, an open page may ask for a file that no longer
// exists. Reload once to get the new version instead of breaking.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  try {
    if (sessionStorage.getItem("reloaded-after-update")) return;
    sessionStorage.setItem("reloaded-after-update", "1");
  } catch {}
  window.location.reload();
});
window.addEventListener("load", () => {
  setTimeout(() => { try { sessionStorage.removeItem("reloaded-after-update"); } catch {} }, 10000);
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
