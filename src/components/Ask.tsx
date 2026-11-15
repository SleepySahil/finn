'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui';

export interface AskCtx { symbol?: string; name?: string; seed?: string }
interface QA { q: string; a?: string; cites?: { label: string; url?: string }[]; meta?: string; needs?: string; symbol?: string }

type Rec = { start: () => void; stop: () => void; lang: string; interimResults: boolean; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; onend: () => void; onerror: () => void };

/**
 * Pull, in the investor's words. The sheet always knows where it was opened from — a results
 * card, a dossier — so "did they hit guidance?" needs no company name. Typed or spoken.
 */
export default function Ask({ ctx, onClose, openResearch }: { ctx: AskCtx; onClose: () => void; openResearch: (s: string) => void }) {
  const [q, setQ] = useState(ctx.seed || '');
  const [log, setLog] = useState<QA[]>([]);
  const [busy, setBusy] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [symbol, setSymbol] = useState(ctx.symbol);
  const input = useRef<HTMLInputElement>(null);
  const rec = useRef<Rec | null>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true); setQ('');
    setLog((l) => [{ q: question }, ...l]);
    try {
      let dossier: unknown;
      try { dossier = symbol ? JSON.parse(localStorage.getItem(`finn.d.${symbol}`) || 'null')?.d : undefined; } catch {}
      const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, symbol, dossier }) });
      const j = await r.json();
      if (j.symbol) setSymbol(j.symbol);
      setLog((l) => [{ q: question, a: j.answer || j.error || 'No answer.', cites: j.cites, needs: j.needs, symbol: j.symbol, meta: j.cost ? `${j.name || j.symbol}. Answered from saved call notes and reported numbers, ${j.cost.cached ? 'cached' : `${((j.cost.tokIn + j.cost.tokOut) / 1000).toFixed(1)}k tokens`}.` : undefined }, ...l.slice(1)]);
    } catch {
      setLog((l) => [{ q: question, a: 'Could not reach FINN. Check the connection and ask again.' }, ...l.slice(1)]);
    }
    setBusy(false);
  };

  const listen = () => {
    const W = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = W.SpeechRecognition || W.webkitSpeechRecognition;
    if (!Ctor) return setLog((l) => [{ q: 'Voice', a: 'This browser has no speech recognition. Chrome and Safari do.' }, ...l]);
    if (hearing) { rec.current?.stop(); return; }
    const r = new Ctor();
    r.lang = 'en-IN'; r.interimResults = false;
    r.onresult = (e) => { const t = e.results[0][0].transcript; setQ(t); send(t); };
    r.onend = () => setHearing(false);
    r.onerror = () => setHearing(false);
    rec.current = r; setHearing(true); r.start();
  };

  const sug = symbol
    ? ['What did they promise on margins, and did they deliver?', 'Where do the numbers contradict the story?', 'What are analysts pushing back on?', 'What is the capex plan?']
    : ['What is POLYCAB guiding for this year?', 'Has KPITTECH met its growth guidance?', 'What are analysts worried about at ASIANPAINT?'];

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet dark" role="dialog" aria-modal="true" aria-label="Ask FINN">
        <h2>Ask FINN <button className="x" onClick={onClose} aria-label="Close">×</button></h2>
        <p className="ctx">{symbol ? `About ${ctx.name && ctx.symbol === symbol ? ctx.name : symbol}. Answers come only from its filings and calls.` : 'Name a company in your question. Answers come only from its own filings and calls.'}</p>
        <form onSubmit={(e) => { e.preventDefault(); send(q); }}>
          <input ref={input} type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={symbol ? `Ask about ${symbol}` : 'Ask about a company'} aria-label="Your question" enterKeyHint="send" />
          <button type="button" className="round" onClick={listen} aria-pressed={hearing} aria-label={hearing ? 'Stop listening' : 'Ask by voice'}>{Icon.mic}</button>
          <button type="submit" className="go" disabled={busy}>{busy ? '…' : 'Ask'}</button>
        </form>
        {!log.length && <div className="sug">{sug.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>}
        {log.map((x, i) => (
          <div className="qa" key={i}>
            <div className="q">{x.q}</div>
            {x.a ? <div className="a">{x.a}</div> : <><div className="skel" style={{ width: '88%', opacity: 0.35 }} /><div className="skel" style={{ width: '60%', opacity: 0.35 }} /></>}
            {x.needs === 'research' && x.symbol && <button className="btn" style={{ background: 'var(--flag)', color: 'var(--ink)' }} onClick={() => { openResearch(x.symbol!); onClose(); }}>Read {x.symbol} now</button>}
            {!!x.cites?.length && <div className="c">{x.cites.map((c) => (c.url ? <a key={c.label} href={c.url} target="_blank" rel="noreferrer">{c.label}</a> : <span key={c.label}>{c.label}</span>))}</div>}
            {x.meta && <div className="m">{x.meta}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
