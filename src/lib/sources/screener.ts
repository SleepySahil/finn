import * as cheerio from 'cheerio';
import { getJson, getText } from '../http';
import { callQuarter, num } from '../util';
import { directPdf } from './bse';
import { offline, offlineCompany } from './offline';
import type { CompanyData, DocLink, Table } from '../types';

const BASE = 'https://www.screener.in';
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Fundamentals. screener.in standardises company-reported financials and links every annual
 * report and concall transcript back to the exchange PDF. We take the numbers and the links —
 * never its commentary (the "About", "Key points", "Pros/Cons" and AI summaries are someone
 * else's reading, and the pull side is primary-source only).
 */
export function parseCompany(html: string, symbol: string, consolidated: boolean): CompanyData {
  const $ = cheerio.load(html);

  const table = (id: string): Table => {
    const tb = $(`#${id} table.data-table`).first().length ? $(`#${id} table.data-table`).first() : $(`#${id} table`).first();
    const periods = tb.find('thead th').slice(1).map((_, th) => clean($(th).text())).get();
    const rows: Record<string, (number | null)[]> = {};
    tb.find('tbody tr').each((_, tr) => {
      const tds = $(tr).children('td');
      const first = tds.first().clone();
      first.find('.has-tooltip, .tooltip, .blue-icon').remove();
      const label = clean(first.text()).replace(/\s*\+$/, '');
      if (!label || label === 'Raw PDF') return;
      // toArray(), not .map().get(): cheerio's map drops nulls and would shift columns
      rows[label] = tds.slice(1).toArray().map((td) => num(clean($(td).text())));
    });
    return { periods, rows };
  };

  const top: Record<string, string> = {};
  $('#top-ratios li').each((_, li) => {
    const k = clean($(li).find('.name').text());
    const v = clean($(li).find('.value').text());
    if (k) top[k] = v;
  });

  let scrip: number | undefined;
  let nse = symbol;
  $('#top a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const b = href.match(/bseindia\.com\/stock-share-price\/.*\/(\d{6})\/?$/);
    if (b) scrip = Number(b[1]);
    const n = href.match(/nseindia\.com\/get-quotes\/equity\?symbol=([^&]+)/);
    if (n) nse = decodeURIComponent(n[1]);
  });

  const growth: Record<string, Record<string, string>> = {};
  $('#profit-loss table.ranges-table').each((_, tb) => {
    const title = clean($(tb).find('th').first().text());
    const g: Record<string, string> = {};
    $(tb).find('tr').slice(1).each((_, tr) => {
      const tds = $(tr).find('td');
      const k = clean(tds.eq(0).text()).replace(/:$/, '');
      if (k) g[k] = clean(tds.eq(1).text());
    });
    if (title) growth[title] = g;
  });

  const seen = new Set<string>();
  const annualReports: DocLink[] = [];
  $('#documents .annual-reports li a[href]').each((_, a) => {
    const url = directPdf($(a).attr('href') || '');
    const title = clean($(a).text());
    if (!url || seen.has(url) || !/annual report/i.test(title)) return;
    seen.add(url);
    annualReports.push({ title, url, period: (title.match(/\d{4}/) || [])[0] });
  });

  const concalls: DocLink[] = [];
  $('#documents .concalls li').each((_, li) => {
    const label = clean($(li).children('div').first().text());
    const a = $(li).find('a[title="Raw Transcript"]').first().length
      ? $(li).find('a[title="Raw Transcript"]').first()
      : $(li).find('a').filter((_, x) => /^transcript$/i.test(clean($(x).text()))).first();
    const href = a.attr('href');
    if (!href || !label) return;
    const url = directPdf(href);
    if (seen.has(url)) return;
    seen.add(url);
    const { quarter } = callQuarter(label);
    concalls.push({ title: `${quarter} earnings call`, url, period: label, quarter });
  });

  const quarters = table('quarters');
  const lender = 'Financing Profit' in quarters.rows || 'Financing Margin %' in quarters.rows;

  return {
    symbol: nse,
    name: clean($('h1').first().text()) || symbol,
    scrip,
    consolidated,
    lender,
    top,
    quarters,
    pnl: table('profit-loss'),
    balance: table('balance-sheet'),
    cash: table('cash-flow'),
    ratios: table('ratios'),
    holding: table('shareholding'),
    growth,
    annualReports,
    concalls,
    fetchedAt: new Date().toISOString(),
  };
}

/** Any NSE ticker. Prefers consolidated numbers; falls back to standalone when a company has no subsidiaries. */
export async function getCompany(symbol: string, revalidate = 21600): Promise<CompanyData> {
  if (offline) return offlineCompany(symbol.toUpperCase().trim());
  const sym = encodeURIComponent(symbol.toUpperCase().trim());
  const fetchOne = async (consolidated: boolean) => {
    const html = await getText(`${BASE}/company/${sym}/${consolidated ? 'consolidated/' : ''}`, { revalidate, timeout: 15000 });
    return parseCompany(html, symbol.toUpperCase(), consolidated);
  };
  let c = await fetchOne(true);
  const empty = (x: CompanyData) => !x.quarters.periods.length || !Object.values(x.quarters.rows).some((r) => r.some((v) => v != null));
  if (empty(c)) c = await fetchOne(false);
  if (empty(c)) throw new Error(`No financials found for "${symbol}" — is it an NSE ticker?`);
  return c;
}

export interface SearchHit { symbol: string; name: string }
export async function searchCompanies(q: string): Promise<SearchHit[]> {
  const j = await getJson<{ name: string; url: string }[]>(`${BASE}/api/company/search/?q=${encodeURIComponent(q)}`, { revalidate: 86400, timeout: 8000 });
  return j
    .map((x) => ({ name: x.name, symbol: decodeURIComponent((x.url.match(/\/company\/([^/]+)\//) || [])[1] || '') }))
    .filter((x) => x.symbol && !/^\d+$/.test(x.symbol))   // BSE-only names resolve to a number, not an NSE ticker
    .slice(0, 8);
}

/** Row lookup tolerant of screener's label variants (Sales vs Revenue, Operating vs Financing Profit). */
export function row(t: Table, ...names: string[]): (number | null)[] {
  for (const n of names) if (t.rows[n]) return t.rows[n];
  const keys = Object.keys(t.rows);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase().startsWith(n.toLowerCase()));
    if (k) return t.rows[k];
  }
  return t.periods.map(() => null);
}
