import { fyQuarter, pct, reportedQuarterEnd, round } from '../util';
import { row } from '../sources/screener';
import type { CompanyData, Metric, ResultsCut } from '../types';

const metric = (key: string, r: (number | null)[], i: number): Metric => {
  const cur = r[i] ?? null, prev = i >= 1 ? r[i - 1] ?? null : null, yago = i >= 4 ? r[i - 4] ?? null : null;
  return { key, cur, prev, yago, qoq: round(pct(cur, prev)), yoy: round(pct(cur, yago)), unit: 'cr' };
};

/**
 * First cut of a results filing: Revenue, EBITDA, PBT, PAT — this quarter vs last (QoQ) and vs
 * the same quarter a year ago (YoY). No model: it is a table lookup and subtraction.
 * EBITDA here is operating profit before other income (revenue − operating expenses), the
 * standard screen definition. Lenders have no meaningful EBITDA, so they get net interest income.
 */
export function resultsCut(c: CompanyData, filedAt?: Date): ResultsCut | null {
  const q = c.quarters;
  if (!q.periods.length) return null;
  let i = q.periods.length - 1;
  let note: string | undefined;
  if (filedAt) {
    const want = reportedQuarterEnd(filedAt);
    const at = q.periods.indexOf(want);
    if (at >= 0) i = at;
    else note = `Standardised table still ends at ${q.periods[i]}; ${want} not in yet`;
  }
  const rev = row(q, 'Sales', 'Revenue');
  // Lenders: EBITDA means nothing. Their operating line is net interest income = interest earned − interest paid.
  const interest = row(q, 'Interest');
  const op = c.lender ? rev.map((r, k) => (r != null && interest[k] != null ? r - interest[k]! : null)) : row(q, 'Operating Profit');
  const pbt = row(q, 'Profit before tax');
  const pat = row(q, 'Net Profit');
  const metrics = [
    metric('Revenue', rev, i),
    metric(c.lender ? 'Net interest inc.' : 'EBITDA', op, i),
    metric('PBT', pbt, i),
    metric('PAT', pat, i),
  ];
  const m = (k: number) => (rev[k] && op[k] != null ? (op[k]! / rev[k]!) * 100 : null);
  const cur = round(m(i)), yago = i >= 4 ? round(m(i - 4)) : null;
  const bps = cur != null && yago != null ? Math.round((cur - yago) * 100) : null;
  const sign = (n: number | null) => (n == null ? 'n/a' : `${n > 0 ? '+' : ''}${n}%`);
  const label = c.lender ? 'Net interest income, share of interest earned' : 'EBITDA margin';
  const line =
    `Revenue ${sign(metrics[0].yoy)} YoY, PAT ${sign(metrics[3].yoy)} YoY` +
    (c.lender ? `; net interest income ${sign(metrics[1].yoy)} YoY` : cur != null ? `; EBITDA margin ${cur}%` + (bps != null ? ` (${bps > 0 ? '+' : ''}${bps} bps YoY)` : '') : '');
  return { kind: 'results', period: fyQuarter(q.periods[i]), periodEnd: q.periods[i], metrics, margin: { cur, yago, bps, label }, line, source: 'screener', note };
}
