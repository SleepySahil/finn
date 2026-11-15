/**
 * Snapshot builder. Run locally (`npm run ingest`) or on a schedule (GitHub Actions).
 *
 * Pulls the three sources for the whole portfolio, runs the same triage/enrichment/research
 * code the API routes use, and writes plain JSON into public/snapshot. The deployed app serves
 * that snapshot instantly and layers live data on top — so the demo works even if an upstream
 * blocks the host it is deployed on, and even with no model key at all.
 *
 *   npm run ingest                      everything
 *   npm run ingest -- --no-research     push side only
 *   npm run ingest -- --only POLYCAB    research for one ticker
 *   npm run ingest -- --days 45
 */
import { appendFileSync, writeFileSync } from 'node:fs';

try { process.loadEnvFile('.env.local'); } catch {}
try { process.loadEnvFile('.env'); } catch {}
process.env.LLM_GAP_MS ||= '4300';          // ~14 requests/minute: inside free-tier limits

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const DAYS = Number(opt('days') || 30);

const LOG = 'ingest.log';
writeFileSync(LOG, '');
const log = (...a: unknown[]) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); appendFileSync(LOG, s + '\n'); };

async function main() {
  const { PORTFOLIO, RESEARCH_SET, toFiling, livePrices, placeResidue, flatten } = await import('../src/lib/service');
  const { getCompany } = await import('../src/lib/sources/screener');
  const { getAnnouncements } = await import('../src/lib/sources/bse');
  const { foldEvents } = await import('../src/lib/brain/classify');
  const { enrichFiling } = await import('../src/lib/brain/enrich');
  const { buildFacts } = await import('../src/lib/research/facts');
  const { readCall, readAnnualReport } = await import('../src/lib/research/read');
  const { synthesise } = await import('../src/lib/research/synth');
  const { llmAvailable, Meter, addCost, ZERO, resolveModels } = await import('../src/lib/llm/router');
  const { cached, snapRead, snapWrite } = await import('../src/lib/cache');
  const { sleep } = await import('../src/lib/util');
  type Holding = import('../src/lib/types').Holding;
  type Filing = import('../src/lib/types').Filing;
  type Enrichment = import('../src/lib/types').Enrichment;
  type BriefPayload = import('../src/lib/types').BriefPayload;
  type CompanyData = import('../src/lib/types').CompanyData;
  type Cost = import('../src/lib/types').Cost;

  const llm = llmAvailable() && !flag('no-llm');
  if (!llm) delete process.env.GEMINI_API_KEY, delete process.env.GOOGLE_API_KEY, delete process.env.GROQ_API_KEY;
  log(`FINN ingest · ${new Date().toISOString()} · window ${DAYS}d · model ${llm ? JSON.stringify(await resolveModels()) : 'none (rules + arithmetic only)'}`);
  let spend: Cost = ZERO;

  const co = async (symbol: string): Promise<CompanyData> => (await cached(`co:${symbol}`, 6 * 3600, async () => { await sleep(700); return getCompany(symbol); })).v;

  // ---------- 1. resolve the universe ----------
  const only = opt('only')?.split(',').map((s) => s.trim().toUpperCase());
  const hs: Holding[] = [];
  const universe: Record<string, { scrip?: number; name: string; lender: boolean }> = (await snapRead('universe.json')) || {};
  if (!only) {
    for (const h of PORTFOLIO) {
      try {
        const c = await co(h.symbol);
        universe[h.symbol] = { scrip: c.scrip, name: c.name, lender: c.lender };
        hs.push({ ...h, scrip: c.scrip, lender: h.lender ?? c.lender });
        log(`  ✓ ${h.symbol.padEnd(11)} BSE ${c.scrip ?? '—'}  ${c.name}  (${c.quarters.periods.at(-1)}; ${c.concalls.length} calls, ${c.annualReports.length} ARs)`);
      } catch (e) {
        const u = universe[h.symbol];
        hs.push({ ...h, scrip: u?.scrip, lender: h.lender ?? u?.lender });
        log(`  ✗ ${h.symbol}: ${(e as Error).message}${u?.scrip ? ' · using saved BSE code' : ''}`);
      }
    }
    await snapWrite('universe.json', universe);
    // Never let a bad network day overwrite a good snapshot: anything that fails now is carried over.
    const prev = await snapRead<BriefPayload>('brief.json');

    // ---------- 2. prices ----------
    const { prices, failed } = await livePrices(hs, '6mo');
    const keptPx = failed.filter((s) => prev?.prices?.[s]);
    for (const s of keptPx) prices[s] = prev!.prices[s];
    log(`prices: ${hs.length - failed.length}/${hs.length} live${failed.length ? ` · failed ${failed.join(',')}` : ''}${keptPx.length ? ` · kept saved prices for ${keptPx.length}` : ''}`);

    // ---------- 3. filings ----------
    const to = new Date(), from = new Date(Date.now() - DAYS * 86400e3);
    let filings: Filing[] = [];
    const noFilings = new Set<string>();
    for (const h of hs) {
      if (!h.scrip) { noFilings.add(h.symbol); continue; }
      try {
        const rows = await getAnnouncements(h.scrip, from, to, 0);
        filings.push(...rows.map((r) => toFiling(r, h)));
        await sleep(250);
      } catch (e) {
        noFilings.add(h.symbol);
        log(`  ✗ filings ${h.symbol}: ${(e as Error).message}`);
      }
    }
    if (noFilings.size && prev) {
      const kept = flatten(prev.filings).filter((f) => noFilings.has(f.symbol) && Date.parse(f.at) >= from.getTime());
      filings.push(...kept);
      log(`kept ${kept.length} saved filings for ${[...noFilings].join(',')}`);
    }
    if (!filings.length && !Object.keys(prices).length) throw new Error('No filings and no prices fetched — keeping the existing snapshot untouched');
    const count = (k: string) => filings.filter((f) => f.tier === k).length;
    log(`filings: ${filings.length} · rules placed ${filings.filter((f) => f.via === 'rule').length} · residue ${filings.filter((f) => f.via === 'fallback').length}`);

    // ---------- 4. the residue goes to the cheap model, batched ----------
    if (llm) {
      const m = new Meter();
      filings = await placeResidue(filings, m);
      spend = addCost(spend, m.cost());
      log(`residue placed by model: ${filings.filter((f) => f.via === 'llm').length} in ${m.cost().calls} call(s)`);
    }
    log(`triage: ${count('act')} surface · ${count('know')} note · ${count('bury')} buried`);
    const folded = foldEvents(filings);
    log(`after folding same-event filings: ${folded.length} cards`);

    // ---------- 5. enrichment ----------
    const ids = new Set(flatten(folded).map((f) => f.id));
    const enrich: Record<string, Enrichment> = Object.fromEntries(Object.entries(prev?.enrich || {}).filter(([id]) => ids.has(id)));
    const worth = folded.filter((f) => f.tier !== 'bury');
    const queue = [
      ...worth.filter((f) => f.category === 'results' && f.subtype === 'Results filed'),
      ...(llm ? worth.filter((f) => f.tier === 'act' && f.category !== 'results').slice(0, 40) : []),
      ...(llm ? worth.filter((f) => f.tier === 'know').slice(0, 30) : []),
    ];
    for (const f of queue) {
      try {
        const e = await enrichFiling(f, hs.find((h) => h.symbol === f.symbol));
        if (e) { enrich[f.id] = e; spend = addCost(spend, e.cost); log(`  ✓ ${f.symbol.padEnd(11)} ${f.subtype}: ${e.line}`); }
      } catch (e) {
        log(`  ✗ enrich ${f.symbol} ${f.subtype}: ${(e as Error).message}`);
      }
    }

    const brief: BriefPayload = { generatedAt: new Date().toISOString(), mode: 'snapshot', portfolio: hs, filings: folded, prices, enrich, llm, notes: [] };
    await snapWrite('brief.json', brief);
    log(`wrote public/snapshot/brief.json · ${folded.length} cards · ${Object.keys(enrich).length} enriched`);
  }

  // ---------- 6. research dossiers ----------
  if (!flag('no-research')) {
    const index: { symbol: string; name: string; depth: string; oneLine?: string }[] = (await snapRead('research/index.json')) || [];
    for (const symbol of only || RESEARCH_SET) {
      try {
        const c = await co(symbol);
        const f = buildFacts(c);
        const meter = new Meter();
        const notes = [];
        let ar;
        if (llm) {
          for (const d of f.docs.concalls.slice(0, 5)) {
            try { const n = await readCall(d, c.name, new Meter()); notes.push(n); log(`    read ${symbol} ${d.quarter}: ${n.pages}p → ${n.guidance.length} guidance, ${n.claims.length} claims`); }
            catch (e) { log(`    ✗ ${symbol} ${d.quarter}: ${(e as Error).message}`); }
          }
          if (f.docs.annualReports[0]) {
            try { ar = await readAnnualReport(f.docs.annualReports[0], c.name, new Meter()); log(`    read ${symbol} annual report: ${ar.pagesRead.length} of ${ar.totalPages} pages sent`); }
            catch (e) { log(`    ✗ ${symbol} annual report: ${(e as Error).message}`); }
          }
        }
        const d = await synthesise(f, notes, ar, meter);
        await snapWrite(`research/${symbol}.json`, d);
        spend = addCost(spend, d.cost);
        const at = index.findIndex((x) => x.symbol === symbol);
        const row = { symbol, name: c.name, depth: d.depth, oneLine: d.oneLine };
        if (at >= 0) index[at] = row; else index.push(row);
        log(`  ✓ research ${symbol}: ${d.depth} · ledger ${d.ledger.length} (${d.ledger.filter((r) => r.checked === 'code').length} judged by code) · ${d.cost.calls} calls, ${d.cost.tokIn + d.cost.tokOut} tokens`);
      } catch (e) {
        log(`  ✗ research ${symbol}: ${(e as Error).message}`);
      }
    }
    await snapWrite('research/index.json', index);
  }

  log(`done · model calls ${spend.calls} (+${spend.cached} cached) · ${spend.tokIn} in / ${spend.tokOut} out tokens · ≈ $${spend.usd.toFixed(4)} at list price (₹0 on the free tier)`);
}

main().catch((e) => { log('FATAL', (e as Error).stack || String(e)); process.exit(1); });
