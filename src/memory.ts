import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "redis";
import { config } from "./config.js";
import type { MemoryHit } from "./types.js";

type StoredBug = {
  id: string;
  text: string;
  createdAt: string;
};

function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function similarity(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 || B.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const t of A) {
    if (B.has(t)) {
      inter += 1;
    }
  }
  return inter / Math.sqrt(A.size * B.size);
}

async function loadFileStore(): Promise<StoredBug[]> {
  try {
    const raw = await readFile(config.memoryFile, "utf8");
    return JSON.parse(raw) as StoredBug[];
  } catch {
    return [];
  }
}

async function saveFileStore(rows: StoredBug[]) {
  await writeFile(config.memoryFile, JSON.stringify(rows, null, 2), "utf8");
}

export async function findSimilarBugs(text: string, days = 30): Promise<MemoryHit[]> {
  const cutoff = Date.now() - days * 86_400_000;
  if (config.redisUrl) {
    try {
      return await findSimilarRedis(text, cutoff);
    } catch (e) {
      console.warn("[memory] Redis unavailable, using file store:", e);
    }
  }
  const rows = await loadFileStore();
  const hits: MemoryHit[] = [];
  for (const row of rows) {
    const ts = Date.parse(row.createdAt);
    if (ts < cutoff) {
      continue;
    }
    const sim = similarity(text, row.text);
    if (sim > 0.25) {
      hits.push({
        id: row.id,
        summary: row.text.slice(0, 200),
        similarity: sim,
        createdAt: row.createdAt,
      });
    }
  }
  return hits.toSorted((a, b) => b.similarity - a.similarity).slice(0, 5);
}

async function findSimilarRedis(text: string, cutoffMs: number): Promise<MemoryHit[]> {
  const client = createClient({ url: config.redisUrl });
  await client.connect();
  try {
    const pattern = `${config.redisPrefix}:*`;
    const keys: string[] = [];
    for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      keys.push(key);
    }
    const hits: MemoryHit[] = [];
    for (const key of keys) {
      const raw = await client.get(key);
      if (!raw) {
        continue;
      }
      const row = JSON.parse(raw) as StoredBug;
      const ts = Date.parse(row.createdAt);
      if (ts < cutoffMs) {
        continue;
      }
      const sim = similarity(text, row.text);
      if (sim > 0.25) {
        hits.push({
          id: row.id,
          summary: row.text.slice(0, 200),
          similarity: sim,
          createdAt: row.createdAt,
        });
      }
    }
    return hits.toSorted((a, b) => b.similarity - a.similarity).slice(0, 5);
  } finally {
    await client.quit().catch(() => {});
  }
}

export async function recordBugFingerprint(text: string): Promise<string> {
  const id = `bug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const row: StoredBug = { id, text, createdAt: new Date().toISOString() };

  if (config.redisUrl) {
    try {
      const client = createClient({ url: config.redisUrl });
      await client.connect();
      try {
        await client.set(`${config.redisPrefix}:${id}`, JSON.stringify(row));
      } finally {
        await client.quit().catch(() => {});
      }
      return id;
    } catch (e) {
      console.warn("[memory] Redis write failed, using file:", e);
    }
  }
  const all = await loadFileStore();
  all.push(row);
  await saveFileStore(all);
  return id;
}
