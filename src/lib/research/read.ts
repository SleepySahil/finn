import { pdfText, topPages, withPageMarks } from '../sources/pdf';
import { ask, Meter } from '../llm/router';
import type { CallNotes, Cost, DocLink, GuidanceItem } from '../types';

export interface ArNotes { url: string; year?: string; business: string; segments: { name: string; share?: string; note: string }[]; redFlags: { kind: string; text: string; page?: number }[]; pagesRead: number[]; totalPages: number; cost?: Cost }

const GROUND = 'Use only the text supplied. Do not use anything you know about this company from elsewhere — if it is not on these pages it does not exist. Cite the page number shown in the === PAGE n === markers.';

/**
 * Map step. One transcript → structured notes, on the cheap tier. The transcript is ~15-25
 * pages (10-18k tokens), read whole — chunking a conversation loses who promised what.
 * Output is ~1k tokens; from here on nothing downstream ever re-reads the PDF.
 */
export async function readCall(doc: DocLink, company: string, meter: Meter): Promise<CallNotes> {
  const pdf = await pdfText(doc.url, 30_000_000);
  if (pdf.scanned) throw new Error(`${doc.quarter} transcript is a scanned image — no text to read`);
  const x = await ask<{
    guidance?: Partial<GuidanceItem>[]; claims?: { claim: string; quote: string; page?: number }[]; pressure?: string[];
    business?: string; segments?: { name: string; note: string }[]; risks?: string[];
  }>({
    tier: 'fast', version: 'call-v3', meter, maxOut: 6000,
    system: `You are an equity analyst taking notes on an earnings-call transcript of ${company}. Your notes will be used to hold management to account later, so precision matters more than coverage. ${GROUND}`,
    user:
      `Transcript of the ${doc.quarter} earnings call (held ${doc.period}).\n\nReturn JSON:\n` +
      '{"guidance":[{"metric":"revenue_growth|ebitda_margin|pat_growth|capex|volume_growth|other","statement":"<=22 words, what management committed to","quote":"verbatim, <=28 words","speaker":"name or role","page":0,"horizon":"FY27 | Q3 FY27 | next 3 years | unspecified","low":null,"high":null,"unit":"%|Rs crore|bps|x","firmness":"explicit|directional"}],' +
      '"claims":[{"claim":"<=20 words: a statement about growth, demand, margins or market share that numbers can later confirm or contradict","quote":"verbatim <=28 words","page":0}],' +
      '"pressure":["<=10 words each: what analysts pushed back on or asked twice"],' +
      '"business":"<=45 words: what the company sells and to whom, as management describes it on this call",' +
      '"segments":[{"name":"","note":"<=14 words incl. growth or share if stated"}],' +
      '"risks":["<=14 words each, only risks management itself acknowledged"]}\n\n' +
      'Rules: guidance = forward-looking statements by MANAGEMENT only (not analysts). Put numbers in low/high when stated ("15-17%" → low 15, high 17; "at least 20%" → low 20). ' +
      'explicit = a number or range was given; directional = "we expect improvement" with no number. Max 10 guidance, 8 claims, 5 pressure, 6 segments, 5 risks. Empty arrays are fine.\n' +
      withPageMarks(pdf.pages, 0, 150_000),
  });
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    url: doc.url, quarter: doc.quarter || '', period: doc.period || '', pages: pdf.total,
    guidance: (x.guidance || []).filter((g) => g.statement).slice(0, 10).map((g) => ({
      metric: g.metric || 'other', statement: g.statement!, quote: g.quote || '', speaker: g.speaker, page: n(g.page) ?? undefined,
      horizon: g.horizon, low: n(g.low), high: n(g.high), unit: g.unit, firmness: g.firmness === 'explicit' ? 'explicit' : 'directional',
    })),
    claims: (x.claims || []).filter((c) => c.claim).slice(0, 8),
    pressure: (x.pressure || []).slice(0, 5),
    business: x.business, segments: (x.segments || []).slice(0, 6), risks: (x.risks || []).slice(0, 5),
    cost: meter.cost(),
  };
}

/** Terms that find the pages worth reading in a 300-page annual report. Weights are hand-set, not learned. */
const AR_TERMS: Record<string, number> = {
  'management discussion': 6, 'segment': 3, 'revenue mix': 4, 'business overview': 4, 'product portfolio': 2, 'market share': 2,
  'contingent liabilit': 6, 'related party': 4, 'qualified opinion': 8, 'emphasis of matter': 6, 'key audit matter': 4,
  'material uncertainty': 7, 'going concern': 5, 'pledge': 3, 'capacity utili': 2, 'geograph': 2, 'order book': 2,
};

/**
 * Annual report: never sent whole. Text is extracted locally (free), pages are scored against
 * AR_TERMS, and only the top dozen go to the cheap model — roughly 4% of the document.
 */
export async function readAnnualReport(doc: DocLink, company: string, meter: Meter): Promise<ArNotes> {
  const pdf = await pdfText(doc.url, 60_000_000);
  if (pdf.scanned) throw new Error('Annual report has no text layer');
  const pick = topPages(pdf.pages, AR_TERMS, 12);
  const body = pick.map((i) => `\n=== PAGE ${i + 1} ===\n${pdf.pages[i].slice(0, 5500)}\n`).join('');
  const x = await ask<{ business?: string; segments?: { name: string; share?: string; note: string }[]; red_flags?: { kind: string; text: string; page?: number }[] }>({
    tier: 'fast', version: 'ar-v2', meter, maxOut: 3000,
    system: `You are reading selected pages of ${company}'s annual report${doc.period ? ` ${doc.period}` : ''}. ${GROUND}`,
    user:
      'Return JSON: {"business":"<=50 words: what the company does and how it makes money",' +
      '"segments":[{"name":"","share":"% of revenue if printed","note":"<=14 words"}],' +
      '"red_flags":[{"kind":"contingent_liability|related_party|auditor|pledge|other","text":"<=22 words with the rupee amount","page":0}]}\n' +
      'red_flags: only what is actually disclosed on these pages — contingent liabilities with amounts, large related-party transactions, any auditor qualification or emphasis of matter. An unqualified audit report is not a flag. Max 6 segments, 5 flags.\n' + body,
  });
  return { url: doc.url, year: doc.period, business: x.business || '', segments: (x.segments || []).slice(0, 6), redFlags: (x.red_flags || []).slice(0, 5), pagesRead: pick.map((i) => i + 1), totalPages: pdf.total, cost: meter.cost() };
}
