import type { Bars, Filing } from '../types';

/** What "unusual" means is the investor's call, not ours. These are only the starting values. */
export interface Thresholds { volX: number; movePct: number; lookback: number }
export const DEFAULT_THRESHOLDS: Thresholds = { volX: 2, movePct: 4, lookback: 20 };

export interface Signal {
  symbol: string;
  at: string;            // ISO date of the session
  close: number;
  chg: number;           // % vs previous close
  volX: number;          // volume ÷ average of the previous `lookback` sessions
  fired: ('volume' | 'move')[];
  spark: number[];       // last 30 closes
  near?: 'high' | 'low'; // within 2% of the 52-week extreme
  because?: { id: string; label: string };   // a filing from the same window that may explain it
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Reading for session i (default: the latest). Pure arithmetic — no model anywhere near this. */
export function reading(b: Bars, th: Thresholds, i = b.c.length - 1): Signal | null {
  if (i < 1 || i >= b.c.length) return null;
  const base = avg(b.v.slice(Math.max(0, i - th.lookback), i));
  const chg = ((b.c[i] - b.c[i - 1]) / b.c[i - 1]) * 100;
  const volX = base ? b.v[i] / base : 0;
  const fired: Signal['fired'] = [];
  if (volX >= th.volX) fired.push('volume');
  if (Math.abs(chg) >= th.movePct) fired.push('move');
  const near = b.hi52 && b.c[i] >= b.hi52 * 0.98 ? 'high' : b.lo52 && b.c[i] <= b.lo52 * 1.02 ? 'low' : undefined;
  return {
    symbol: b.symbol,
    at: new Date(b.t[i] * 1000).toISOString(),
    close: b.c[i],
    chg: Math.round(chg * 100) / 100,
    volX: Math.round(volX * 100) / 100,
    fired,
    spark: b.c.slice(Math.max(0, i - 29), i + 1),
    near: i === b.c.length - 1 ? near : undefined,
  };
}

/** Sessions inside the window that crossed a threshold, newest first, each tied to a nearby filing if there is one. */
export function alerts(prices: Record<string, Bars>, th: Thresholds, sinceMs: number, filings: Filing[] = []): Signal[] {
  const out: Signal[] = [];
  for (const b of Object.values(prices)) {
    for (let i = b.c.length - 1; i >= 1; i--) {
      // a session "happens" at the 15:30 IST close, which is what the bar's day ends on
      const closeMs = (Math.floor((b.t[i] + 19800) / 86400) * 86400 - 19800 + 15.5 * 3600) * 1000;
      if (closeMs < sinceMs) break;
      const s = reading(b, th, i);
      if (!s || !s.fired.length) continue;
      const hit = filings
        .filter((f) => f.symbol === b.symbol && f.tier !== 'bury' && Math.abs(Date.parse(f.at) - closeMs) < 30 * 3600e3)
        .sort((x, y) => (x.tier === 'act' ? 0 : 1) - (y.tier === 'act' ? 0 : 1))[0];
      if (hit) s.because = { id: hit.id, label: hit.subtype };
      s.at = new Date(closeMs).toISOString();
      out.push(s);
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || Math.abs(b.chg) - Math.abs(a.chg));
}

/**
 * "If I set it here, how often would FINN have interrupted me?" Counts alerts per session over
 * the last `sessions` trading days, so a threshold is chosen by its consequence, not by guesswork.
 */
export function backtest(prices: Record<string, Bars>, th: Thresholds, sessions = 60): { total: number; perWeek: number; byDay: number[]; names: number } {
  const byDay = new Array(sessions).fill(0);
  const names = new Set<string>();
  for (const b of Object.values(prices)) {
    const n = b.c.length;
    for (let k = 0; k < sessions; k++) {
      const i = n - 1 - k;
      if (i < 1) break;
      const s = reading(b, th, i);
      if (s && s.fired.length) { byDay[sessions - 1 - k]++; names.add(b.symbol); }
    }
  }
  const total = byDay.reduce((a, b) => a + b, 0);
  return { total, perWeek: Math.round((total / sessions) * 5 * 10) / 10, byDay, names: names.size };
}
