'use client';
import { useCallback, useEffect, useState } from 'react';

// ---------- formatting (everything is shown in IST, whatever the phone's zone) ----------
const istDay = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' });
const istTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const istDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const istKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

export function when(iso: string): string {
  const d = new Date(iso);
  const age = Date.now() - d.getTime();
  if (istKey.format(d) === istKey.format(new Date())) return `Today ${istTime.format(d)}`;
  if (age < 6 * 86400e3) return `${istDay.format(d)} ${istTime.format(d)}`;
  return istDate.format(d);
}
export const longWhen = (ms: number) => `${istDay.format(ms)} ${istDate.format(ms)}, ${istTime.format(ms)}`;

export const cr = (n: number | null | undefined): string => {
  if (n == null) return '–';
  const a = Math.abs(n);
  if (a >= 100000) return `${(n / 100000).toFixed(2)}L`;
  return n.toLocaleString('en-IN', { maximumFractionDigits: a < 100 ? 1 : 0 });
};
export const signed = (n: number | null | undefined, d = 1) => (n == null ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}%`);
export const tone = (n: number | null | undefined) => (n == null || n === 0 ? '' : n > 0 ? 'up' : 'down');
export const cleanSubject = (s: string) =>
  s.replace(/^Announcement under Regulation 30\s*(\(LODR\))?\s*[-–:]?\s*/i, '').replace(/^Disclosure under Regulation 30[^-]*-\s*/i, '').replace(/\s+/g, ' ').trim();

export function Delta({ label, v }: { label: string; v: number | null }) {
  return (
    <span className={tone(v)}>
      <span>{label}</span>
      {signed(v)}
    </span>
  );
}

// ---------- persisted state ----------
export function useLocal<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void, boolean] {
  const [v, setV] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setV({ ...(initial as object), ...JSON.parse(raw) } as T);
    } catch {}
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T | ((p: T) => T)) =>
      setV((p) => {
        const n = typeof next === 'function' ? (next as (p: T) => T)(p) : next;
        try { localStorage.setItem(key, JSON.stringify(n)); } catch {}
        return n;
      }),
    [key],
  );
  return [v, set, ready];
}

// ---------- tiny charts, hand-drawn so they stay dense and on-palette ----------
export function Spark({ data, w = 120, h = 36, mark = true }: { data: number[]; w?: number; h?: number; mark?: boolean }) {
  if (data.length < 2) return null;
  const lo = Math.min(...data), hi = Math.max(...data), r = hi - lo || 1;
  const x = (i: number) => (i / (data.length - 1)) * (w - 6) + 3;
  const y = (v: number) => h - 4 - ((v - lo) / r) * (h - 8);
  const d = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = data[data.length - 1], prev = data[data.length - 2];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.75" />
      {mark && <rect x={x(data.length - 1) - 3} y={y(last) - 3} width="6" height="6" fill={last >= prev ? 'var(--up)' : 'var(--down)'} />}
    </svg>
  );
}

interface Series { name: string; values: (number | null)[]; color: string }
/** Grouped bars with an optional line on its own scale (e.g. revenue bars, margin line). */
export function Bars({ labels, series, line, h = 132, unit = '' }: { labels: string[]; series: Series[]; line?: { name: string; values: (number | null)[]; unit: string }; h?: number; unit?: string }) {
  const W = 340, top = 16, bottom = 20, n = labels.length;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  if (!n || !all.length) return null;
  const hi = Math.max(0, ...all), lo = Math.min(0, ...all), r = hi - lo || 1;
  const y = (v: number) => top + ((hi - v) / r) * (h - top - bottom);
  const slot = W / n, bw = Math.min(22, (slot * 0.72) / series.length);
  const lv = (line?.values || []).filter((v): v is number => v != null);
  const lhi = Math.max(...lv, 1), llo = Math.min(...lv, 0), lr = lhi - llo || 1;
  const ly = (v: number) => top + 4 + ((lhi - v) / lr) * (h - top - bottom - 8);
  const pts = (line?.values || []).map((v, i) => (v == null ? null : [slot * i + slot / 2, ly(v)] as const));
  const lastIdx = n - 1;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`${series.map((s) => s.name).join(' and ')} by period`}>
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--ink-3)" strokeWidth="1" />
      {labels.map((l, i) => (
        <g key={l + i}>
          {series.map((s, k) => {
            const v = s.values[i];
            if (v == null) return null;
            const x = slot * i + slot / 2 - (bw * series.length) / 2 + bw * k;
            return <rect key={s.name} x={x} width={bw - 1.5} y={Math.min(y(v), y(0))} height={Math.max(1, Math.abs(y(v) - y(0)))} fill={s.color} opacity={series.length === 1 && i !== lastIdx ? 0.55 : 1} />;
          })}
          {(n <= 8 || i % 2 === (lastIdx % 2)) && (
            <text x={slot * i + slot / 2} y={h - 5} textAnchor="middle" fontSize="10" fill="var(--ink-2)" style={{ fontStretch: '75%' }}>{l.replace('FY', "'").replace(/^([A-Z][a-z]{2}) 20(\d\d)$/, "$1'$2")}</text>
          )}
        </g>
      ))}
      {series.length === 1 && series[0].values[lastIdx] != null && (
        <text x={slot * lastIdx + slot / 2} y={y(series[0].values[lastIdx]!) - 4} textAnchor="middle" fontSize="10.5" fontWeight="700" fill="var(--ink)" style={{ fontStretch: '75%' }}>{cr(series[0].values[lastIdx])}{unit}</text>
      )}
      {line && pts.some(Boolean) && (
        <g>
          <path d={pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p![0].toFixed(1)},${p![1].toFixed(1)}`).join('')} fill="none" stroke="var(--down)" strokeWidth="1.6" />
          {pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r="2.4" fill="var(--paper)" stroke="var(--down)" strokeWidth="1.4" />)}
        </g>
      )}
    </svg>
  );
}

export function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.name}><i style={{ background: i.color }} />{i.name}</span>
      ))}
    </div>
  );
}

export const Icon = {
  mic: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
  ),
  play: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
  ),
  stop: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" /></svg>
  ),
};
