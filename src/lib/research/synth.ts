import { ask, addCost, llmAvailable, Meter, ZERO } from '../llm/router';
import { pct, round } from '../util';
import { factsForModel } from './facts';
import type { ArNotes } from './read';
import type { CallNotes, Dossier, Facts, GuidanceItem, LedgerRow } from '../types';

export type FullDossier = Dossier & { ar?: ArNotes };

/** "Q4 FY26" < "Q1 FY27": sort by fiscal year, then quarter (plain string order gets this wrong). */
export const qOrder = (q: string) => { const m = q.match(/Q(\d)\s*FY(\d+)/); return m ? Number(m[2]) * 10 + Number(m[1]) : 0; };

// ---------- code judges what code can judge ----------

/** "FY27", "Q3 FY26", "full year" (relative to the call) → a period key that exists in Facts. */
function horizonKey(h: string | undefined, callQuarter: string): { fy?: string; q?: string } | null {
  if (!h) return null;
  const callFy = (callQuarter.match(/FY(\d{2})/) || [])[1];
  const fy = h.match(/FY\s?'?(?:20)?(\d{2})\b/i);
  const q = h.match(/\bQ([1-4])\b/i);
  if (fy && q) return { q: `Q${q[1]} FY${fy[1]}` };
  if (fy) return { fy: `FY${fy[1]}` };
  if (/full[- ]year|this year|current (fiscal|financial|year)|for the year/i.test(h) && callFy) return { fy: `FY${callFy}` };
  return null;
}

const sumAt = (a: (number | null)[], idx: number[]) => idx.reduce<number | null>((s, i) => (a[i] == null || s == null ? null : s + a[i]!), 0);

/** What actually happened on a metric over a fiscal year or quarter, from reported numbers. */
function actualFor(metric: string, key: { fy?: string; q?: string }, f: Facts): { value: number; label: string; final: boolean } | null {
  const Q = f.quarters, T = f.trajectory;
  if (key.q) {
    const i = Q.periods.indexOf(key.q);
    if (i < 0) return null;
    const v = metric === 'revenue_growth' ? Q.revYoy[i] : metric === 'ebitda_margin' ? Q.opm[i] : metric === 'pat_growth' ? Q.patYoy[i] : null;
    return v == null ? null : { value: v, label: key.q, final: true };
  }
  if (!key.fy) return null;
  const yi = T.years.indexOf(key.fy);
  if (yi >= 1) {
    const v = metric === 'revenue_growth' ? round(pct(T.revenue[yi], T.revenue[yi - 1])) : metric === 'ebitda_margin' ? T.opm[yi] : metric === 'pat_growth' ? round(pct(T.pat[yi], T.pat[yi - 1])) : null;
    return v == null ? null : { value: v, label: key.fy, final: true };
  }
  // Year still running: compare the quarters reported so far with the same quarters a year earlier.
  const fyN = Number(key.fy.slice(2));
  const cur = Q.periods.map((p, i) => (p.endsWith(`FY${fyN}`) ? i : -1)).filter((i) => i >= 0);
  if (!cur.length || cur.length === 4) return null;
  const prev = cur.map((i) => Q.periods.indexOf(Q.periods[i].replace(`FY${fyN}`, `FY${fyN - 1}`)));
  if (prev.some((i) => i < 0)) return null;
  const label = `${cur.length === 2 ? 'H1' : cur.length === 3 ? '9M' : 'Q1'} ${key.fy}`;
  if (metric === 'revenue_growth' || metric === 'pat_growth') {
    const a = metric === 'revenue_growth' ? Q.revenue : Q.pat;
    const v = round(pct(sumAt(a, cur), sumAt(a, prev)));
    return v == null ? null : { value: v, label, final: false };
  }
  if (metric === 'ebitda_margin') {
    const r = sumAt(Q.revenue, cur);
    const e = cur.reduce<number | null>((s, i) => (Q.revenue[i] == null || Q.opm[i] == null || s == null ? null : s + (Q.revenue[i]! * Q.opm[i]!) / 100), 0);
    return r && e != null ? { value: round((e / r) * 100)!, label, final: false } : null;
  }
  return null;
}

/**
 * Promised vs delivered, decided by arithmetic wherever the promise was a number on a metric we
 * can measure. The model reads the transcript; it does not get to grade it.
 */
export function codeLedger(notes: CallNotes[], f: Facts): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const seen = new Set<string>();
  for (const n of [...notes].sort((a, b) => qOrder(a.quarter) - qOrder(b.quarter))) {
    for (const g of n.guidance as GuidanceItem[]) {
      if (!['revenue_growth', 'ebitda_margin', 'pat_growth'].includes(g.metric)) continue;
      const target = g.low ?? g.high;
      if (target == null || (g.unit && !/%/.test(g.unit))) continue;
      const key = horizonKey(g.horizon, n.quarter);
      if (!key) continue;
      const act = actualFor(g.metric, key, f);
      if (!act) continue;
      const id = `${g.metric}:${key.fy || key.q}:${target}`;
      if (seen.has(id)) continue;       // the same guidance repeated on the next call is one promise
      seen.add(id);
      const margin = g.metric === 'ebitda_margin';
      const tol = margin ? 0.3 : 0.5;
      const short = target - act.value;
      const verdict: LedgerRow['verdict'] = !act.final ? 'too_early' : short <= tol ? 'delivered' : (margin ? short <= 1.5 : act.value >= target * 0.85) ? 'partly' : 'missed';
      const name = g.metric === 'revenue_growth' ? 'Revenue growth' : margin ? (f.lender ? 'Financing margin' : 'EBITDA margin') : 'PAT growth';
      const range = g.high != null && g.low != null && g.high !== g.low ? `${g.low}–${g.high}%` : `${target}%`;
      rows.push({
        promise: g.statement, saidIn: n.quarter, quote: g.quote, page: g.page, url: n.url, metric: name, target: range,
        actual: `${act.value}%`, actualPeriod: act.label, verdict, checked: 'code',
        gap: !act.final
          ? `${act.label} running at ${act.value}% — ${short <= tol ? 'on or ahead of' : 'behind'} the guided ${range}`
          : short <= tol ? (act.value - (g.high ?? target) > tol ? `Beat by ${round(act.value - (g.high ?? target))} pts` : 'In line') : `Short by ${round(short)} pts`,
      });
    }
  }
  return rows;
}

// ---------- the model does what only a reader can ----------

interface Synth {
  ledger?: Partial<LedgerRow & { said_in: string; actual_period: string }>[];
  divergences?: { theme: string; narrative: string; numbers: string; verdict: string }[];
  guidance_now?: { metric: string; target: string; horizon?: string; said_in: string; quote?: string; page?: number }[];
  bull?: { point: string; evidence: string }[];
  bear?: { point: string; evidence: string }[];
  business?: { what: string; segments: { name: string; note: string }[] };
  one_line?: string;
}

const notesForModel = (notes: CallNotes[]) =>
  notes.map((n) =>
    `--- ${n.quarter} call (${n.period}) ---\nGUIDANCE:\n${n.guidance.map((g) => `- [p.${g.page ?? '?'}] (${g.metric}, ${g.horizon || 'no horizon'}, ${g.firmness}) ${g.statement} — "${g.quote}"`).join('\n') || '- none'}\n` +
    `CLAIMS:\n${n.claims.map((c) => `- [p.${c.page ?? '?'}] ${c.claim} — "${c.quote}"`).join('\n') || '- none'}\n` +
    `ANALYSTS PRESSED ON: ${n.pressure.join('; ') || 'nothing notable'}\nRISKS ADMITTED: ${(n.risks || []).join('; ') || 'none'}\nBUSINESS: ${n.business || ''} ${(n.segments || []).map((s) => `${s.name}: ${s.note}`).join(' | ')}`,
  ).join('\n\n');

/**
 * Reduce step. One call on the stronger tier, fed ~3-5k tokens of notes and a numbers table
 * instead of ~80k tokens of transcripts. This is the only place reasoning is paid for.
 */
export async function synthesise(facts: Facts, notes: CallNotes[], ar: ArNotes | undefined, meter: Meter): Promise<FullDossier> {
  const checked = codeLedger(notes, facts);
  const base: FullDossier = {
    symbol: facts.symbol, name: facts.name, facts, notes, ar, ledger: checked, sayDo: { delivered: 0, missed: 0, partly: 0, open: 0 },
    divergences: [], guidanceNow: [], bull: [], bear: [], cost: ZERO, builtAt: new Date().toISOString(), depth: notes.length ? 'full' : 'numbers',
  };
  if (notes.length && llmAvailable()) {
    const urlOf = (q?: string) => notes.find((n) => n.quarter === q)?.url;
    const x = await ask<Synth>({
      tier: 'smart', version: 'synth-v3', meter, maxOut: 8192,
      system:
        `You are a sceptical buy-side analyst writing for a portfolio manager who has 90 seconds. You analyse ${facts.name}'s management — you do not summarise them. ` +
        'Ground rules: use ONLY the call notes and the reported numbers below. No outside knowledge of this company, no news, no broker views. Every claim needs a number from NUMBERS or a page reference from the notes. ' +
        'If the numbers needed to judge a promise are not in NUMBERS, the verdict is "unverifiable" — never guess. Short sentences. No adjectives like "strong", "robust", "impressive".',
      user:
        `NUMBERS (company-reported)\n${factsForModel(facts)}\n\nCALL NOTES (oldest first)\n${notesForModel([...notes].sort((a, b) => qOrder(a.quarter) - qOrder(b.quarter)))}\n\n` +
        (ar ? `ANNUAL REPORT ${ar.year || ''}: ${ar.business} | Flags: ${ar.redFlags.map((r) => `${r.text} (p.${r.page ?? '?'})`).join('; ') || 'none'}\n\n` : '') +
        `ALREADY JUDGED BY CODE (do not repeat these in "ledger"):\n${checked.map((r) => `- ${r.saidIn}: ${r.metric} ${r.target} → ${r.actual} (${r.verdict})`).join('\n') || '- none'}\n\n` +
        'Return JSON:\n{"one_line":"<=24 words: the single most important thing about how this management\'s words compare with their numbers",\n' +
        '"ledger":[{"promise":"<=18 words","said_in":"Q1 FY27","quote":"verbatim from notes","page":0,"metric":"","target":"","actual":"with the number and its period, from NUMBERS","actual_period":"","verdict":"delivered|missed|partly|too_early|unverifiable","gap":"<=12 words"}],\n' +
        '"divergences":[{"theme":"2-4 words","narrative":"<=22 words: what management keeps saying","numbers":"<=22 words: what the reported numbers show","verdict":"agree|diverge"}],\n' +
        '"guidance_now":[{"metric":"","target":"","horizon":"","said_in":"","quote":"","page":0}],\n' +
        '"bull":[{"point":"<=14 words","evidence":"<=20 words with a number"}],"bear":[{"point":"","evidence":""}],\n' +
        '"business":{"what":"<=40 words","segments":[{"name":"","note":"<=12 words"}]}}\n' +
        'ledger: promises from the earlier calls that the later quarters can now test, beyond the code-judged ones (max 6). divergences: max 4, at least one "diverge" if any exists. guidance_now: what is still outstanding from the latest two calls (max 5). bull/bear: exactly 3 each, each resting on different evidence.',
    });
    const V = ['delivered', 'missed', 'partly', 'too_early', 'unverifiable'];
    const extra: LedgerRow[] = (x.ledger || []).filter((r) => r.promise && V.includes(String(r.verdict))).slice(0, 6).map((r) => ({
      promise: r.promise!, saidIn: r.said_in || r.saidIn || '', quote: r.quote, page: typeof r.page === 'number' ? r.page : undefined, url: urlOf(r.said_in || r.saidIn),
      metric: r.metric, target: r.target, actual: r.actual, actualPeriod: r.actual_period || r.actualPeriod, verdict: r.verdict as LedgerRow['verdict'], gap: r.gap, checked: 'model',
    }));
    base.ledger = [...checked, ...extra];
    base.divergences = (x.divergences || []).slice(0, 4).map((d) => ({ ...d, verdict: d.verdict === 'diverge' ? 'diverge' : 'agree' }));
    base.guidanceNow = (x.guidance_now || []).slice(0, 5).map((g) => ({ metric: g.metric, target: g.target, horizon: g.horizon, saidIn: g.said_in, quote: g.quote, page: g.page, url: urlOf(g.said_in) }));
    base.bull = (x.bull || []).slice(0, 3);
    base.bear = (x.bear || []).slice(0, 3);
    base.business = x.business || (ar ? { what: ar.business, segments: ar.segments } : undefined);
    base.oneLine = x.one_line;
  }
  const order = { missed: 0, partly: 1, delivered: 2, too_early: 3, unverifiable: 4 } as const;
  base.ledger.sort((a, b) => order[a.verdict] - order[b.verdict]);
  for (const r of base.ledger) {
    if (r.verdict === 'delivered') base.sayDo.delivered++;
    else if (r.verdict === 'missed') base.sayDo.missed++;
    else if (r.verdict === 'partly') base.sayDo.partly++;
    else base.sayDo.open++;
  }
  base.cost = notes.reduce((c, n) => addCost(c, n.cost), addCost(meter.cost(), ar?.cost));
  return base;
}

/** Follow-up question about one company, answered from the dossier already built — no document is re-read. */
export async function askCompany(question: string, d: FullDossier, meter: Meter): Promise<{ answer: string; cites: { label: string; url?: string }[] }> {
  const x = await ask<{ answer: string; cites?: { quarter?: string; page?: number }[] }>({
    tier: 'smart', version: 'ask-v2', meter, maxOut: 1500, ttl: 86400,
    system:
      `You answer a portfolio manager's question about ${d.name} using only the reported numbers and earnings-call notes supplied. No outside knowledge. ` +
      'If the material does not answer it, say what is missing in one sentence. Answer in <=90 words, numbers first, no preamble.',
    user: `NUMBERS\n${factsForModel(d.facts)}\n\nCALL NOTES\n${notesForModel([...d.notes].sort((a, b) => qOrder(a.quarter) - qOrder(b.quarter)))}\n\nLEDGER\n${d.ledger.map((r) => `- ${r.saidIn}: ${r.promise} → ${r.actual || 'n/a'} (${r.verdict})`).join('\n')}\n\nQUESTION: ${question}\n\nJSON: {"answer":"","cites":[{"quarter":"Q2 FY27","page":4}]}`,
  });
  return {
    answer: x.answer,
    cites: (x.cites || []).slice(0, 4).map((c) => {
      const n = d.notes.find((k) => k.quarter === c.quarter);
      return { label: `${c.quarter || 'Reported numbers'}${c.page ? ` call, p.${c.page}` : ''}`, url: n ? `${n.url}${c.page ? `#page=${c.page}` : ''}` : undefined };
    }),
  };
}
