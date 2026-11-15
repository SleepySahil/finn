import { cacheGet, cacheSet, sha } from '../cache';
import { sleep } from '../util';
import type { Cost } from '../types';

/**
 * Model router. Three tiers, cheapest first:
 *
 *   tier 0  rules + arithmetic        classify filings, QoQ/YoY, signals, ratios      → no model
 *   fast    Flash-Lite class          read one document, return structured JSON        → bulk, cheap
 *   smart   Flash class               reason across documents (promised vs delivered)  → rare
 *
 * Every call is cached by (model tier, prompt, input) — a transcript is read once, ever.
 * Runs on free tiers: Gemini first (1M-token context fits a whole transcript), Groq as fallback
 * for short prompts. Model IDs are discovered from the API, so a new Flash release needs no code change.
 */
export type TierName = 'fast' | 'smart';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const gKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const qKey = () => process.env.GROQ_API_KEY || '';
export const llmAvailable = () => Boolean(gKey() || qKey());

// Rough list prices (USD per million tokens) so the cost meter means something even on a free key.
const PRICE: Record<TierName, [number, number]> = { fast: [0.1, 0.4], smart: [0.3, 2.5] };

export class Meter {
  calls = 0; cached = 0; tokIn = 0; tokOut = 0; usd = 0; models = new Set<string>();
  add(tier: TierName, model: string, tin: number, tout: number, hit: boolean) {
    if (hit) { this.cached++; return; }
    this.calls++; this.tokIn += tin; this.tokOut += tout; this.models.add(model);
    this.usd += (tin * PRICE[tier][0] + tout * PRICE[tier][1]) / 1e6;
  }
  cost(): Cost {
    return { calls: this.calls, cached: this.cached, tokIn: this.tokIn, tokOut: this.tokOut, usd: Math.round(this.usd * 1e5) / 1e5, models: [...this.models] };
  }
}
export const addCost = (a: Cost, b?: Cost): Cost =>
  !b ? a : { calls: a.calls + b.calls, cached: a.cached + b.cached, tokIn: a.tokIn + b.tokIn, tokOut: a.tokOut + b.tokOut, usd: Math.round((a.usd + b.usd) * 1e5) / 1e5, models: [...new Set([...a.models, ...b.models])] };
export const ZERO: Cost = { calls: 0, cached: 0, tokIn: 0, tokOut: 0, usd: 0, models: [] };

// ---------- model discovery ----------
let models: { fast: string; smart: string; at: number } | null = null;
const ver = (name: string) => Number((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);

export async function resolveModels(): Promise<{ fast: string; smart: string }> {
  if (models && Date.now() - models.at < 3600e3) return models;
  let fast = process.env.GEMINI_MODEL_FAST || '';
  let smart = process.env.GEMINI_MODEL_SMART || '';
  if ((!fast || !smart) && gKey()) {
    try {
      const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': gKey() }, cache: 'no-store' });
      const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const ok = (j.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n));           // stable text models only: no preview, image, tts, live
      const best = (re: RegExp) => ok.filter((n) => re.test(n)).sort((a, b) => ver(b) - ver(a))[0];
      fast ||= best(/flash-lite$/) || '';
      smart ||= best(/flash$/) || '';
    } catch {}
  }
  models = { fast: fast || 'gemini-flash-lite-latest', smart: smart || 'gemini-flash-latest', at: Date.now() };
  return models;
}

// ---------- pacing: free tiers are requests-per-minute limited ----------
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;
const GAP = Number(process.env.LLM_GAP_MS || 0);
function paced<T>(fn: () => Promise<T>): Promise<T> {
  if (!GAP) return fn();
  const run = chain.then(async () => {
    const wait = lastCall + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

export function parseJson<T>(raw: string): T {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s) as T; } catch {}
  const a = s.search(/[[{]/);
  const b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (a >= 0 && b > a) { s = s.slice(a, b + 1); return JSON.parse(s) as T; }
  throw new Error('Model did not return JSON');
}

interface Raw { text: string; tin: number; tout: number; model: string }

async function gemini(model: string, system: string, user: string, json: boolean, maxOut: number, pdf?: Uint8Array, ground?: boolean): Promise<Raw> {
  const parts: unknown[] = [];
  if (pdf) parts.push({ inlineData: { mimeType: 'application/pdf', data: Buffer.from(pdf).toString('base64') } });
  parts.push({ text: user });
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: maxOut, ...(json && !ground ? { responseMimeType: 'application/json' } : {}) },
  };
  if (ground) body.tools = [{ google_search: {} }];
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${GEMINI}/models/${model}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': gKey(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
      signal: AbortSignal.timeout(55000),
    });
    if (r.ok) {
      const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
      const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error(`${model} returned an empty answer`);
      const u = j.usageMetadata || {};
      return { text, tin: u.promptTokenCount || 0, tout: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), model };
    }
    const err = await r.text();
    if ((r.status === 429 || r.status === 503) && attempt < 2 && !/per ?day|PerDay/i.test(err)) {
      const m = err.match(/"retryDelay":\s*"(\d+)/);
      await sleep(Math.min(40000, (m ? Number(m[1]) : 6 * (attempt + 1)) * 1000 + 500));
      continue;
    }
    throw new Error(`${model} ${r.status}: ${err.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
}

async function groq(system: string, user: string, json: boolean, maxOut: number): Promise<Raw> {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${qKey()}`, 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ model, temperature: 0.1, max_tokens: maxOut, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    signal: AbortSignal.timeout(40000),
  });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = (await r.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
  return { text: j.choices[0].message.content, tin: j.usage?.prompt_tokens || 0, tout: j.usage?.completion_tokens || 0, model };
}

export interface AskOpts {
  tier: TierName;
  system: string;
  user: string;
  meter: Meter;
  version: string;            // bump to invalidate cached answers for this prompt
  json?: boolean;
  maxOut?: number;
  pdf?: Uint8Array;           // scanned filing: let a multimodal model read the pages
  ground?: boolean;           // web search — push-side enrichment only, never research
  ttl?: number;
}

/** Ask a model for structured output. Cached, paced, with a fallback chain. Throws only if every route fails. */
export async function ask<T = unknown>(o: AskOpts): Promise<T> {
  const json = o.json !== false;
  const key = `llm:${o.version}:${o.tier}:${sha(o.system)}:${sha(o.user)}:${o.pdf ? o.pdf.length : 0}`;
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) { o.meter.add(o.tier, 'cache', 0, 0, true); return hit; }
  if (!llmAvailable()) throw new Error('No model key configured');

  const m = await resolveModels();
  const maxOut = o.maxOut ?? (o.tier === 'smart' ? 8192 : 4096);
  const routes: (() => Promise<Raw>)[] = [];
  if (gKey()) {
    const order = o.tier === 'smart' ? [m.smart, m.fast] : [m.fast, m.smart];
    for (const model of order) routes.push(() => gemini(model, o.system, o.user, json, maxOut, o.pdf, o.ground));
  }
  // Groq's free tier caps tokens per minute, so it only takes prompts that fit.
  if (qKey() && !o.pdf && !o.ground && o.system.length + o.user.length < 20000) routes.push(() => groq(o.system, o.user, json, Math.min(maxOut, 4096)));

  let last: unknown;
  for (const route of routes) {
    try {
      const raw = await paced(route);
      const data = (json ? parseJson<T>(raw.text) : (raw.text as unknown as T));
      o.meter.add(o.tier, raw.model, raw.tin, raw.tout, false);
      await cacheSet(key, data, o.ttl ?? 365 * 86400);
      return data;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('All model routes failed');
}
