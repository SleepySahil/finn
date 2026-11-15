'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { tierFor } from '@/lib/brain/classify';
import { alerts, DEFAULT_THRESHOLDS } from '@/lib/brain/signals';
import type { BriefPayload, Enrichment, Filing } from '@/lib/types';
import Brief, { type Settings } from './Brief';
import Watch from './Watch';
import Research from './Research';
import Ask, { type AskCtx } from './Ask';
import { useLocal } from './ui';

type Tab = 'brief' | 'watch' | 'research';
const DEFAULTS: Settings = { th: DEFAULT_THRESHOLDS, routing: {}, hours: 24, since: null, lastSeen: 0 };

export default function App() {
  const [tab, setTab] = useState<Tab>('brief');
  const [data, setData] = useState<BriefPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [settings, set, ready] = useLocal<Settings>('finn.settings.v1', DEFAULTS);
  const [prevSeen, setPrevSeen] = useState(0);
  const [enrich, setEnrich] = useState<Record<string, Enrichment | null>>({});
  const [target, setTarget] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskCtx | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  const [widened, setWidened] = useState<string | null>(null);
  const inflight = useRef(new Set<string>());
  const checked = useRef(false);

  // Snapshot first (static file, instant, cannot fail), then live on top.
  useEffect(() => {
    let live = false;
    fetch('/snapshot/brief.json').then((r) => (r.ok ? r.json() : null)).then((j: BriefPayload | null) => { if (j && !live) { setData(j); setEnrich((e) => ({ ...j.enrich, ...e })); } }).catch(() => {});
    fetch('/api/brief?days=30').then((r) => r.json()).then((j: BriefPayload & { error?: string }) => {
      if (j.error || !j.filings) throw new Error(j.error || 'bad payload');
      live = true; setData(j); setEnrich((e) => ({ ...j.enrich, ...e }));
    }).catch(() => setErr('Live data is unreachable right now.'));
  }, []);

  // "New since you last looked": remember the previous visit, then stamp this one.
  useEffect(() => {
    if (!ready) return;
    setPrevSeen(settings.lastSeen);
    set((p) => ({ ...p, lastSeen: Date.now(), since: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // A 24h window is empty every weekend. Widen once, and say so.
  useEffect(() => {
    if (!data || !ready || checked.current) return;
    checked.current = true;
    if (settings.since || settings.hours !== 24) return;
    const count = (h: number) => {
      const since = Date.now() - h * 3600e3;
      const fs = data.filings.filter((f) => Date.parse(f.at) >= since).map((f) => tierFor(f, settings.routing));
      return { act: fs.filter((t) => t === 'act').length + alerts(data.prices, settings.th, since).length, know: fs.filter((t) => t === 'know').length };
    };
    if (count(24).act) return;
    // smallest wider window with something to surface; failing that, one with anything worth a line
    const h = [72, 168].find((x) => count(x).act) || (count(24).know ? 0 : [72, 168].find((x) => count(x).know)) || 0;
    if (h) { set((p) => ({ ...p, hours: h })); setWidened(`Nothing surfaced in the last 24 hours (markets were closed), so this shows the last ${h === 72 ? '3' : '7'} days. Tap 24h to go back.`); }
  }, [data, ready, settings, set]);

  const wantEnrich = useCallback((f: Filing) => {
    if (inflight.current.has(f.id)) return;
    inflight.current.add(f.id);
    fetch('/api/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filing: { ...f, related: undefined } }) })
      .then((r) => r.json()).then((j) => setEnrich((e) => ({ ...e, [f.id]: j.enrichment || null })))
      .catch(() => setEnrich((e) => ({ ...e, [f.id]: null })));
  }, []);

  const say = useCallback((msg: string, undo?: () => void) => { setToast({ msg, undo }); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5200); return () => clearTimeout(t); }, [toast]);

  const openResearch = useCallback((s: string) => { setTarget(s); setTab('research'); window.scrollTo({ top: 0 }); }, []);
  const go = (t: Tab) => { setTab(t); if (t === 'research' && tab === 'research') setTarget(null); window.scrollTo({ top: 0 }); };
  const shown = { ...settings, lastSeen: prevSeen };

  return (
    <div className="app">
      {!data && (
        <div className="page">
          <header className="mast"><span className="mark">FINN</span></header>
          {err ? <div className="empty"><b>{err}</b> No saved snapshot was found either. Run <code>npm run ingest</code> once to create one.</div>
            : <div style={{ padding: '26px var(--pad)' }}><div className="skel" style={{ height: 44, width: '70%' }} /><div className="skel" style={{ height: 30, width: '56%' }} /><div className="skel" style={{ height: 24, width: '40%' }} /></div>}
        </div>
      )}
      {data && tab === 'brief' && <Brief data={data} settings={shown} set={set} enrich={enrich} wantEnrich={wantEnrich} openResearch={openResearch} openAsk={setAsk} toast={say} widened={settings.hours === 24 || settings.since ? null : widened} />}
      {data && tab === 'watch' && <Watch data={data} settings={settings} set={set} openResearch={openResearch} />}
      {data && tab === 'research' && <Research target={target} setTarget={setTarget} portfolio={data.portfolio} openAsk={setAsk} />}

      {toast && <div className="toast" role="status">{toast.msg}{toast.undo && <button onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>}</div>}
      {ask && <Ask ctx={ask} onClose={() => setAsk(null)} openResearch={openResearch} />}

      <div className="dock">
        <div className="askbar">
          <button className="field" onClick={() => setAsk(tab === 'research' && target ? { symbol: target } : {})}>
            {tab === 'research' && target ? `Ask about ${target}` : 'Ask FINN about a company'}
          </button>
        </div>
        <nav className="tabs" aria-label="Sections">
          <button aria-current={tab === 'brief' ? 'page' : undefined} onClick={() => go('brief')}><span>Brief</span></button>
          <button aria-current={tab === 'watch' ? 'page' : undefined} onClick={() => go('watch')}><span>Watch</span></button>
          <button aria-current={tab === 'research' ? 'page' : undefined} onClick={() => go('research')}><span>Research</span></button>
        </nav>
      </div>
    </div>
  );
}
