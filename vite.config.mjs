import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { wardrobeImportApi } from "./scripts/import-job-api.mjs";
import { responsiveImageApi } from "./scripts/responsive-image-api.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
    },
    plugins: [react(), responsiveImageApi(), wardrobeImportApi({ env })],
  };
});
