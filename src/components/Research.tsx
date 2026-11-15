'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FullDossier } from '@/lib/research/synth';
import type { ArNotes } from '@/lib/research/read';
import type { CallNotes, DocLink, Flag, Holding, LedgerRow } from '@/lib/types';
import { Bars, cr, Legend } from './ui';

interface Step { id: string; label: string; s: 'wait' | 'run' | 'done' | 'fail'; note?: string }
interface State { phase: 'idle' | 'loading' | 'reading' | 'ready' | 'error'; d?: FullDossier; steps: Step[]; error?: string; llm?: boolean; from?: string }
interface Pick { symbol: string; name: string; depth?: string; oneLine?: string }

const VERDICT: Record<LedgerRow['verdict'], string> = { delivered: 'Delivered', missed: 'Missed', partly: 'Partly', too_early: 'Still running', unverifiable: 'Cannot verify' };
const post = async <T,>(url: string, body: unknown): Promise<T> => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j as T;
};

export default function Research({ target, setTarget, portfolio, openAsk }: { target: string | null; setTarget: (s: string | null) => void; portfolio: Holding[]; openAsk: (ctx: { symbol?: string; name?: string; seed?: string }) => void }) {
  const [st, setSt] = useState<State>({ phase: 'idle', steps: [] });
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Pick[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const run = useRef(0);

  useEffect(() => { fetch('/snapshot/research/index.json').then((r) => (r.ok ? r.json() : [])).then(setPicks).catch(() => {}); }, []);

  // type-ahead against any listed company, not just the demo set
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(() => fetch(`/api/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).then((j) => setHits(j.hits || [])).catch(() => setHits([])), 220);
    return () => clearTimeout(t);
  }, [q]);

  const open = useCallback(async (symbol: string, fresh = false) => {
    const me = ++run.current;
    const alive = () => run.current === me;
    const step = (id: string, patch: Partial<Step>) => alive() && setSt((p) => ({ ...p, steps: p.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
    setHits([]); setQ('');
    setSt({ phase: 'loading', steps: [{ id: 'n', label: 'Reported financials', s: 'run', note: 'no model' }] });
    try {
      if (!fresh) {
        try {
          const raw = localStorage.getItem(`finn.d.${symbol}`);
          const hit = raw ? (JSON.parse(raw) as { at: number; d: FullDossier }) : null;
          if (hit && Date.now() - hit.at < 24 * 3600e3 && hit.d.depth === 'full') return setSt({ phase: 'ready', d: hit.d, steps: [], from: 'Read earlier today on this phone' });
        } catch {}
        const s = await fetch(`/snapshot/research/${encodeURIComponent(symbol)}.json`).then((r) => (r.ok ? (r.json() as Promise<FullDossier>) : null)).catch(() => null);
        if (!alive()) return;
        if (s && s.depth === 'full') {
          try { localStorage.setItem(`finn.d.${symbol}`, JSON.stringify({ at: Date.now(), d: s })); } catch {}
          return setSt({ phase: 'ready', d: s, steps: [], from: 'Saved research' });
        }
        if (s) setSt((p) => ({ ...p, d: s }));       // numbers on screen at once; live data replaces them
      }
      const r = await fetch(`/api/research/${encodeURIComponent(symbol)}${fresh ? '?fresh=1' : ''}`);
      const j = (await r.json()) as { dossier?: FullDossier; llm?: boolean; saved?: boolean; toRead?: { calls: DocLink[]; annualReport: DocLink | null }; error?: string };
      if (!alive()) return;
      if (!r.ok || !j.dossier) throw new Error(j.error || 'Could not load that company');
      const d = j.dossier;
      if (j.saved || !j.llm || !j.toRead?.calls.length) {
        return setSt({ phase: 'ready', d, steps: [], llm: j.llm, from: j.saved ? 'Saved research' : undefined });
      }
      const calls = j.toRead.calls, ar = j.toRead.annualReport;
      const steps: Step[] = [
        { id: 'n', label: 'Reported financials', s: 'done', note: 'no model' },
        ...calls.map((c) => ({ id: c.url, label: `Reading the ${c.quarter} call`, s: 'wait' as const })),
        ...(ar ? [{ id: 'ar', label: `Skimming the ${ar.period || ''} annual report`, s: 'wait' as const }] : []),
        { id: 'syn', label: 'Checking promises against numbers', s: 'wait' },
      ];
      setSt({ phase: 'reading', d, steps, llm: true });

      // One document per request: nothing outlives a serverless timeout, and progress is real.
      const notes: CallNotes[] = [];
      for (const c of calls) {
        step(c.url, { s: 'run' });
        try {
          const x = await post<{ notes: CallNotes }>(`/api/research/${symbol}/read`, { doc: c, kind: 'call', company: d.name });
          notes.push(x.notes);
          step(c.url, { s: 'done', note: `${x.notes.pages} pages, ${x.notes.guidance.length} commitments` });
        } catch (e) {
          step(c.url, { s: 'fail', note: (e as Error).message.slice(0, 60) });
        }
        if (!alive()) return;
      }
      let arNotes: ArNotes | undefined;
      if (ar) {
        step('ar', { s: 'run' });
        try {
          arNotes = (await post<{ ar: ArNotes }>(`/api/research/${symbol}/read`, { doc: ar, kind: 'ar', company: d.name })).ar;
          step('ar', { s: 'done', note: `${arNotes.pagesRead.length} of ${arNotes.totalPages} pages sent` });
        } catch (e) {
          step('ar', { s: 'fail', note: (e as Error).message.slice(0, 60) });
        }
        if (!alive()) return;
      }
      if (!notes.length) throw new Error('None of the call transcripts could be read. The numbers above are still good.');
      step('syn', { s: 'run' });
      const full = (await post<{ dossier: FullDossier }>(`/api/research/${symbol}/synth`, { notes, ar: arNotes })).dossier;
      if (!alive()) return;
      try { localStorage.setItem(`finn.d.${symbol}`, JSON.stringify({ at: Date.now(), d: full })); } catch {}
      setSt({ phase: 'ready', d: full, steps: [], llm: true });
    } catch (e) {
      if (alive()) setSt((p) => ({ ...p, phase: p.d ? 'ready' : 'error', error: (e as Error).message, steps: [] }));
    }
  }, []);

  useEffect(() => { if (target) open(target); else { run.current++; setSt({ phase: 'idle', steps: [] }); } }, [target, open]);

  const d = st.d;
  return (
    <div className="page">
      {!target && (
        <>
          <h1>Ask FINN to read a company</h1>
          <p className="lede">Any NSE ticker. FINN reads the company&apos;s own annual report and its last five earnings calls. No broker notes, no news.</p>
        </>
      )}
      <form className="search" onSubmit={(e) => { e.preventDefault(); const s = (hits[0]?.symbol || q).trim().toUpperCase(); if (s) setTarget(s); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={target ? 'Another company or ticker' : 'Company name or NSE ticker'} aria-label="Company name or NSE ticker" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="search" />
        <button type="submit">Read</button>
      </form>
      {!!hits.length && (
        <div className="hits">{hits.map((h) => <button key={h.symbol} onClick={() => setTarget(h.symbol)}><b>{h.symbol}</b><span>{h.name}</span></button>)}</div>
      )}

      {!target && (
        <>
          <div className="block"><h2>Already read <span>opens instantly</span></h2></div>
          <div className="picks">
            {picks.filter((p) => p.depth === 'full').map((p) => <button className="pick" key={p.symbol} onClick={() => setTarget(p.symbol)}>{p.symbol}</button>)}
            {!picks.some((p) => p.depth === 'full') && <p className="small muted">Nothing saved yet. Pick any company and FINN reads it live in about a minute.</p>}
          </div>
          {picks.filter((p) => p.depth === 'full' && p.oneLine).slice(0, 4).map((p) => (
            <button key={p.symbol} className="row" style={{ borderTop: '1px solid var(--line)', marginTop: 4 }} onClick={() => setTarget(p.symbol)}>
              <span className="r1"><span className="tick">{p.symbol}</span><span className="txt">{p.oneLine}</span></span>
            </button>
          ))}
          <div className="block"><h2>Your holdings</h2></div>
          <div className="picks">{portfolio.map((h) => <button className="pick" data-kind="own" key={h.symbol} onClick={() => setTarget(h.symbol)}>{h.symbol}</button>)}</div>
        </>
      )}

      {st.phase === 'loading' && <div className="trace"><ul><li data-s="run"><i>●</i>Fetching reported financials for {target}</li></ul></div>}
      {st.phase === 'error' && <div className="empty"><b>{st.error}</b><br />Check the ticker (NSE symbol, e.g. POLYCAB) and try again.</div>}

      {d && (
        <>
          <div className="dhead">
            <div className="nm">{d.name}</div>
            <div className="meta"><span><b>{d.symbol}</b></span>{d.facts.price && <span><b>{d.facts.price}</b></span>}{d.facts.mcap && <span>M-cap {d.facts.mcap}</span>}<span>{d.facts.asOf}</span></div>
          </div>
          {d.oneLine && <p className="verdictline">{d.oneLine}</p>}

          {st.phase === 'reading' && (
            <div className="trace" aria-live="polite">
              <ul>{st.steps.map((s) => <li key={s.id} data-s={s.s}><i>{s.s === 'done' ? '✓' : s.s === 'fail' ? '×' : s.s === 'run' ? '●' : '·'}</i>{s.label}{s.note && <small>{s.note}</small>}</li>)}</ul>
            </div>
          )}
          {st.error && st.phase === 'ready' && <div className="empty">{st.error}</div>}

          <nav className="jump" aria-label="Sections">
            {d.depth === 'full' && <><a href="#ledger">Said vs did</a><a href="#story">Story vs numbers</a><a href="#guidance">Guidance</a></>}
            <a href="#snapshot">Snapshot</a><a href="#trajectory">Trajectory</a><a href="#balance">Balance sheet</a><a href="#cash">Cash</a>
            {d.depth === 'full' && <><a href="#case">Bull and bear</a><a href="#business">Business</a></>}
          </nav>

          {d.depth !== 'full' && st.phase === 'ready' && (
            <div className="empty">
              <b>Numbers only.</b> {st.llm === false ? 'This deployment has no model key, so FINN cannot read the transcripts. Everything below is arithmetic on reported financials and needs no model.' : 'FINN has not read this company’s calls yet.'}
              {st.llm !== false && <><br /><button className="btn" onClick={() => open(d.symbol, true)}>Read the calls now</button></>}
            </div>
          )}

          {d.depth === 'full' && <Ledger d={d} />}
          {d.depth === 'full' && !!d.divergences.length && (
            <section className="block" id="story">
              <h2>Story vs numbers</h2>
              {d.divergences.map((x) => (
                <div className="pair" key={x.theme}>
                  <h3><i className={`mark ${x.verdict === 'diverge' ? 'missed' : 'delivered'}`} />{x.theme}<span className="tag">{x.verdict === 'diverge' ? 'They diverge' : 'They agree'}</span></h3>
                  <div><span className="k">Management says</span>{x.narrative}</div>
                  <div><span className="k">Reported numbers show</span>{x.numbers}</div>
                </div>
              ))}
            </section>
          )}
          {d.depth === 'full' && !!d.guidanceNow.length && (
            <section className="block" id="guidance">
              <h2>Guidance still outstanding <span>hold them to it</span></h2>
              {d.guidanceNow.map((g, i) => (
                <div className="g" key={i}>
                  <div className="t">{g.metric}: <b>{g.target}</b>{g.horizon ? ` for ${g.horizon}` : ''}</div>
                  <div className="m"><Cite quarter={g.saidIn} page={g.page} url={g.url} />{g.quote && <span>“{g.quote}”</span>}</div>
                </div>
              ))}
            </section>
          )}

          <section className="block" id="snapshot">
            <h2>Snapshot <span>{d.facts.asOf}</span></h2>
            <div className="tiles">{d.facts.snapshot.map((t) => <div className="tile" key={t.label}><div className="k">{t.label}</div><div className="v">{t.value}</div><div className="s">{t.sub || ' '}</div></div>)}</div>
            <div className="chart">
              <Bars labels={d.facts.quarters.periods.slice(-8).map((p) => p.replace(' FY', "'"))} series={[{ name: 'Quarterly revenue', values: d.facts.quarters.revenue.slice(-8), color: 'var(--ink)' }]} line={{ name: 'margin', values: d.facts.quarters.opm.slice(-8), unit: '%' }} h={120} />
              <Legend items={[{ name: 'Quarterly revenue, ₹ Cr', color: 'var(--ink)' }, { name: `${d.facts.lender ? 'Financing margin' : 'EBITDA margin'}, ${last(d.facts.quarters.opm) ?? '–'}% latest`, color: 'var(--down)' }]} />
            </div>
          </section>

          <section className="block" id="trajectory">
            <h2>Trajectory <span>what is growing, what is compressing</span></h2>
            <div className="chart">
              <Bars labels={d.facts.trajectory.years} series={[{ name: 'Revenue', values: d.facts.trajectory.revenue, color: 'var(--ink)' }]} line={{ name: 'margin', values: d.facts.trajectory.opm, unit: '%' }} />
              <Legend items={[{ name: 'Revenue, ₹ Cr', color: 'var(--ink)' }, { name: `Operating margin, ${last(d.facts.trajectory.opm) ?? '–'}% latest`, color: 'var(--down)' }]} />
            </div>
            <div className="kv">{Object.entries(d.facts.trajectory.cagr).map(([k, v]) => <span key={k}>{k} CAGR<b>{v}</b></span>)}</div>
            <Flags flags={d.facts.trajectory.flags} />
          </section>

          <section className="block" id="balance">
            <h2>Balance sheet <span>debt, leverage, working capital</span></h2>
            <div className="chart">
              <Bars labels={d.facts.balance.years.slice(-8)} series={[{ name: 'Debt', values: d.facts.balance.debt.slice(-8), color: 'var(--ink-3)' }, { name: 'Equity', values: d.facts.balance.equity.slice(-8), color: 'var(--ink)' }]} h={116} />
              <Legend items={[{ name: 'Debt, ₹ Cr', color: 'var(--ink-3)' }, { name: 'Shareholders’ equity', color: 'var(--ink)' }]} />
            </div>
            <div className="kv">
              <span>Debt / equity<b>{last(d.facts.balance.de) ?? '–'}×</b></span>
              {!d.facts.lender && <span>Cash cycle<b>{last(d.facts.balance.ccc) ?? '–'} days</b></span>}
              {!d.facts.lender && <span>Debtor days<b>{last(d.facts.balance.debtorDays) ?? '–'}</b></span>}
              <span>{d.facts.lender ? 'ROE' : 'ROCE'}<b>{last(d.facts.balance.roce) ?? '–'}%</b></span>
            </div>
            <Flags flags={d.facts.balance.flags} />
          </section>

          <section className="block" id="cash">
            <h2>Cash quality <span>do profits turn into cash?</span></h2>
            <div className="chart">
              <Bars labels={d.facts.cash.years.slice(-8)} series={[{ name: 'Reported profit', values: d.facts.cash.pat.slice(-8), color: 'var(--ink-3)' }, { name: 'Operating cash flow', values: d.facts.cash.cfo.slice(-8), color: 'var(--ink)' }]} h={116} />
              <Legend items={[{ name: 'Reported profit (PAT)', color: 'var(--ink-3)' }, { name: 'Cash from operations', color: 'var(--ink)' }]} />
            </div>
            <div className="kv">
              <span>{d.facts.cash.cum.n}-year cash conversion<b>{d.facts.cash.cum.ratio ?? '–'}%</b></span>
              <span>Free cash flow, latest<b>₹{cr(last(d.facts.cash.fcf))} Cr</b></span>
            </div>
            <Flags flags={d.facts.cash.flags} />
          </section>

          {d.depth === 'full' && (d.bull.length > 0 || d.bear.length > 0) && (
            <section className="block" id="case">
              <h2>Bull and bear <span>three points each, from the filings</span></h2>
              <div className="case">
                <section><h3 className="up">The case for</h3><ul>{d.bull.map((b) => <li key={b.point}>{b.point}<span>{b.evidence}</span></li>)}</ul></section>
                <section><h3 className="down">The case against</h3><ul>{d.bear.map((b) => <li key={b.point}>{b.point}<span>{b.evidence}</span></li>)}</ul></section>
              </div>
            </section>
          )}

          {d.depth === 'full' && (d.business || d.ar) && (
            <section className="block" id="business">
              <h2>Business <span>in management&apos;s own words</span></h2>
              <p style={{ marginTop: 10 }}>{d.business?.what || d.ar?.business}</p>
              <ul className="flags" style={{ padding: 0 }}>
                {(d.business?.segments?.length ? d.business.segments : d.ar?.segments || []).map((s) => <li key={s.name} style={{ listStyle: 'none' }}><b>{s.name}</b> {s.note}</li>)}
              </ul>
              {!!d.ar?.redFlags.length && (
                <>
                  <h2 style={{ marginTop: 18 }}>From the annual report&apos;s notes <span>{d.ar.pagesRead.length} of {d.ar.totalPages} pages read</span></h2>
                  <ul className="flags" style={{ padding: 0 }}>
                    {d.ar.redFlags.map((r, i) => <li key={i} data-t="bad" style={{ listStyle: 'none' }}>{r.text} {r.page ? <a href={`${d.ar!.url}#page=${r.page}`} target="_blank" rel="noreferrer" className="small">p.{r.page}</a> : null}</li>)}
                  </ul>
                </>
              )}
            </section>
          )}

          {st.phase === 'ready' && (
            <>
              <div className="block">
                <button className="btn" onClick={() => openAsk({ symbol: d.symbol, name: d.name })}>Ask a follow-up about {d.symbol}</button>
              </div>
              <p className="cost">
                {d.depth === 'full'
                  ? <>Sources: {d.notes.map((n, i) => <span key={n.url}>{i ? ', ' : ''}<a href={n.url} target="_blank" rel="noreferrer">{n.quarter} call</a></span>)}{d.ar ? <>, <a href={d.ar.url} target="_blank" rel="noreferrer">annual report {d.ar.year}</a></> : null}, reported financials. Nothing else.<br />
                    Cost of this read: {d.cost.calls} model calls, {(d.cost.tokIn / 1000).toFixed(0)}k tokens in, {(d.cost.tokOut / 1000).toFixed(1)}k out, about ${d.cost.usd.toFixed(3)} at list price and nothing on a free tier. Cached, so the next open is free. {st.from ? `${st.from}.` : ''}{' '}
                    <button className="textbtn" onClick={() => open(d.symbol, true)}>Read again</button></>
                  : <>Source: company-reported financials, standardised by screener.in. No model was used for anything on this page.</>}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

const last = <T,>(a: T[]) => a[a.length - 1];

function Cite({ quarter, page, url }: { quarter?: string; page?: number; url?: string }) {
  const label = `${quarter || ''} call${page ? `, p.${page}` : ''}`;
  return url ? <a href={`${url}${page ? `#page=${page}` : ''}`} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>;
}

function Flags({ flags }: { flags: Flag[] }) {
  if (!flags.length) return null;
  return <div className="flags"><ul>{flags.map((f) => <li key={f.text} data-t={f.tone}>{f.text}</li>)}</ul></div>;
}

function Ledger({ d }: { d: FullDossier }) {
  const s = d.sayDo, total = s.delivered + s.partly + s.missed + s.open;
  return (
    <section className="block" id="ledger">
      <h2>Said vs did <span>last {d.notes.length} calls</span></h2>
      {total > 0 ? (
        <>
          <div className="saydo" aria-hidden="true">
            {s.delivered > 0 && <i className="delivered" style={{ flex: s.delivered }} />}{s.partly > 0 && <i className="partly" style={{ flex: s.partly }} />}
            {s.missed > 0 && <i className="missed" style={{ flex: s.missed }} />}{s.open > 0 && <i className="open" style={{ flex: s.open }} />}
          </div>
          <div className="saydo-k"><span><b>{s.delivered}</b>delivered</span><span><b>{s.partly}</b>partly</span><span><b>{s.missed}</b>missed</span><span><b>{s.open}</b>open</span></div>
        </>
      ) : <p className="small muted" style={{ marginTop: 10 }}>Management gave no testable commitments on these calls. That is itself worth knowing.</p>}
      {d.ledger.map((r, i) => (
        <div className="prom" key={i}>
          <div className="top"><i className={`mark ${r.verdict}`} /><span className="p">{r.promise}</span><span className="v">{VERDICT[r.verdict]}</span></div>
          {r.quote && <blockquote>“{r.quote}”</blockquote>}
          {(r.target || r.actual) && (
            <div className="vs">
              <div><div className="k">Promised{r.metric ? `, ${r.metric.toLowerCase()}` : ''}</div><div className="n">{r.target || '–'}</div></div>
              <div><div className="k">Delivered</div><div className="n">{r.actual || '–'}{r.actualPeriod && <small>{r.actualPeriod}</small>}</div></div>
            </div>
          )}
          <div className="gap">
            {r.gap && <span>{r.gap}</span>}
            <Cite quarter={r.saidIn} page={r.page} url={r.url} />
            <span className="tag">{r.checked === 'code' ? 'Checked by arithmetic' : 'Judged by model'}</span>
          </div>
        </div>
      ))}
    </section>
  );
}
