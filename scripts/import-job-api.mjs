import path from "node:path";
import { authGate } from "../server/auth.mjs";
import { createFsStore } from "../server/stores.mjs";
import { createWardrobeApi } from "../server/wardrobe-api.mjs";

// Vite dev/preview adapter: serves the wardrobe API from the local data/ folder.
// Slow work (AI generation) runs in-process; there is no request time limit here.

async function toWebRequest(req) {
  const url = `http://${req.headers.host || "localhost"}${req.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function wardrobeImportApi(options = {}) {
  let api;
  const password = () => options.env?.APP_PASSWORD || process.env.APP_PASSWORD || "";

  async function handler(req, res, next) {
    if (!req.url.startsWith("/api/import/")) return next();
    try {
      const request = await toWebRequest(req);
      const response = (await authGate(request, password())) || (await api.handle(request));
      if (!response) return next();
      return sendWebResponse(res, response);
    } catch (error) {
      console.error(error);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      const dataDir = path.resolve(config.root, options.env?.WARDROBE_DATA_DIR || process.env.WARDROBE_DATA_DIR || "data");
      api = createWardrobeApi({
        store: createFsStore(dataDir),
        env: options.env,
        defer: async (task) => {
          void api.runDeferred(task).catch((error) => console.error("Background task failed:", error));
        },
      });
      await api.resumeJobs();
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
