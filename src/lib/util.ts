// Client-safe helpers (no node imports): used by API routes and by the browser.

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** "1,19,121" → 119121 · "+27%" → 27 · "₹ 7,904" → 7904 · "" → null */
export function num(s: unknown): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (typeof s !== 'string') return null;
  const m = s.replace(/[₹,%\s]|Cr\.?/gi, '').replace(/^\+/, '');
  if (m === '' || m === '-' || m === '--') return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

export const pct = (cur: number | null, base: number | null): number | null =>
  cur == null || base == null || base === 0 ? null : ((cur - base) / Math.abs(base)) * 100;

export const round = (n: number | null, d = 1): number | null => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// ---- time: everything the exchanges publish is IST ----
const IST_MS = 5.5 * 3600 * 1000;
export const istNow = () => new Date(Date.now() + IST_MS);
/** yyyymmdd in IST for a Date */
export function ymdIST(d: Date): string {
  const x = new Date(d.getTime() + IST_MS);
  return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, '0')}${String(x.getUTCDate()).padStart(2, '0')}`;
}
/** BSE gives "2026-11-06T22:02:15.363" with no zone; it is IST. */
export const bseTime = (s: string) => (s ? s.replace(/\.\d+$/, '') + '+05:30' : new Date().toISOString());

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthIdx = (m: string) => MONTHS.findIndex((x) => x.toLowerCase() === m.slice(0, 3).toLowerCase());

/** Quarter-end label → fiscal label. "Sep 2026" → "Q2 FY27" (Indian FY ends in March). */
export function fyQuarter(periodEnd: string): string {
  const m = periodEnd.trim().match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return periodEnd;
  const mi = monthIdx(m[1]);
  const y = Number(m[2]);
  if (mi < 0) return periodEnd;
  const q = mi <= 2 ? 4 : mi <= 5 ? 1 : mi <= 8 ? 2 : 3;
  const fy = mi <= 2 ? y : y + 1;
  return `Q${q} FY${String(fy).slice(2)}`;
}

/** The quarter-end a document dated in `d` most plausibly reports on: the last quarter end before that month. */
export function reportedQuarterEnd(d: Date): string {
  const x = new Date(d.getTime() + IST_MS);
  const m = x.getUTCMonth();
  const y = x.getUTCFullYear();
  if (m <= 2) return `Dec ${y - 1}`;
  if (m <= 5) return `Mar ${y}`;
  if (m <= 8) return `Jun ${y}`;
  return `Sep ${y}`;
}

/** Concall list label ("Oct 2026") → the quarter that call discussed ("Q2 FY27"). */
export function callQuarter(label: string): { quarter: string; periodEnd: string } {
  const m = label.trim().match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return { quarter: label, periodEnd: label };
  const d = new Date(Date.UTC(Number(m[2]), Math.max(0, monthIdx(m[1])), 15));
  const periodEnd = reportedQuarterEnd(d);
  return { quarter: fyQuarter(periodEnd), periodEnd };
}

/** "Mar 2026" → "FY26" */
export const fyYear = (periodEnd: string) => {
  const m = periodEnd.match(/(\d{4})/);
  return m ? `FY${m[1].slice(2)}` : periodEnd;
};

export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fmtCr(n: number | null): string {
  if (n == null) return '–';
  const a = Math.abs(n);
  if (a >= 100000) return `₹${(n / 100000).toFixed(2)} L Cr`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: a < 100 ? 1 : 0 })} Cr`;
}
export const fmtPct = (n: number | null, d = 1) => (n == null ? '–' : `${n > 0 ? '+' : ''}${n.toFixed(d)}%`);
