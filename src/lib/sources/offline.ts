import { readFileSync } from 'node:fs';
import path from 'node:path';
import { callQuarter } from '../util';
import type { CompanyData } from '../types';
import type { BseRow } from './bse';

/**
 * Replay mode. FINN_OFFLINE=<dir> makes the three sources read a recorded harvest
 * (screener.json, bse.json, yahoo.json) instead of the network, so the whole pipeline —
 * classification, folding, results cuts, research arithmetic — can be run and tested
 * end to end on real data from a machine with no internet access.
 */
const DIR = process.env.FINN_OFFLINE;
export const offline = Boolean(DIR);
const memo = new Map<string, unknown>();
function load<T>(file: string): T {
  if (!memo.has(file)) memo.set(file, JSON.parse(readFileSync(path.join(process.cwd(), DIR!, file), 'utf8')));
  return memo.get(file) as T;
}

type Harvested = Omit<CompanyData, 'concalls'> & { concallsRaw: { period: string; url: string }[] };

export function offlineCompany(symbol: string): CompanyData {
  const h = load<Record<string, Harvested>>('screener.json')[symbol];
  if (!h) throw new Error(`No financials found for "${symbol}" in the recorded harvest`);
  const { concallsRaw, ...rest } = h;
  return { ...rest, concalls: concallsRaw.map((c) => { const { quarter } = callQuarter(c.period); return { title: `${quarter} earnings call`, url: c.url, period: c.period, quarter }; }) };
}
export const offlineRows = (scrip: number): BseRow[] => load<Record<string, BseRow[]>>('bse.json')[String(scrip)] || [];
export function offlineChart<T>(symbol: string): T {
  const c = load<Record<string, T>>('yahoo.json')[symbol];
  if (!c) throw new Error(`No price data for ${symbol} in the recorded harvest`);
  return c;
}
