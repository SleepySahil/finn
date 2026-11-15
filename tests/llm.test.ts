import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// The model is replaced by a fake HTTP endpoint; everything around it (routing, discovery,
// caching, retries, cost metering, the map → reduce research pipeline) is the real code.
vi.mock('../src/lib/sources/pdf', async (orig) => ({
  ...(await orig<typeof import('../src/lib/sources/pdf')>()),
  pdfText: vi.fn(async () => ({ pages: ['Moderator: welcome', 'CFO: We expect revenue growth of 20 to 22 percent in FY26.', 'Q&A'], total: 3, scanned: false, bytes: 1000 })),
}));

const calls: { url: string; body?: any }[] = [];
let script: ((url: string, body: any) => { status?: number; json: unknown }) | null = null;
const gem = (text: unknown, tin = 1000, tout = 100) => ({ json: { candidates: [{ content: { parts: [{ text: typeof text === 'string' ? text : JSON.stringify(text) }] } }], usageMetadata: { promptTokenCount: tin, candidatesTokenCount: tout } } });

beforeEach(() => {
  calls.length = 0;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.FINN_CACHE_DIR = `/tmp/finn-test-cache-${Math.random().toString(36).slice(2)}`;
  delete process.env.GROQ_API_KEY;
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).includes('/models?')) return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.9-flash-preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] }));
    const r = script!(String(url), body);
    return new Response(JSON.stringify(r.json), { status: r.status || 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('model router', () => {
  it('discovers the newest stable Flash and Flash-Lite, ignoring previews and image models', async () => {
    const { resolveModels } = await import('../src/lib/llm/router');
    expect(await resolveModels()).toMatchObject({ fast: 'gemini-3.5-flash-lite', smart: 'gemini-3.8-flash' });
  });
  it('routes by tier, meters tokens, and never pays twice for the same input', async () => {
    const { ask, Meter } = await import('../src/lib/llm/router');
    script = () => gem('```json\n{"ok":true}\n```', 1200, 80);
    const m = new Meter();
    const o = { tier: 'fast' as const, system: 's', user: 'u', meter: m, version: 't1' };
    expect(await ask(o)).toEqual({ ok: true });
    expect(await ask(o)).toEqual({ ok: true });
    const gen = calls.filter((c) => c.url.includes(':generateContent'));
    expect(gen).toHaveLength(1);
    expect(gen[0].url).toContain('gemini-3.5-flash-lite');
    expect(gen[0].body.generationConfig.responseMimeType).toBe('application/json');
    expect(m.cost()).toMatchObject({ calls: 1, cached: 1, tokIn: 1200, tokOut: 80 });
  });
  it('falls back to the other tier when a model is out of quota', async () => {
    const { ask, Meter } = await import('../src/lib/llm/router');
    script = (url) => (url.includes('gemini-3.8-flash:') ? { status: 429, json: { error: { message: 'Quota exceeded: GenerateRequestsPerDayPerProjectPerModel' } } } : gem({ via: 'lite' }));
    expect(await ask({ tier: 'smart', system: 's', user: 'u2', meter: new Meter(), version: 't2' })).toEqual({ via: 'lite' });
  });
});

describe('research pipeline with a scripted model', () => {
  it('reads a call, lets code judge the numeric promise, and assembles a dossier', async () => {
    const { parseCompany } = await import('../src/lib/sources/screener');
    const { buildFacts } = await import('../src/lib/research/facts');
    const { readCall } = await import('../src/lib/research/read');
    const { synthesise, askCompany } = await import('../src/lib/research/synth');
    const { Meter } = await import('../src/lib/llm/router');
    const facts = buildFacts(parseCompany(readFileSync('tests/fixtures/screener-company.html', 'utf8'), 'TESTCO', true));
    script = (_u, body) => {
      const prompt: string = body.contents[0].parts.at(-1).text;
      if (prompt.includes('Transcript of the')) {
        expect(prompt).toContain('=== PAGE 2 ===');
        return gem({ guidance: [{ metric: 'revenue_growth', statement: 'Revenue to grow 20-22% in FY26', quote: 'We expect revenue growth of 20 to 22 percent in FY26.', speaker: 'CFO', page: 2, horizon: 'FY26', low: 20, high: 22, unit: '%', firmness: 'explicit' }], claims: [{ claim: 'Demand is broad-based', quote: 'demand is broad based', page: 2 }], pressure: ['working capital'], business: 'Makes cables', segments: [], risks: [] }, 9000, 600);
      }
      if (prompt.includes('ALREADY JUDGED BY CODE')) {
        expect(prompt).toContain('Q4 FY25: Revenue growth 20–22% → 28.9% (delivered)');
        expect(prompt).toContain('Q2 FY27 | 9899 | 52.8');
        return gem({ one_line: 'Management under-promises on growth.', ledger: [{ promise: 'Net cash by year end', said_in: 'Q4 FY25', quote: 'x', page: 2, verdict: 'unverifiable', gap: 'Cash balance not in the numbers' }, { promise: 'bogus', verdict: 'great' }], divergences: [{ theme: 'Margins', narrative: 'a', numbers: 'b', verdict: 'diverge' }], guidance_now: [], bull: [{ point: 'p', evidence: 'e' }], bear: [{ point: 'p', evidence: 'e' }], business: { what: 'Cables', segments: [] } }, 4000, 900);
      }
      return gem({ answer: 'Guided 20–22%, delivered 28.9%.', cites: [{ quarter: 'Q4 FY25', page: 2 }] });
    };
    const notes = await readCall({ title: 't', url: 'https://www.bseindia.com/x.pdf', period: 'May 2025', quarter: 'Q4 FY25' }, 'Testco', new Meter());
    expect(notes.guidance[0]).toMatchObject({ low: 20, high: 22, page: 2, firmness: 'explicit' });
    const d = await synthesise(facts, [notes], undefined, new Meter());
    expect(d.depth).toBe('full');
    expect(d.ledger).toHaveLength(2);                                     // the invalid model row is dropped
    expect(d.ledger.find((r) => r.checked === 'code')).toMatchObject({ verdict: 'delivered', actual: '28.9%', target: '20–22%', url: 'https://www.bseindia.com/x.pdf' });
    expect(d.sayDo).toEqual({ delivered: 1, missed: 0, partly: 0, open: 1 });
    expect(d.cost.calls).toBe(2); expect(d.cost.tokIn).toBe(13000);
    const a = await askCompany('Did they hit guidance?', d, new Meter());
    expect(a.cites[0]).toEqual({ label: 'Q4 FY25 call, p.2', url: 'https://www.bseindia.com/x.pdf#page=2' });
  });
});
