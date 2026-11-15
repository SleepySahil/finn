import { cacheGet, cacheSet } from '../cache';
import { getCompany } from '../sources/screener';
import { pdfText, withPageMarks } from '../sources/pdf';
import { getBytes } from '../http';
import { ask, llmAvailable, Meter } from '../llm/router';
import { fyQuarter, pct, round } from '../util';
import { resultsCut } from './results';
import { CATEGORIES } from './classify';
import type { Category, Enrichment, Filing, Holding, MgmtCut, PersonChange, ResultsCut, SummaryCut, Tier } from '../types';

const STYLE = 'Write like a buy-side analyst texting a partner: the fact and the number, no adjectives, no preamble, no "the company announced". Use only the document. If the document does not say it, leave it out.';

// ---------------- results ----------------
interface Col { revenue?: number | null; other_income?: number | null; finance_costs?: number | null; depreciation?: number | null; pbt?: number | null; pat?: number | null }
interface Extracted { basis?: string; unit?: string; period_end?: string; page?: number; cur?: Col; prev?: Col; yago?: Col }

const toCr = (n: number | null | undefined, unit?: string) => {
  if (n == null || !Number.isFinite(n)) return null;
  const u = (unit || '').toLowerCase();
  const k = /lakh|lac/.test(u) ? 0.01 : /million|mn/.test(u) ? 0.1 : /billion|bn/.test(u) ? 100 : /thousand/.test(u) ? 0.0001 : 1;
  return Math.round(n * k * 100) / 100;
};
const ebitda = (c: Col | undefined, unit?: string) =>
  c && c.pbt != null ? toCr((c.pbt ?? 0) + (c.finance_costs ?? 0) + (c.depreciation ?? 0) - (c.other_income ?? 0), unit) : null;

/** Read the results table straight out of the filing. Cheap tier; a scanned filing is sent as a PDF instead of text. */
async function resultsFromFiling(f: Filing, lender: boolean, meter: Meter): Promise<ResultsCut | null> {
  if (!f.pdf || !llmAvailable()) return null;
  const doc = await pdfText(f.pdf, 25_000_000);
  const user =
    'From this quarterly results filing, extract the statement of profit and loss for three columns: the quarter just ended (cur), the immediately preceding quarter (prev), and the same quarter of the previous year (yago). ' +
    'Prefer CONSOLIDATED figures; use standalone only if there are no consolidated ones. Report numbers exactly as printed (no unit conversion) and say what unit the table is in. ' +
    (lender ? 'For a bank/NBFC: revenue = total income, finance_costs = interest expended. ' : 'revenue = revenue from operations (not total income). ') +
    'JSON: {"basis":"consolidated|standalone","unit":"crore|lakh|million","period_end":"30 Sep 2026","page":3,"cur":{"revenue":0,"other_income":0,"finance_costs":0,"depreciation":0,"pbt":0,"pat":0},"prev":{...},"yago":{...}}. Use null for anything not printed.';
  const x = await ask<Extracted>({
    tier: 'fast', version: 'results-v2', meter,
    system: 'You transcribe financial tables from Indian exchange filings. You never estimate or compute a figure that is not printed.',
    user: doc.scanned ? user : `${user}\n\n${withPageMarks(doc.pages, 0, 45_000)}`,
    pdf: doc.scanned && doc.bytes < 12_000_000 ? await getBytes(f.pdf, { headers: { Referer: 'https://www.bseindia.com/' } }) : undefined,
  });
  if (!x?.cur || x.cur.revenue == null) return null;
  const col = (c?: Col) => ({ rev: toCr(c?.revenue, x.unit), e: ebitda(c, x.unit), pbt: toCr(c?.pbt, x.unit), pat: toCr(c?.pat, x.unit) });
  const a = col(x.cur), b = col(x.prev), y = col(x.yago);
  const mk = (key: string, k: 'rev' | 'e' | 'pbt' | 'pat') => ({ key, cur: a[k], prev: b[k], yago: y[k], qoq: round(pct(a[k], b[k])), yoy: round(pct(a[k], y[k])), unit: 'cr' as const });
  const metrics = [mk('Revenue', 'rev'), mk(lender ? 'Operating profit' : 'EBITDA', 'e'), mk('PBT', 'pbt'), mk('PAT', 'pat')];
  const mg = (c: { rev: number | null; e: number | null }) => (c.rev && c.e != null ? round((c.e / c.rev) * 100) : null);
  const cur = mg(a), yago = mg(y);
  const s = (n: number | null) => (n == null ? 'n/a' : `${n > 0 ? '+' : ''}${n}%`);
  return {
    kind: 'results', period: x.period_end || '', periodEnd: x.period_end || '', metrics,
    margin: { cur, yago, bps: cur != null && yago != null ? Math.round((cur - yago) * 100) : null, label: lender ? 'Financing margin' : 'EBITDA margin' },
    line: `Revenue ${s(metrics[0].yoy)} YoY, PAT ${s(metrics[3].yoy)} YoY${cur != null ? `; EBITDA margin ${cur}%` : ''}`,
    source: 'filing', note: `${x.basis || 'reported'} figures from the filing${x.page ? `, p.${x.page}` : ''}; EBITDA = PBT + finance cost + depreciation − other income`,
  };
}

export async function enrichResults(f: Filing, h: Pick<Holding, 'lender'> | undefined, meter: Meter): Promise<ResultsCut | null> {
  const lender = Boolean(h?.lender);
  let table: ResultsCut | null = null;
  try { table = resultsCut(await getCompany(f.symbol), new Date(f.at)); } catch {}
  const tableIsCurrent = table && !table.note;
  let filing: ResultsCut | null = null;
  try { filing = await resultsFromFiling(f, lender, meter); } catch {}
  if (tableIsCurrent && filing) {
    // Two independent routes to the same number: the standardised table and the model's reading of the PDF.
    const t = table!.metrics[0].cur, g = filing.metrics[0].cur, tp = table!.metrics[3].cur, gp = filing.metrics[3].cur;
    const close = (p: number | null, q: number | null) => p != null && q != null && Math.abs(p - q) <= Math.max(2, Math.abs(p) * 0.02);
    return { ...table!, checked: close(t, g) && close(tp, gp) ? 'matches' : 'differs', note: close(t, g) && close(tp, gp) ? `Cross-checked against the filing${filing.note?.match(/p\.\d+/) ? ` (${filing.note.match(/p\.\d+/)![0]})` : ''}` : `Filing reads revenue ₹${g} Cr, PAT ₹${gp} Cr — check consolidated vs standalone` };
  }
  if (tableIsCurrent) return table;
  if (filing) {
    const m = filing.periodEnd.match(/([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/);
    return { ...filing, period: m ? fyQuarter(`${m[1]} ${m[2]}`) : filing.period };
  }
  return table;   // stale table with its note beats nothing
}

// ---------------- management change ----------------
export async function enrichMgmt(f: Filing, meter: Meter): Promise<MgmtCut | null> {
  if (!f.pdf || !llmAvailable()) return null;
  const doc = await pdfText(f.pdf, 20_000_000);
  if (doc.scanned) return null;
  const x = await ask<{ changes?: Partial<PersonChange>[]; line?: string }>({
    tier: 'fast', version: 'mgmt-v2', meter,
    system: `You read board/management-change disclosures filed under SEBI LODR Regulation 30. Such filings carry a "brief profile" of each appointee. ${STYLE}`,
    user:
      `Company: ${f.company}. Subject: ${f.subject}. ${f.headline}\n\n` +
      'List each person whose role changes. JSON: {"line":"<=20 words: who, what role, in or out, from when","changes":[{"person":"","role":"","action":"appointed|resigned|retired|re-appointed|ceased","effective":"","reason":"<=12 words, only if stated","background":"<=40 words from the brief profile: where they came from, years of experience, prior employers, qualifications","prior":["previous employer or role", "..."]}]}. ' +
      'Incoming people first. If no profile is given for a person, leave background empty — do not fill it from memory.\n\n' + withPageMarks(doc.pages, 0, 28_000),
  });
  const changes = (x.changes || []).filter((c) => c.person).slice(0, 4).map((c) => ({
    person: c.person!, role: c.role || '', action: c.action || 'changed', effective: c.effective || undefined, reason: c.reason || undefined,
    background: c.background || undefined, prior: (c.prior || []).filter(Boolean).slice(0, 4),
    lookup: `https://www.google.com/search?q=${encodeURIComponent(`"${c.person}" ${f.company} LinkedIn`)}`,
  }));
  if (!changes.length) return null;
  const cut: MgmtCut = { kind: 'mgmt', changes, line: x.line || `${changes[0].person} ${changes[0].action} as ${changes[0].role}`, source: 'filing' };

  // Filing had no profile for an incoming person: one grounded web lookup (push-side enrichment only).
  const blank = cut.changes.find((c) => /appoint/i.test(c.action) && !c.background);
  if (blank && process.env.FINN_WEB_BIO !== '0') {
    try {
      const bio = await ask<string>({
        tier: 'fast', version: 'bio-v1', meter, json: false, ground: true, maxOut: 600, ttl: 30 * 86400,
        system: 'You write two-sentence professional backgrounds from web search results. Facts only: prior employers, roles, years. If you cannot find the person, reply exactly: NOT FOUND.',
        user: `${blank.person}, newly ${blank.action} as ${blank.role} of ${f.company} (India). Where did they work before? 40 words max.`,
      });
      if (bio && !/NOT FOUND/i.test(bio)) { blank.background = bio.trim().slice(0, 320); cut.source = 'web'; }
    } catch {}
  }
  return cut;
}

// ---------------- everything else: one line ----------------
export async function enrichSummary(f: Filing, meter: Meter): Promise<SummaryCut | null> {
  if (!f.pdf || !llmAvailable()) return null;
  const doc = await pdfText(f.pdf, 20_000_000);
  if (doc.scanned) return null;
  const x = await ask<{ line?: string; numbers?: string[] }>({
    tier: 'fast', version: 'sum-v2', meter, maxOut: 700,
    system: `You turn one exchange filing into one line for a portfolio manager. ${STYLE}`,
    user:
      `Company: ${f.company}. Filed as: ${f.subject}. ${f.headline}\n` +
      'JSON: {"line":"<=24 words. What happened, the size in rupees or %, and the counterparty or date if any.","numbers":["up to 3 figures worth seeing, each <=5 words, e.g. \\"₹1,240 Cr order\\""]}\n\n' +
      withPageMarks(doc.pages, 0, 12_000),
  });
  return x.line ? { kind: 'summary', line: x.line.trim(), numbers: (x.numbers || []).slice(0, 3) } : null;
}

/** One filing → the right enrichment for its type. Cached per filing id (only successes); null when there is nothing worth adding. */
export async function enrichFiling(f: Filing, h?: Pick<Holding, 'lender'>): Promise<Enrichment | null> {
  const key = `enrich:v4:${f.id}:${llmAvailable() ? 'llm' : 'rules'}`;
  const hit = await cacheGet<Enrichment>(key);
  if (hit) return hit;
  const meter = new Meter();
  let cut: ResultsCut | MgmtCut | SummaryCut | null = null;
  if (f.category === 'results' && f.subtype === 'Results filed') cut = await enrichResults(f, h, meter);
  else if (f.category === 'management_change') cut = (await enrichMgmt(f, meter).catch(() => null)) || (await enrichSummary(f, meter).catch(() => null));
  else cut = await enrichSummary(f, meter).catch(() => null);
  if (!cut) return null;
  const out: Enrichment = { ...cut, cost: meter.cost(), at: new Date().toISOString() };
  // a results cut read off a table that has not caught up yet should be retried soon, not kept for a month
  await cacheSet(key, out, cut.kind === 'results' && cut.note && cut.source === 'screener' && !cut.checked ? 3600 : 30 * 86400);
  return out;
}

// ---------------- the residue the rules could not place ----------------
export async function classifyResidue(items: Filing[], meter: Meter): Promise<Map<string, { category: Category; tier: Tier; subtype: string; why: string }>> {
  const out = new Map<string, { category: Category; tier: Tier; subtype: string; why: string }>();
  if (!llmAvailable()) return out;
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    try {
      const x = await ask<{ items?: { i: number; category: string; tier: string; subtype: string; why: string }[] }>({
        tier: 'fast', version: 'classify-v1', meter, maxOut: 2500,
        system: 'You triage Indian stock-exchange announcements for an investor who wants to see only what could move a stock. Most filings are routine paperwork: bury them.',
        user:
          `Categories: ${CATEGORIES.join(', ')}.\nTiers: act (could move the stock, show now), know (one line is enough), bury (routine).\n` +
          'JSON: {"items":[{"i":0,"category":"","tier":"","subtype":"2-3 words","why":"<=10 words"}]}\n\n' +
          batch.map((f, k) => `${k}. [${f.company}] ${f.subject} — ${f.headline}`).join('\n'),
      });
      for (const it of x.items || []) {
        const f = batch[it.i];
        if (!f || !CATEGORIES.includes(it.category as Category) || !['act', 'know', 'bury'].includes(it.tier)) continue;
        out.set(f.id, { category: it.category as Category, tier: it.tier as Tier, subtype: it.subtype || 'Other', why: it.why || 'Placed by model' });
      }
    } catch {}
  }
  return out;
}
