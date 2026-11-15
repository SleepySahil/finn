'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABEL, tierFor, type Routing } from '@/lib/brain/classify';
import { alerts, type Signal, type Thresholds } from '@/lib/brain/signals';
import type { BriefPayload, Category, Enrichment, Filing, Holding } from '@/lib/types';
import { cleanSubject, cr, Delta, longWhen, signed, Spark, tone, when } from './ui';

export interface Settings { th: Thresholds; routing: Routing; hours: number; since: string | null; lastSeen: number }
const WINDOWS = [{ h: 24, l: '24h' }, { h: 72, l: '3d' }, { h: 168, l: '7d' }, { h: 720, l: '30d' }];

interface Props {
  data: BriefPayload;
  settings: Settings;
  set: (f: (p: Settings) => Settings) => void;
  enrich: Record<string, Enrichment | null>;
  wantEnrich: (f: Filing) => void;
  openResearch: (symbol: string) => void;
  openAsk: (ctx: { symbol?: string; name?: string; seed?: string }) => void;
  toast: (msg: string, undo?: () => void) => void;
  widened: string | null;
}

type Item = { kind: 'filing'; at: string; f: Filing; moves?: Signal[] } | { kind: 'tape'; at: string; s: Signal };

export default function Brief({ data, settings, set, enrich, wantEnrich, openResearch, openAsk, toast, widened }: Props) {
  const sinceMs = settings.since ? Date.parse(settings.since) : Date.now() - settings.hours * 3600e3;
  const names = useMemo(() => Object.fromEntries(data.portfolio.map((h) => [h.symbol, h])) as Record<string, Holding>, [data.portfolio]);

  const { act, know, bury, folded } = useMemo(() => {
    const inWin = data.filings.filter((f) => Date.parse(f.at) >= sinceMs);
    const withTier = inWin.map((f) => ({ ...f, tier: tierFor(f, settings.routing) }));
    const tape = alerts(data.prices, settings.th, sinceMs, withTier);
    const surfaced = new Set(withTier.filter((f) => f.tier === 'act').map((f) => f.id));
    // One event, one card: a move on results day is part of the results card, not a second interruption.
    const moved: Record<string, Signal[]> = {};
    const loose = tape.filter((s) => {
      if (!s.because || !surfaced.has(s.because.id)) return true;
      (moved[s.because.id] ||= []).push(s);
      return false;
    });
    const act: Item[] = [
      ...withTier.filter((f) => f.tier === 'act').map((f) => ({ kind: 'filing' as const, at: f.at, f, moves: moved[f.id] })),
      ...loose.map((s) => ({ kind: 'tape' as const, at: s.at, s })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return { act, know: withTier.filter((f) => f.tier === 'know'), bury: withTier.filter((f) => f.tier === 'bury'), folded: inWin.reduce((n, f) => n + (f.related?.length || 0), 0) };
  }, [data, settings.routing, settings.th, sinceMs]);

  // Read the filings that surfaced — and only those. Nothing in the bed costs a token.
  useEffect(() => {
    act.slice(0, 10).forEach((i) => { if (i.kind === 'filing' && enrich[i.f.id] === undefined && (data.llm || i.f.category === 'results')) wantEnrich(i.f); });
  }, [act, enrich, wantEnrich, data.llm]);

  const [speaking, setSpeaking] = useState(false);
  const say = () => {
    if (!('speechSynthesis' in window)) return toast('This browser cannot read aloud.');
    if (speaking) { speechSynthesis.cancel(); return setSpeaking(false); }
    const parts = [`${act.length} ${act.length === 1 ? 'thing needs' : 'things need'} you. ${know.length} worth a line. ${bury.length} buried.`];
    for (const i of act.slice(0, 6)) {
      if (i.kind === 'tape') parts.push(`${names[i.s.symbol]?.name || i.s.symbol} ${i.s.chg > 0 ? 'rose' : 'fell'} ${Math.abs(i.s.chg).toFixed(1)} percent on ${i.s.volX.toFixed(1)} times normal volume.`);
      else parts.push(`${names[i.f.symbol]?.name || i.f.company}. ${title(i.f, enrich[i.f.id])}. ${(enrich[i.f.id]?.line || '').replace(/YoY/g, 'year on year').replace(/bps/g, 'basis points')}`);
    }
    const u = new SpeechSynthesisUtterance(parts.join(' '));
    u.rate = 1.02; u.lang = 'en-IN'; u.onend = () => setSpeaking(false);
    speechSynthesis.cancel(); speechSynthesis.speak(u); setSpeaking(true);
  };
  useEffect(() => () => { if (typeof window !== 'undefined' && 'speechSynthesis' in window) speechSynthesis.cancel(); }, []);

  const buryType = (c: Category) => {
    const prev = settings.routing[c];
    set((p) => ({ ...p, routing: { ...p.routing, [c]: 'bury' } }));
    toast(`${CATEGORY_LABEL[c]} will be buried from now on.`, () => set((p) => ({ ...p, routing: { ...p.routing, [c]: prev ?? 'auto' } })));
  };
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const isNew = (at: string) => settings.lastSeen > 0 && Date.parse(at) > settings.lastSeen;

  return (
    <>
      <header className="mast">
        <span className="mark">FINN</span>
        <span className={`status ${data.mode === 'live' ? 'live' : ''}`}><i />{data.mode === 'live' ? 'Live' : 'Saved snapshot'}, {when(data.generatedAt)}</span>
      </header>

      <div className="count" aria-live="polite">
        <button className={`l1 ${act.length ? '' : 'zero'}`} onClick={() => go('surface')}>{act.length} need{act.length === 1 ? 's' : ''} you.</button>
        <button className="l2" onClick={() => go('shelf')}>{know.length} worth a line.</button>
        <button className="l3" onClick={() => go('bed')}>{bury.length} buried.</button>
      </div>

      <div className="window">
        <span className="lbl">Since</span>
        <div className="seg" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button key={w.h} aria-pressed={!settings.since && settings.hours === w.h} onClick={() => set((p) => ({ ...p, hours: w.h, since: null }))}>{w.l}</button>
          ))}
        </div>
        <label className="since" data-on={Boolean(settings.since)}>
          {settings.since ? longWhen(Date.parse(settings.since)) : 'Pick a time'}
          <input type="datetime-local" aria-label="Show everything since a date and time" max={new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16)}
            onChange={(e) => e.target.value && set((p) => ({ ...p, since: new Date(e.target.value).toISOString() }))} />
        </label>
      </div>
      <div className="sub">
        <span>{longWhen(sinceMs)} to now, {data.portfolio.length} holdings</span>
        <button className="textbtn" onClick={say} aria-pressed={speaking}>{speaking ? 'Stop reading' : 'Read it to me'}</button>
      </div>
      {widened && <div className="notice">{widened}</div>}
      {(data.notes || []).map((n) => <div className="notice" key={n}>{n}</div>)}

      <section className="surface" id="surface">
        {!act.length && (
          <div className="empty"><b>Nothing needs you in this window.</b> No results, deals, top-level exits or unusual moves across {data.portfolio.length} holdings. Widen the window, or loosen what counts as unusual in Watch.</div>
        )}
        {act.map((i) =>
          i.kind === 'tape' ? (
            <TapeItem key={`t-${i.s.symbol}-${i.at}`} s={i.s} h={names[i.s.symbol]} th={settings.th} isNew={isNew(i.at)} openResearch={openResearch} go={go} />
          ) : (
            <FilingItem key={i.f.id} f={i.f} moves={i.moves} th={settings.th} e={enrich[i.f.id]} llm={data.llm} isNew={isNew(i.at)} openResearch={openResearch} openAsk={openAsk} buryType={buryType} />
          ),
        )}
      </section>

      <section className="shelf" id="shelf">
        <div className="stratum-h"><h2>Worth a line</h2><span>{know.length} filing{know.length === 1 ? '' : 's'}, tap to read</span></div>
        {!know.length && <p className="small muted" style={{ padding: '0 var(--pad)' }}>Nothing in this window.</p>}
        {know.map((f) => <KnowRow key={f.id} f={f} e={enrich[f.id]} llm={data.llm} wantEnrich={wantEnrich} buryType={buryType} isNew={isNew(f.at)} />)}
      </section>

      <Bed bury={bury} folded={folded} set={set} toast={toast} data={data} />
    </>
  );
}

function title(f: Filing, e?: Enrichment | null): string {
  if (e?.kind === 'results') return `${e.period} results`;
  if (f.category === 'results') return 'Results filed';
  if (e?.kind === 'mgmt') return e.line;
  const h = cleanSubject(f.headline || f.subject);
  return h.length > 110 ? `${h.slice(0, 108)}…` : h;
}

function FilingItem({ f, moves, th, e, llm, isNew, openResearch, openAsk, buryType }: { f: Filing; moves?: Signal[]; th: Thresholds; e?: Enrichment | null; llm: boolean; isNew: boolean; openResearch: (s: string) => void; openAsk: Props['openAsk']; buryType: (c: Category) => void }) {
  const [open, setOpen] = useState(false);
  const pending = e === undefined && (llm || f.category === 'results');
  return (
    <article className="item" id={`f-${f.id}`}>
      <div className="head">
        {isNew && <i className="new" title="New since you last looked" />}
        <span className="tick">{f.symbol}</span>
        <span className="co">{CATEGORY_LABEL[f.category]}{f.subtype && f.category !== 'results' ? `, ${f.subtype.toLowerCase()}` : ''}</span>
        <span className="when">{when(f.at)}</span>
      </div>
      <h3 className="what">{title(f, e)}</h3>

      {e?.kind === 'results' && (
        <>
          <div className="grid4">
            {e.metrics.map((m) => (
              <div className="cell" key={m.key}>
                <div className="k">{m.key}</div>
                <div className="v">{cr(m.cur)}<small>Cr</small></div>
                <div className="d"><Delta label="YoY" v={m.yoy} /><Delta label="QoQ" v={m.qoq} /></div>
              </div>
            ))}
          </div>
          {e.margin?.cur != null && (
            <p className="line">{e.margin.label} <b>{e.margin.cur}%</b>{e.margin.bps != null && <span className={tone(e.margin.bps)}> {e.margin.bps > 0 ? '+' : '−'}{Math.abs(e.margin.bps)} bps YoY</span>}</p>
          )}
          <p className="srcnote">
            {e.source === 'filing' ? <b>Read from the filing.</b> : <b>Company-reported, standardised.</b>} {e.note || 'EBITDA is operating profit before other income.'}
            {e.checked === 'matches' && ' ✓'}
          </p>
        </>
      )}

      {e?.kind === 'mgmt' && e.changes.map((c) => (
        <div className="person" key={c.person + c.role}>
          <div className="nm">{c.person}</div>
          <div className="rl">{c.action} as {c.role}{c.effective ? `, effective ${c.effective}` : ''}{c.reason ? ` (${c.reason})` : ''}</div>
          {c.background && <p>{c.background}</p>}
          {!!c.prior?.length && <div className="chips">{c.prior.map((p) => <span className="chip" key={p}>{p}</span>)}</div>}
          <div className="acts" style={{ marginTop: 6 }}>
            <a href={c.lookup} target="_blank" rel="noreferrer" className="quiet">Look up on LinkedIn</a>
            <span className="small muted">{e.source === 'web' ? 'Background from web search' : c.background ? "Background from the filing's own profile" : ''}</span>
          </div>
        </div>
      ))}

      {e?.kind === 'summary' && (
        <>
          <p className="line">{e.line}</p>
          {!!e.numbers?.length && <div className="chips">{e.numbers.map((n) => <span className="chip" key={n}>{n}</span>)}</div>}
        </>
      )}
      {pending && <><div className="skel" style={{ width: '82%' }} /><div className="skel" style={{ width: '56%' }} /></>}

      {moves?.slice(0, 2).map((m) => (
        <div className="moved" key={m.at}>
          <Spark data={m.spark} w={64} h={26} />
          <span>The stock <b className={tone(m.chg)}>{signed(m.chg)}</b> on <b>{m.volX.toFixed(1)}×</b> its {th.lookback}-day volume, {when(m.at).replace(/ \d\d:\d\d$/, '')}{m.near ? `, at its 52-week ${m.near}` : ''}</span>
        </div>
      ))}

      <p className="why">Surfaced because: {f.why.charAt(0).toLowerCase() + f.why.slice(1)}.</p>

      <div className="acts">
        {f.pdf && <a href={f.pdf} target="_blank" rel="noreferrer">Open filing</a>}
        <button onClick={() => openResearch(f.symbol)}>Dig into {f.symbol}</button>
        <button onClick={() => openAsk({ symbol: f.symbol, name: f.company, seed: f.category === 'results' ? 'Did this quarter match what management guided?' : undefined })}>Ask</button>
        {!!f.related?.length && <button className="quiet" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : `+${f.related.length} filings, same event`}</button>}
        <button className="quiet" onClick={() => buryType(f.category)}>Bury this type</button>
      </div>
      {open && (
        <div className="related">
          <ul>
            {f.related!.map((r) => (
              <li key={r.id}>{r.pdf ? <a href={r.pdf} target="_blank" rel="noreferrer">{cleanSubject(r.subject).slice(0, 62)}</a> : <span>{cleanSubject(r.subject).slice(0, 62)}</span>}<span>{when(r.at)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function TapeItem({ s, h, th, isNew, openResearch, go }: { s: Signal; h?: Holding; th: Thresholds; isNew: boolean; openResearch: (s: string) => void; go: (id: string) => void }) {
  const both = s.fired.length === 2;
  return (
    <article className="item">
      <div className="head">
        {isNew && <i className="new" title="New since you last looked" />}
        <span className="tick">{s.symbol}</span>
        <span className="co">Unusual {both ? 'move and volume' : s.fired[0] === 'move' ? 'price move' : 'volume'}</span>
        <span className="when">{when(s.at)}</span>
      </div>
      <div className="tape">
        {s.fired.includes('move') ? <div className={`big ${tone(s.chg)}`}>{signed(s.chg)}</div> : <div className="big">{s.volX.toFixed(1)}×</div>}
        <div className="side">
          {s.fired.includes('move') ? <div><b>{s.volX.toFixed(1)}×</b> its {th.lookback}-day volume</div> : <div>its {th.lookback}-day volume, price <b className={tone(s.chg)}>{signed(s.chg)}</b></div>}
          <div>Closed <b>₹{s.close.toLocaleString('en-IN')}</b>{s.near ? `, at its 52-week ${s.near}` : ''}</div>
        </div>
        <Spark data={s.spark} w={96} h={40} />
      </div>
      <p className="why">
        Surfaced because: {s.fired.includes('move') ? `move beyond ±${th.movePct}%` : ''}{both ? ' and ' : ''}{s.fired.includes('volume') ? `volume above ${th.volX}× average` : ''}. Your thresholds.
      </p>
      <div className="acts">
        {s.because ? <button onClick={() => go(`f-${s.because!.id}`)}>Same day: {s.because.label.toLowerCase()}</button> : <span className="small muted">No material filing within a day of this move</span>}
        <button onClick={() => openResearch(s.symbol)}>Dig into {s.symbol}</button>
      </div>
    </article>
  );
}

function KnowRow({ f, e, llm, wantEnrich, buryType, isNew }: { f: Filing; e?: Enrichment | null; llm: boolean; wantEnrich: (f: Filing) => void; buryType: (c: Category) => void; isNew: boolean }) {
  const [open, setOpen] = useState(false);
  const asked = useRef(false);
  const toggle = () => {
    setOpen(!open);
    if (!open && !asked.current && e === undefined && llm && f.pdf) { asked.current = true; wantEnrich(f); }
  };
  const text = cleanSubject(f.headline || f.subject);
  return (
    <div className="row">
      <button className="r1" onClick={toggle} aria-expanded={open} style={{ width: '100%' }}>
        <span className="tick">{isNew && <i className="new" style={{ marginRight: 6, display: 'inline-block' }} />}{f.symbol}</span>
        <span className="txt">{e?.line || f.subtype}<span className="sub2">{e?.line ? f.subtype : text.length > 74 ? `${text.slice(0, 72)}…` : text}</span></span>
        <span className="when">{when(f.at)}</span>
      </button>
      {open && (
        <div className="more">
          {e === undefined && llm && f.pdf && <div className="skel" style={{ width: '70%', marginBottom: 8 }} />}
          {e?.kind === 'summary' && !!e.numbers?.length && <div className="chips" style={{ marginBottom: 6 }}>{e.numbers.map((n) => <span className="chip" key={n}>{n}</span>)}</div>}
          <div className="muted">{f.why}.{!llm && ' Add a model key and FINN will read the filing into one line here.'}</div>
          <div className="acts" style={{ marginTop: 6 }}>
            {f.pdf && <a href={f.pdf} target="_blank" rel="noreferrer">Open filing</a>}
            <button className="quiet" onClick={() => buryType(f.category)}>Bury this type</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Bed({ bury, folded, set, toast, data }: { bury: Filing[]; folded: number; set: Props['set']; toast: Props['toast']; data: BriefPayload }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, Filing[]>();
    for (const f of bury) m.set(f.subtype, [...(m.get(f.subtype) || []), f]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [bury]);
  const promote = (c: Category) => {
    set((p) => ({ ...p, routing: { ...p.routing, [c]: 'know' } }));
    toast(`${CATEGORY_LABEL[c]} moved up to "worth a line".`, () => set((p) => ({ ...p, routing: { ...p.routing, [c]: 'auto' } })));
  };
  const all = data.filings.flatMap((f) => [f, ...(f.related || [])]);
  const viaRule = all.filter((f) => f.via === 'rule').length, viaLlm = all.filter((f) => f.via === 'llm').length;
  return (
    <section className="bed" id="bed">
      <div className="stratum-h"><h2>{bury.length} buried</h2><span>counted, not hidden</span></div>
      {!!bury.length && <div className="sediment" aria-hidden="true">{groups.map(([k, v]) => <i key={k} style={{ flex: v.length }} title={`${k}: ${v.length}`} />)}</div>}
      {groups.map(([k, v]) => (
        <div className="layer" key={k}>
          <button onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
            <span className="n">{v.length}</span><span className="nm">{k}<small>{v[0].why}</small></span>
          </button>
          {open === k && (
            <div className="list">
              <ul>
                {v.slice(0, 14).map((f) => (
                  <li key={f.id}><b>{f.symbol}</b>{f.pdf ? <a href={f.pdf} target="_blank" rel="noreferrer">{cleanSubject(f.headline || f.subject).slice(0, 70)}</a> : <span>{cleanSubject(f.headline || f.subject).slice(0, 70)}</span>}<span>{when(f.at)}</span></li>
                ))}
              </ul>
              {v.length > 14 && <p className="small muted">and {v.length - 14} more</p>}
              {!v[0].noise && <button className="promote" onClick={() => promote(v[0].category)}>Not routine for me. Move {CATEGORY_LABEL[v[0].category].toLowerCase()} up.</button>}
            </div>
          )}
        </div>
      ))}
      <p className="foot">
        {folded > 0 && <>{folded} more filings are folded into the cards above (a results day is one event, not six). </>}
        Of {all.length} filings in the last 30 days, {viaRule} were placed by rules at no cost{viaLlm ? ` and ${viaLlm} by a small model in one batch` : ''}. Only what surfaces is ever read by a model.
      </p>
    </section>
  );
}
