'use client';
import { useMemo } from 'react';
import { CATEGORIES, CATEGORY_LABEL } from '@/lib/brain/classify';
import { backtest, reading, type Thresholds } from '@/lib/brain/signals';
import type { BriefPayload, Category, Tier } from '@/lib/types';
import type { Settings } from './Brief';
import { signed, Spark, tone } from './ui';

function Stepper({ value, step, min, max, fmt, onChange, label }: { value: number; step: number; min: number; max: number; fmt: (n: number) => string; onChange: (n: number) => void; label: string }) {
  const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button onClick={() => onChange(clamp(value - step))} aria-label={`Lower ${label}`}>−</button>
      <output>{fmt(value)}</output>
      <button onClick={() => onChange(clamp(value + step))} aria-label={`Raise ${label}`}>+</button>
    </span>
  );
}

const ROUTES: { v: Tier | 'auto'; l: string }[] = [{ v: 'auto', l: 'FINN' }, { v: 'act', l: 'Surface' }, { v: 'know', l: 'Line' }, { v: 'bury', l: 'Bury' }];

export default function Watch({ data, settings, set, openResearch }: { data: BriefPayload; settings: Settings; set: (f: (p: Settings) => Settings) => void; openResearch: (s: string) => void }) {
  const th = settings.th;
  const setTh = (patch: Partial<Thresholds>) => set((p) => ({ ...p, th: { ...p.th, ...patch } }));
  const bt = useMemo(() => backtest(data.prices, th, 60), [data.prices, th]);
  const peak = Math.max(1, ...bt.byDay);

  const counts = useMemo(() => {
    const c = {} as Record<Category, number>;
    for (const f of data.filings) for (const x of [f, ...(f.related || [])]) c[x.category] = (c[x.category] || 0) + 1;
    return c;
  }, [data.filings]);

  const tape = useMemo(
    () => data.portfolio
      .map((h) => ({ h, s: data.prices[h.symbol] ? reading(data.prices[h.symbol], th) : null }))
      .sort((a, b) => (b.s?.fired.length || 0) - (a.s?.fired.length || 0) || Math.abs(b.s?.chg || 0) - Math.abs(a.s?.chg || 0)),
    [data, th],
  );
  const hasPrices = Object.keys(data.prices).length > 0;

  return (
    <div className="page">
      <h1>You decide what unusual means</h1>
      <p className="lede">FINN watches every close. It interrupts you only when a holding crosses the lines you draw here.</p>

      <div className="block">
        <p className="rule">
          Tell me when volume is at least
          <Stepper label="volume multiple" value={th.volX} step={0.25} min={1.25} max={6} fmt={(n) => `${n}×`} onChange={(volX) => setTh({ volX })} />
          its
          <Stepper label="lookback days" value={th.lookback} step={5} min={5} max={60} fmt={(n) => `${n}d`} onChange={(lookback) => setTh({ lookback })} />
          average, or the price moves more than
          <Stepper label="price move" value={th.movePct} step={0.5} min={1} max={15} fmt={(n) => `±${n}%`} onChange={(movePct) => setTh({ movePct })} />
          in a day.
        </p>
        {hasPrices ? (
          <div className="conseq">
            At these settings FINN would have alerted you <b>{bt.total} times</b> in the last 60 sessions, about <b>{bt.perWeek} a week</b>, across {bt.names} of {data.portfolio.length} holdings.
            <div className="hist" aria-hidden="true">{bt.byDay.map((n, i) => <i key={i} data-z={n ? 0 : 1} style={{ height: n ? `${Math.max(12, (n / peak) * 100)}%` : 1 }} />)}</div>
            <div className="axis"><span>60 sessions ago</span><span>alerts per session</span><span>last close</span></div>
          </div>
        ) : (
          <div className="empty">Prices have not loaded, so there is nothing to test the thresholds against yet.</div>
        )}
      </div>

      <div className="block">
        <h2>Filing types <span>last 30 days</span></h2>
        <p className="small muted" style={{ margin: '8px 0 4px' }}>Left alone, FINN decides filing by filing. A CFO exit surfaces, a company-secretary change does not. Override a whole type here.</p>
        {CATEGORIES.map((c) => (
          <div className="route" key={c}>
            <span className="nm">{CATEGORY_LABEL[c]}<small>{counts[c] || 0}</small></span>
            <div className="seg" role="group" aria-label={`Routing for ${CATEGORY_LABEL[c]}`}>
              {ROUTES.map((r) => (
                <button key={r.v} aria-pressed={(settings.routing[c] || 'auto') === r.v} onClick={() => set((p) => ({ ...p, routing: { ...p.routing, [c]: r.v } }))}>{r.l}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="block">
        <h2>The tape <span>last close, most unusual first</span></h2>
        {tape.map(({ h, s }) => (
          <button className="hold" key={h.symbol} onClick={() => openResearch(h.symbol)}>
            <i className="fired" data-on={Boolean(s?.fired.length)} title={s?.fired.length ? 'Crossed your threshold' : ''} />
            <span className="tick">{h.symbol}<small>{h.sector}, {h.cap.toLowerCase()} cap</small></span>
            {s ? <Spark data={s.spark} w={84} h={30} mark={false} /> : <span className="small muted">no price</span>}
            {s && (
              <span className="px">
                <b className={`num ${tone(s.chg)}`}>{signed(s.chg)}</b>
                <small>₹{s.close.toLocaleString('en-IN')}, vol {s.volX.toFixed(1)}×</small>
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
