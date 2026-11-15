import { getJson } from '../http';
import type { Bars } from '../types';
import { offline, offlineChart } from './offline';

interface YChart {
  chart: {
    result?: {
      meta: { longName?: string; shortName?: string; fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number };
      timestamp?: number[];
      indicators: { quote: { close: (number | null)[]; volume: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

/** End-of-day price & volume. Same endpoint yfinance wraps; NSE tickers take a .NS suffix. */
export async function getBars(symbol: string, range = '1y'): Promise<Bars> {
  if (offline) return parseBars(symbol, offlineChart<YChart>(symbol));
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}.NS?range=${range}&interval=1d`;
  let j: YChart;
  try {
    j = await getJson<YChart>(`https://query1.finance.yahoo.com${path}`, { revalidate: 1800 });
  } catch {
    j = await getJson<YChart>(`https://query2.finance.yahoo.com${path}`, { revalidate: 1800 });
  }
  return parseBars(symbol, j);
}

export function parseBars(symbol: string, j: YChart): Bars {
  const r = j.chart?.result?.[0];
  if (!r || !r.timestamp) throw new Error(j.chart?.error?.description || `No price data for ${symbol}`);
  const q = r.indicators.quote[0];
  const t: number[] = [], c: number[] = [], v: number[] = [];
  let lastDay = '';
  r.timestamp.forEach((ts, i) => {
    const close = q.close[i], vol = q.volume[i];
    if (close == null || vol == null || vol === 0) return;      // holidays and half-filled rows
    const day = new Date((ts + 19800) * 1000).toISOString().slice(0, 10);
    if (day === lastDay) { c[c.length - 1] = close; v[v.length - 1] = vol; return; }
    lastDay = day;
    t.push(ts); c.push(Math.round(close * 100) / 100); v.push(vol);
  });
  return { symbol, name: r.meta.longName || r.meta.shortName, t, c, v, hi52: r.meta.fiftyTwoWeekHigh, lo52: r.meta.fiftyTwoWeekLow };
}
