import { UA, sleep } from './util';

export interface Opts { headers?: Record<string, string>; timeout?: number; retries?: number; revalidate?: number }

/** One fetch wrapper for every upstream: browser-like headers, hard timeout, small retry, Next data-cache hint. */
async function go(url: string, o: Opts = {}): Promise<Response> {
  const { timeout = 12000, retries = 1 } = o;
  let last: unknown;
  for (let a = 0; a <= retries; a++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const init: RequestInit & { next?: { revalidate: number } } = {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9', Accept: '*/*', ...o.headers },
        signal: ctl.signal,
        redirect: 'follow',
      };
      if (o.revalidate != null) init.next = { revalidate: o.revalidate };
      else init.cache = 'no-store';
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) throw new Error(`${r.status} from ${new URL(url).host}`);
      return r;
    } catch (e) {
      last = e;
      if (a < retries) await sleep(600 * (a + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function getText(url: string, o?: Opts): Promise<string> {
  const r = await go(url, o);
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.text();
}

export async function getJson<T = unknown>(url: string, o?: Opts): Promise<T> {
  const t = await getText(url, o);
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new Error(`Non-JSON from ${new URL(url).host}: ${t.slice(0, 80)}`);
  }
}

export async function getBytes(url: string, o?: Opts & { maxBytes?: number }): Promise<Uint8Array> {
  const r = await go(url, { timeout: 30000, ...o });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  const len = Number(r.headers.get('content-length') || 0);
  const max = o?.maxBytes ?? 45_000_000;
  if (len > max) throw new Error(`File is ${(len / 1e6).toFixed(0)} MB, over the ${(max / 1e6).toFixed(0)} MB cap`);
  return new Uint8Array(await r.arrayBuffer());
}
