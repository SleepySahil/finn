import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCompany } from '../src/lib/sources/screener';
import { normalise, directPdf, type BseRow } from '../src/lib/sources/bse';
import { parseBars } from '../src/lib/sources/yahoo';
import { classify, foldEvents, tierFor } from '../src/lib/brain/classify';
import { alerts, backtest, reading, DEFAULT_THRESHOLDS } from '../src/lib/brain/signals';
import { resultsCut } from '../src/lib/brain/results';
import { buildFacts, factsForModel } from '../src/lib/research/facts';
import { codeLedger, qOrder } from '../src/lib/research/synth';
import { callQuarter, fyQuarter, num, reportedQuarterEnd } from '../src/lib/util';
import { topPages } from '../src/lib/sources/pdf';
import type { Bars, CallNotes, Filing } from '../src/lib/types';

const fx = (f: string) => readFileSync(`tests/fixtures/${f}`, 'utf8');
const co = parseCompany(fx('screener-company.html'), 'TESTCO', true);
const H = { symbol: 'POLYCAB', name: 'Polycab India', sector: 'Cables', cap: 'Large' as const };
const filings: Filing[] = (JSON.parse(fx('bse-announcements.json')).Table as BseRow[]).map((r) => { const n = normalise(r); return { ...n, symbol: H.symbol, company: H.name, ...classify(n) }; });
const by = (re: RegExp) => filings.find((f) => re.test(f.subject))!;

describe('util', () => {
  it('parses Indian number formats', () => {
    expect(num('1,19,121')).toBe(119121); expect(num('+27%')).toBe(27); expect(num('₹ 7,904')).toBe(7904); expect(num('')).toBeNull(); expect(num('-173')).toBe(-173);
  });
  it('maps quarter ends and call months to Indian fiscal quarters', () => {
    expect(fyQuarter('Sep 2026')).toBe('Q2 FY27'); expect(fyQuarter('Mar 2026')).toBe('Q4 FY26'); expect(fyQuarter('Dec 2025')).toBe('Q3 FY26'); expect(fyQuarter('Jun 2026')).toBe('Q1 FY27');
    expect(callQuarter('Oct 2026').quarter).toBe('Q2 FY27'); expect(callQuarter('Jan 2026').quarter).toBe('Q3 FY26'); expect(callQuarter('May 2026').quarter).toBe('Q4 FY26');
    expect(reportedQuarterEnd(new Date('2026-10-15T08:00:00Z'))).toBe('Sep 2026');
    expect(qOrder('Q4 FY26')).toBeLessThan(qOrder('Q1 FY27'));
  });
});

describe('screener parser (real page structure)', () => {
  it('reads identity, codes and headline ratios', () => {
    expect(co.name).toBe('Testco India Ltd'); expect(co.scrip).toBe(542652); expect(co.symbol).toBe('TESTCO');
    expect(co.top['Market Cap']).toContain('1,19,121'); expect(co.top['ROCE']).toContain('33.2'); expect(co.lender).toBe(false);
  });
  it('reads tables positionally, including blanks and tooltip labels', () => {
    expect(co.quarters.periods).toHaveLength(13); expect(co.quarters.periods.at(-1)).toBe('Sep 2026');
    expect(co.quarters.rows['Sales'].at(-1)).toBe(9899); expect(co.quarters.rows['Raw PDF']).toBeUndefined();
    expect(co.pnl.periods.at(-1)).toBe('TTM');
    expect(co.ratios.rows['Inventory Days'][3]).toBeNull(); expect(co.ratios.rows['Inventory Days'][4]).toBe(128);
    expect(Object.keys(co.cash.rows)).toContain('CFO/EBITDA'); expect(co.cash.rows['Free Cash Flow'].at(-1)).toBe(2340);
    expect(co.growth['Compounded Sales Growth']['3 Years']).toBe('27%');
  });
  it('lists primary documents once each, with direct exchange PDF links', () => {
    expect(co.annualReports.map((a) => a.period)).toEqual(['2026', '2025', '2024']);
    expect(co.concalls).toHaveLength(5); expect(co.concalls[0]).toMatchObject({ quarter: 'Q2 FY27', period: 'Oct 2026' });
    expect(co.concalls[0].url).toBe('https://www.bseindia.com/xml-data/corpfiling/AttachHis/77b6d277.pdf');
    expect(directPdf('https://example.com/a.pdf')).toBe('https://example.com/a.pdf');
  });
});

describe('prices', () => {
  it('parses the Yahoo chart payload', () => {
    const b = parseBars('RELIANCE', JSON.parse(fx('yahoo-chart.json')));
    expect(b.c).toHaveLength(5); expect(b.c[1]).toBe(1324.4); expect(b.v[0]).toBe(22768301); expect(b.hi52).toBe(1611.8);
  });
});

describe('triage rules on real BSE subject lines', () => {
  it('surfaces what matters', () => {
    expect(by(/^Unaudited Financial Results/)).toMatchObject({ category: 'results', subtype: 'Results filed', tier: 'act' });
    expect(by(/CIRP/)).toMatchObject({ category: 'litigation', tier: 'act' });
  });
  it('buries the routine', () => {
    expect(by(/Analyst/)).toMatchObject({ category: 'investor_meetings', tier: 'bury' });
    expect(by(/ESOP/)).toMatchObject({ category: 'unclassified', tier: 'bury', noise: true });
    expect(by(/Audio Recording/)).toMatchObject({ category: 'earnings_call', tier: 'bury' });
  });
  it('notes the useful-but-not-urgent', () => {
    expect(by(/Transcript/)).toMatchObject({ category: 'earnings_call', subtype: 'Call transcript', tier: 'know' });
    expect(by(/Earnings Presentation/)).toMatchObject({ category: 'earnings_call', tier: 'know' });
  });
  const c = (subject: string, headline = '', lender = false) => classify({ subject, headline, bseCat: 'Company Update', bseSub: 'General' }, { lender });
  it('separates the signal inside a category', () => {
    expect(c('Announcement under Regulation 30 (LODR)-Resignation of Chief Financial Officer (CFO)')).toMatchObject({ category: 'management_change', tier: 'act' });
    expect(c('Announcement under Regulation 30 (LODR)-Resignation of Company Secretary / Compliance Officer')).toMatchObject({ category: 'management_change', tier: 'bury' });
    expect(c('Announcement under Regulation 30 (LODR)-Change in Directorate', 'Appointment of Independent Director')).toMatchObject({ category: 'management_change', tier: 'know' });
    expect(c('Appointment of Senior Vice President - Sales')).not.toMatchObject({ tier: 'act' });
    expect(c('Announcement under Regulation 30 (LODR)-Newspaper Publication', 'Newspaper advertisement of financial results')).toMatchObject({ category: 'results', tier: 'bury', noise: true });
    expect(c('Board Meeting Intimation for Considering And Approving The Unaudited Financial Results')).toMatchObject({ category: 'results', subtype: 'Results date set', tier: 'know' });
    expect(c('Announcement under Regulation 30 (LODR)-Credit Rating', 'CRISIL has reaffirmed the rating')).toMatchObject({ category: 'credit_rating', tier: 'bury' });
    expect(c('Announcement under Regulation 30 (LODR)-Credit Rating', 'ICRA has downgraded the long term rating')).toMatchObject({ category: 'credit_rating', tier: 'act' });
    expect(c('Announcement under Regulation 30 (LODR)-Acquisition')).toMatchObject({ category: 'm_and_a', tier: 'act' });
    expect(c('Announcement under Regulation 30 (LODR)-Updates on Acquisition')).toMatchObject({ category: 'm_and_a', tier: 'know' });
    expect(c('Clarification On Media Reports Regarding FEMA Non Compliance')).toMatchObject({ category: 'press_release', subtype: 'Rumour clarification', tier: 'act' });
    expect(c('Announcement under Regulation 30 (LODR)-Award of Order / Receipt of Order')).toMatchObject({ category: 'press_release', subtype: 'Order win', tier: 'know' });
    expect(c('Announcement under Regulation 30 (LODR)-Qualified Institutional Placement')).toMatchObject({ category: 'fund_raise', tier: 'act' });
    expect(c('Buyback of equity shares')).toMatchObject({ category: 'fund_raise', subtype: 'Buyback', tier: 'act' });
    expect(c('Reg. 31(1) creation of pledge on promoter shares')).toMatchObject({ category: 'pledging', tier: 'act' });
    expect(c('Resignation of Statutory Auditors')).toMatchObject({ tier: 'act' });
    expect(c('Closure of Trading Window')).toMatchObject({ tier: 'bury' });
    expect(c('Shareholder Meeting / Postal Ballot-Notice of Postal Ballot')).toMatchObject({ category: 'postal_ballot', tier: 'bury' });
    expect(c('Something nobody has seen before')).toMatchObject({ via: 'fallback', tier: 'bury' });
  });
  it('treats lender debt issuance as routine', () => {
    expect(c('Allotment of Non-Convertible Debentures')).toMatchObject({ category: 'fund_raise', tier: 'know' });
    expect(c('Allotment of Non-Convertible Debentures', '', true)).toMatchObject({ category: 'fund_raise', tier: 'bury' });
  });
  it('folds a results day into one card', () => {
    const folded = foldEvents(filings);
    const card = folded.find((f) => f.subtype === 'Results filed')!;
    expect(folded.filter((f) => f.subtype === 'Results filed')).toHaveLength(1);
    expect(card.related!.length).toBeGreaterThanOrEqual(5);
    expect(folded.length).toBe(filings.length - card.related!.length);
    expect(folded.some((f) => /Transcript/.test(f.subject))).toBe(true);   // filed 4 days later: its own row
  });
  it('lets the investor override routing without resurfacing noise', () => {
    const ad = { ...filings[0], ...c('Newspaper Publication', 'financial results advertisement') } as Filing;
    expect(tierFor(ad, { results: 'act' })).toBe('bury');
    expect(tierFor(by(/Transcript/), { earnings_call: 'act' })).toBe('act');
    expect(tierFor(by(/^Unaudited Financial Results/), { results: 'bury' })).toBe('bury');
  });
});

describe('results first cut', () => {
  it('computes QoQ and YoY for Revenue, EBITDA, PBT, PAT from the reported table', () => {
    const r = resultsCut(co, new Date('2026-10-15T08:00:00Z'))!;
    expect(r.period).toBe('Q2 FY27'); expect(r.metrics.map((m) => m.key)).toEqual(['Revenue', 'EBITDA', 'PBT', 'PAT']);
    expect(r.metrics[0]).toMatchObject({ cur: 9899, prev: 8210, yago: 6477, qoq: 20.6, yoy: 52.8 });
    expect(r.metrics[1].cur).toBe(9899 - 8476); expect(r.margin!.cur).toBe(14.4); expect(r.note).toBeUndefined();
    expect(r.line).toMatch(/Revenue \+52.8% YoY/);
  });
  it('says so when the table has not caught up with the filing', () => {
    expect(resultsCut(co, new Date('2027-01-20T08:00:00Z'))!.note).toMatch(/Dec 2026 not in yet/);
  });
});

describe('signals', () => {
  const mk = (c: number[], v: number[]): Bars => ({ symbol: 'X', c, v, t: c.map((_, i) => 1790000000 + i * 86400) });
  const flat = Array.from({ length: 40 }, () => 100), vol = Array.from({ length: 40 }, () => 1000);
  it('fires on volume and price thresholds the user sets', () => {
    const b = mk([...flat, 106], [...vol, 3500]);
    const s = reading(b, DEFAULT_THRESHOLDS)!;
    expect(s.chg).toBe(6); expect(s.volX).toBe(3.5); expect(s.fired).toEqual(['volume', 'move']);
    expect(reading(b, { volX: 4, movePct: 8, lookback: 20 })!.fired).toEqual([]);
  });
  it('backtests a threshold so it is chosen by consequence', () => {
    const b = mk([...flat, 106, 106, 99], [...vol, 3500, 1000, 1000]);
    expect(backtest({ X: b }, DEFAULT_THRESHOLDS, 30).total).toBe(2);
    expect(backtest({ X: b }, { volX: 5, movePct: 10, lookback: 20 }, 30).total).toBe(0);
    expect(alerts({ X: b }, DEFAULT_THRESHOLDS, 0)).toHaveLength(2);
  });
});

describe('research arithmetic', () => {
  const f = buildFacts(co);
  it('builds the numeric dossier without a model', () => {
    expect(f.snapshot[0].value).toContain('34,609'); expect(f.trajectory.years.at(-1)).toBe('FY26'); expect(f.trajectory.revenue).toHaveLength(12);
    expect(f.balance.de.at(-1)).toBe(0.02); expect(f.cash.cum.ratio).toBeGreaterThan(90);
    expect(f.balance.flags.some((x) => /debt-free/.test(x.text))).toBe(true);
    expect(f.balance.flags.some((x) => /tightened from 64 to 39 days/.test(x.text))).toBe(true);
    expect(f.docs.concalls[0].quarter).toBe('Q2 FY27');
    expect(factsForModel(f)).toMatch(/Q2 FY27 \| 9899 \| 52.8/);
  });
  it('judges numeric promises in code, not in the model', () => {
    const note = (quarter: string, g: Partial<CallNotes['guidance'][0]>): CallNotes => ({ url: 'https://x/y.pdf', quarter, period: '', pages: 20, claims: [], pressure: [], guidance: [{ metric: 'revenue_growth', statement: 's', quote: 'q', firmness: 'explicit', unit: '%', ...g } as CallNotes['guidance'][0]] });
    const rows = codeLedger([
      note('Q4 FY25', { horizon: 'FY26', low: 20, high: 22, page: 5 }),            // FY26 revenue grew 28.9% → delivered
      note('Q1 FY26', { metric: 'ebitda_margin', horizon: 'FY26', low: 16 }),       // FY26 margin 14% → missed
      note('Q4 FY26', { horizon: 'FY27', low: 60 }),                                // H1 FY27 running +46.2% → too early, behind
      note('Q1 FY27', { horizon: 'Q2 FY27', low: 50 }),                             // Q2 FY27 YoY +52.8% → delivered
      note('Q1 FY27', { metric: 'capex', horizon: 'FY27', low: 1000, unit: 'Rs crore' }),   // not measurable from the table → left to the reader
    ], f);
    expect(rows.map((r) => r.verdict)).toEqual(['delivered', 'missed', 'too_early', 'delivered']);
    expect(rows[0]).toMatchObject({ target: '20–22%', actual: '28.9%', actualPeriod: 'FY26', checked: 'code', page: 5 });
    expect(rows[2].gap).toMatch(/H1 FY27 running at 46\.\d% — behind/);
  });
});

describe('annual-report page ranking', () => {
  it('finds the pages worth reading without embeddings', () => {
    const pages = ['Notice of AGM', 'Management Discussion and Analysis: segment revenue mix', 'photo of the chairman', 'Notes: contingent liabilities not provided for ₹412 crore', 'CSR'];
    expect(topPages(pages, { 'management discussion': 6, 'contingent liabilit': 6, segment: 3 }, 2)).toEqual([1, 3]);
  });
});
