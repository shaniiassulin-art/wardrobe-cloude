import { deriveToken, safeEqual } from "../../server/auth.mjs";
import { createBlobsStore } from "../../server/stores.mjs";
import { createWardrobeApi } from "../../server/wardrobe-api.mjs";

// Background function (up to 15 minutes): runs AI generation and other slow tasks
// queued by the api function. Errors are caught so Netlify does not retry them.

export default async (request) => {
  const password = process.env.APP_PASSWORD;
  if (!password || !safeEqual(request.headers.get("x-worker-token"), deriveToken(password, "worker"))) {
    console.warn("Rejected background task without a valid worker token");
    return;
  }

  try {
    const task = await request.json();
    const api = createWardrobeApi({
      store: await createBlobsStore(),
      // Already in the background: run follow-up work inline
      defer: (next) => api.runDeferred(next),
    });
    await api.runDeferred(task);
  } catch (error) {
    console.error("Background task failed:", error);
  }
};
