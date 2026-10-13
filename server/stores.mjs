import { mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Both stores expose the same small key/value interface. Keys are slash-separated
// paths relative to the data root, e.g. "library.json" or "jobs/<id>/crop.png".

function safeKey(key) {
  const normalized = String(key).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw Object.assign(new Error(`Invalid storage key: ${key}`), { status: 400 });
  }
  return normalized;
}

export function createFsStore(dataDir) {
  const file = (key) => path.join(dataDir, ...safeKey(key).split("/"));

  async function writeAtomic(target, data) {
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    try {
      await rename(tmp, target);
    } catch (error) {
      if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
        await rm(tmp, { force: true });
        throw error;
      }
      await copyFile(tmp, target);
      await rm(tmp, { force: true });
    }
  }

  async function read(key) {
    try { return await readFile(file(key)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  return {
    async getJSON(key) {
      const data = await read(key);
      return data ? JSON.parse(data.toString("utf8")) : null;
    },
    async setJSON(key, value) {
      await writeAtomic(file(key), `${JSON.stringify(value, null, 2)}\n`);
    },
    getBytes: read,
    async setBytes(key, bytes) {
      await writeAtomic(file(key), bytes);
    },
    async exists(key) {
      return Boolean((await stat(file(key)).catch(() => null))?.isFile());
    },
    async delete(key) {
      await rm(file(key), { force: true });
    },
    async deletePrefix(prefix) {
      await rm(file(prefix.replace(/\/+$/, "")), { recursive: true, force: true });
    },
    async listDirs(prefix) {
      const entries = await readdir(file(prefix), { withFileTypes: true }).catch(() => []);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    },
  };
}

export async function createBlobsStore(name = "wardrobe") {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name, consistency: "strong" });
  return {
    async getJSON(key) {
      return (await store.get(safeKey(key), { type: "json" })) ?? null;
    },
    async setJSON(key, value) {
      await store.setJSON(safeKey(key), value);
    },
    async getBytes(key) {
      const data = await store.get(safeKey(key), { type: "arrayBuffer" });
      return data ? Buffer.from(data) : null;
    },
    async setBytes(key, bytes) {
      await store.set(safeKey(key), new Blob([bytes]));
    },
    async exists(key) {
      return Boolean(await store.getMetadata(safeKey(key)));
    },
    async delete(key) {
      await store.delete(safeKey(key));
    },
    async deletePrefix(prefix) {
      const { blobs } = await store.list({ prefix: `${safeKey(prefix.replace(/\/+$/, ""))}/` });
      await Promise.all(blobs.map((blob) => store.delete(blob.key)));
    },
    async listDirs(prefix) {
      const base = `${safeKey(prefix)}/`;
      const { directories } = await store.list({ prefix: base, directories: true });
      return directories
        .map((dir) => (dir.startsWith(base) ? dir.slice(base.length) : dir).replace(/\/+$/, ""))
        .filter((dir) => dir && !dir.includes("/"));
    },
  };
}
