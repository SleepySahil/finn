import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * Content-addressed JSON cache. Filings, transcripts and annual reports never change once
 * filed, so anything derived from one (text, extraction, summary) is cached forever under
 * a key of (kind, source URL, prompt version). Layers: memory → disk (.cache locally, /tmp
 * on serverless). The committed snapshot in public/snapshot is the third, read-only layer.
 */
const mem = new Map<string, { v: unknown; exp: number }>();
const DIR = process.env.FINN_CACHE_DIR || (process.env.VERCEL ? '/tmp/finn-cache' : path.join(process.cwd(), '.cache'));

const file = (key: string) => path.join(DIR, `${sha(key)}.json`);

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const m = mem.get(key);
  if (m && m.exp > Date.now()) return m.v as T;
  try {
    const raw = JSON.parse(await fs.readFile(file(key), 'utf8')) as { v: T; exp: number };
    if (raw.exp > Date.now()) {
      mem.set(key, raw);
      return raw.v;
    }
  } catch {}
  return undefined;
}

export async function cacheSet<T>(key: string, v: T, ttlSec = 365 * 86400): Promise<void> {
  const rec = { v, exp: Date.now() + ttlSec * 1000 };
  mem.set(key, rec);
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(file(key), JSON.stringify(rec));
  } catch {}
}

export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<{ v: T; hit: boolean }> {
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return { v: hit, hit: true };
  const v = await fn();
  await cacheSet(key, v, ttlSec);
  return { v, hit: false };
}

// ---- committed snapshot (works with zero network and zero keys) ----
const SNAP = path.join(process.cwd(), 'public', 'snapshot');
export async function snapRead<T>(rel: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(SNAP, rel), 'utf8')) as T;
  } catch {
    return undefined;
  }
}
export async function snapWrite(rel: string, v: unknown): Promise<void> {
  const p = path.join(SNAP, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(v));
}
