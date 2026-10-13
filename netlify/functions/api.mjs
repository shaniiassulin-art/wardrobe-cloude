import { authGate, deriveToken } from "../../server/auth.mjs";
import { createBlobsStore } from "../../server/stores.mjs";
import { createWardrobeApi } from "../../server/wardrobe-api.mjs";

// Serves /api/import/* on Netlify. Data lives in Netlify Blobs, and anything that
// can outlast the 60-second request limit is handed to worker-background.

async function invokeWorker(origin, password, task) {
  const response = await fetch(new URL("/.netlify/functions/worker-background", origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-token": deriveToken(password, "worker") },
    body: JSON.stringify(task),
  });
  if (response.status !== 202 && !response.ok) {
    throw new Error(`Background worker unavailable (${response.status})`);
  }
}

export default async (request) => {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return Response.json({ error: "APP_PASSWORD is not set in the Netlify environment variables." }, { status: 500 });
  }

  const gate = await authGate(request, password);
  if (gate) return gate;

  const origin = new URL(request.url).origin;
  const api = createWardrobeApi({
    store: await createBlobsStore(),
    defer: (task) => invokeWorker(origin, password, task),
  });

  if (api.isLongRequest(request)) return api.enqueueRequest(request);
  return (await api.handle(request)) || Response.json({ error: "Not found" }, { status: 404 });
};

export const config = {
  path: "/api/import/*",
};
