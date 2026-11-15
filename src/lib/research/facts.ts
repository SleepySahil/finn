import { fmtCr, fyQuarter, fyYear, pct, round } from '../util';
import { row } from '../sources/screener';
import type { CompanyData, Facts, Flag } from '../types';

const last = <T,>(a: T[], n = 1) => a[a.length - n];
const tail = <T,>(a: T[], n: number) => a.slice(Math.max(0, a.length - n));
const cagr = (a: (number | null)[], yrs: number): number | null => {
  const end = last(a), start = a[a.length - 1 - yrs];
  if (end == null || start == null || start <= 0 || end <= 0) return null;
  return round((Math.pow(end / start, 1 / yrs) - 1) * 100);
};
const sum = (a: (number | null)[]) => a.reduce<number>((x, y) => x + (y ?? 0), 0);

/**
 * Four of the eight research outputs — financial snapshot, trajectory, balance sheet, cash
 * quality — need no model at all. They are arithmetic on reported numbers, and the "flags"
 * are thresholds an analyst would apply by eye. A model would only add latency and a chance
 * of a wrong digit. The model is saved for what code cannot do: reading management.
 */
export function buildFacts(c: CompanyData): Facts {
  const P = c.pnl, B = c.balance, C = c.cash, R = c.ratios, Q = c.quarters;

  // ---- annual: drop the TTM column for year-on-year work ----
  const yearsAll = P.periods;
  const ttmAt = yearsAll.indexOf('TTM');
  const cut = <T,>(a: T[]) => (ttmAt >= 0 ? a.slice(0, ttmAt) : a);
  const years = cut(yearsAll);
  const rev = cut(row(P, 'Sales', 'Revenue'));
  // margin from the two lines themselves: the table's own "OPM %" is rounded to a whole percent
  const margin = (t: typeof P) => {
    const r = row(t, 'Sales', 'Revenue'), o = row(t, c.lender ? 'Financing Profit' : 'Operating Profit'), printed = row(t, c.lender ? 'Financing Margin %' : 'OPM %', 'OPM %');
    return r.map((v, i) => (v && o[i] != null ? round((o[i]! / v) * 100) : printed[i] ?? null));
  };
  const opm = cut(margin(P));
  const pat = cut(row(P, 'Net Profit'));
  const ttm = (label: string, ...alt: string[]) => (ttmAt >= 0 ? row(P, label, ...alt)[ttmAt] : last(row(P, label, ...alt)));

  const flagsT: Flag[] = [];
  const r3 = cagr(rev, 3), p3 = cagr(pat, 3), r5 = cagr(rev, 5), p5 = cagr(pat, 5);
  if (r3 != null && p3 != null) {
    if (p3 < r3 - 3) flagsT.push({ tone: 'bad', text: `Profit compounding slower than revenue over 3 years (${p3}% vs ${r3}%) — margins are giving back.` });
    else if (p3 > r3 + 3) flagsT.push({ tone: 'good', text: `Profit compounding faster than revenue over 3 years (${p3}% vs ${r3}%) — operating leverage is showing.` });
  }
  const o = opm.filter((x): x is number => x != null);
  if (o.length >= 4) {
    const now = last(o), then = o[o.length - 4];
    const d = Math.round((now - then) * 100);
    if (Math.abs(d) >= 150) flagsT.push({ tone: d > 0 ? 'good' : 'bad', text: `${c.lender ? 'Financing' : 'Operating'} margin ${d > 0 ? 'expanded' : 'compressed'} ${Math.abs(d)} bps in three years (${then}% → ${now}%).` });
  }
  if (r3 != null && r5 != null && r3 < r5 - 4) flagsT.push({ tone: 'bad', text: `Growth is decelerating: 3-year revenue CAGR ${r3}% vs 5-year ${r5}%.` });
  if (r3 != null && r5 != null && r3 > r5 + 4) flagsT.push({ tone: 'good', text: `Growth is accelerating: 3-year revenue CAGR ${r3}% vs 5-year ${r5}%.` });

  // ---- quarterly ----
  const qRev = row(Q, 'Sales', 'Revenue'), qPat = row(Q, 'Net Profit');
  const qOpm = margin(Q);
  const yoy = (a: (number | null)[]) => a.map((v, i) => (i >= 4 ? round(pct(v, a[i - 4])) : null));

  // ---- balance sheet ----
  const bYears = B.periods;
  const debt = row(B, 'Borrowings', 'Borrowing');
  const equity = bYears.map((_, i) => {
    const e = row(B, 'Equity Capital')[i], r = row(B, 'Reserves')[i];
    return e == null && r == null ? null : (e ?? 0) + (r ?? 0);
  });
  const de = debt.map((d, i) => (d != null && equity[i] ? round(d / equity[i]!, 2) : null));
  const ccc = row(R, 'Cash Conversion Cycle'), dDays = row(R, 'Debtor Days'), iDays = row(R, 'Inventory Days'), roce = row(R, 'ROCE %', 'ROE %');
  const flagsB: Flag[] = [];
  const deNow = last(de), dePrev = de[de.length - 4];
  if (!c.lender && deNow != null) {
    if (deNow < 0.15) flagsB.push({ tone: 'good', text: `Effectively debt-free: debt is ${deNow}× equity.` });
    else if (deNow > 1.5) flagsB.push({ tone: 'bad', text: `Heavily geared: debt is ${deNow}× equity.` });
    if (dePrev != null && deNow - dePrev > 0.3) flagsB.push({ tone: 'bad', text: `Leverage rising: debt/equity ${dePrev}× → ${deNow}× over three balance sheets.` });
    if (dePrev != null && dePrev - deNow > 0.3) flagsB.push({ tone: 'good', text: `De-leveraging: debt/equity ${dePrev}× → ${deNow}×.` });
  }
  const cNow = last(ccc), cPrev = ccc[ccc.length - 4];
  if (cNow != null && cPrev != null && Math.abs(cNow - cPrev) >= 15)
    flagsB.push({ tone: cNow > cPrev ? 'bad' : 'good', text: `Working-capital cycle ${cNow > cPrev ? 'stretched' : 'tightened'} from ${cPrev} to ${cNow} days in three years${cNow > cPrev ? ' — more cash tied up per rupee of sales' : ''}.` });
  const dNow = last(dDays), dPrev = dDays[dDays.length - 3];
  if (dNow != null && dPrev != null && dNow - dPrev >= 12) flagsB.push({ tone: 'bad', text: `Customers are paying slower: debtor days ${dPrev} → ${dNow}.` });
  const rNow = last(roce), rPrev = roce[roce.length - 4];
  if (rNow != null && rPrev != null && Math.abs(rNow - rPrev) >= 5) flagsB.push({ tone: rNow > rPrev ? 'good' : 'bad', text: `Return on capital ${rNow > rPrev ? 'improved' : 'fell'} from ${rPrev}% to ${rNow}%.` });

  // ---- cash quality ----
  const cYears = C.periods;
  const cfo = row(C, 'Cash from Operating Activity');
  const fcf = row(C, 'Free Cash Flow');
  const patByYear = cYears.map((y) => { const k = years.indexOf(y); return k >= 0 ? pat[k] : null; });
  const conv = cfo.map((x, i) => (x != null && patByYear[i] && patByYear[i]! > 0 ? Math.round((x / patByYear[i]!) * 100) : null));
  const n = Math.min(5, cYears.length);
  const cumCfo = sum(tail(cfo, n)), cumPat = sum(tail(patByYear, n));
  const ratio = cumPat > 0 ? Math.round((cumCfo / cumPat) * 100) : null;
  const flagsC: Flag[] = [];
  if (!c.lender && ratio != null) {
    if (ratio >= 90) flagsC.push({ tone: 'good', text: `Profits are real cash: ${n}-year operating cash flow is ${ratio}% of reported profit.` });
    else if (ratio < 60) flagsC.push({ tone: 'bad', text: `Only ${ratio}% of ${n}-year reported profit showed up as operating cash — find out where the rest is sitting.` });
    else flagsC.push({ tone: 'neutral', text: `${ratio}% of ${n}-year profit converted to operating cash.` });
  }
  if (c.lender) flagsC.push({ tone: 'neutral', text: 'Lender: operating cash flow mostly reflects loan growth, so cash conversion is not a quality signal here.' });
  const negFcf = tail(fcf, 3).filter((x) => x != null && x < 0).length;
  if (!c.lender && negFcf >= 2) flagsC.push({ tone: 'bad', text: `Free cash flow negative in ${negFcf} of the last 3 years — growth is being funded from outside.` });
  const convLast = last(conv), convAvg = tail(conv, 4).filter((x): x is number => x != null);
  if (!c.lender && convLast != null && convAvg.length >= 3 && convLast < 50 && convAvg.reduce((a, b) => a + b, 0) / convAvg.length > 80)
    flagsC.push({ tone: 'bad', text: `Latest year broke the pattern: cash conversion dropped to ${convLast}%.` });

  const lastQ = Q.periods.length - 1;
  const snapshot = [
    { label: 'Revenue (TTM)', value: fmtCr(ttm('Sales', 'Revenue') ?? null), sub: last(yoy(qRev)) != null ? `${last(yoy(qRev))! > 0 ? '+' : ''}${last(yoy(qRev))}% YoY last qtr` : undefined },
    { label: c.lender ? 'Financing margin' : 'EBITDA margin', value: last(qOpm) != null ? `${last(qOpm)}%` : '–', sub: lastQ >= 4 && qOpm[lastQ - 4] != null && last(qOpm) != null ? `${Math.round((last(qOpm)! - qOpm[lastQ - 4]!) * 100)} bps YoY` : undefined },
    { label: 'PAT (TTM)', value: fmtCr(ttm('Net Profit') ?? null), sub: last(yoy(qPat)) != null ? `${last(yoy(qPat))! > 0 ? '+' : ''}${last(yoy(qPat))}% YoY last qtr` : undefined },
    { label: 'ROCE', value: c.top['ROCE'] || '–', sub: c.top['ROE'] ? `ROE ${c.top['ROE']}` : undefined },
    { label: 'Debt / equity', value: deNow != null ? `${deNow}×` : '–', sub: last(debt) != null ? `${fmtCr(last(debt))} debt` : undefined },
    { label: 'P/E', value: c.top['Stock P/E'] || '–', sub: c.top['Market Cap'] ? `M-cap ${c.top['Market Cap']}` : undefined },
  ];

  return {
    symbol: c.symbol,
    name: c.name,
    lender: c.lender,
    asOf: `${fyQuarter(last(Q.periods) || '')} · ${c.consolidated ? 'consolidated' : 'standalone'}`,
    price: c.top['Current Price'],
    mcap: c.top['Market Cap'],
    snapshot,
    trajectory: {
      years: years.map(fyYear), revenue: rev, opm, pat, flags: flagsT,
      cagr: { 'Revenue 3y': r3 != null ? `${r3}%` : '–', 'Revenue 5y': r5 != null ? `${r5}%` : '–', 'PAT 3y': p3 != null ? `${p3}%` : '–', 'PAT 5y': p5 != null ? `${p5}%` : '–' },
    },
    quarters: { periods: Q.periods.map(fyQuarter), revenue: qRev, revYoy: yoy(qRev), opm: qOpm, pat: qPat, patYoy: yoy(qPat) },
    balance: { years: bYears.map((y) => (/^Mar/.test(y) ? fyYear(y) : y)), debt, equity, de, ccc, debtorDays: dDays, inventoryDays: iDays, roce, flags: flagsB },
    cash: { years: cYears.map(fyYear), cfo, pat: patByYear, fcf, conv, cum: { cfo: cumCfo, pat: cumPat, ratio, n }, flags: flagsC },
    docs: { concalls: c.concalls.slice(0, 8), annualReports: c.annualReports.slice(0, 3) },
  };
}

/** The compact numeric context handed to the model when it judges management's promises. */
export function factsForModel(f: Facts): string {
  const q = f.quarters;
  const n = q.periods.length;
  const from = Math.max(0, n - 9);
  const lines = ['QUARTERLY (Rs crore) — period | revenue | revenue YoY % | operating margin % | PAT | PAT YoY %'];
  for (let i = from; i < n; i++) lines.push(`${q.periods[i]} | ${q.revenue[i] ?? 'na'} | ${q.revYoy[i] ?? 'na'} | ${q.opm[i] ?? 'na'} | ${q.pat[i] ?? 'na'} | ${q.patYoy[i] ?? 'na'}`);
  const t = f.trajectory, m = t.years.length;
  lines.push('', 'ANNUAL (Rs crore) — year | revenue | revenue growth % | operating margin % | PAT');
  for (let i = Math.max(1, m - 5); i < m; i++) lines.push(`${t.years[i]} | ${t.revenue[i] ?? 'na'} | ${round(pct(t.revenue[i], t.revenue[i - 1])) ?? 'na'} | ${t.opm[i] ?? 'na'} | ${t.pat[i] ?? 'na'}`);
  const b = f.balance, c = f.cash;
  lines.push('', `BALANCE SHEET — latest debt/equity ${last(b.de) ?? 'na'}x, cash conversion cycle ${last(b.ccc) ?? 'na'} days, ROCE ${last(b.roce) ?? 'na'}%`);
  lines.push(`CASH — ${c.cum.n}-year operating cash flow ${c.cum.cfo} vs PAT ${c.cum.pat} (${c.cum.ratio ?? 'na'}%); free cash flow by year: ${c.years.slice(-4).map((y, i) => `${y} ${tail(c.fcf, 4)[i] ?? 'na'}`).join(', ')}`);
  return lines.join('\n');
}
