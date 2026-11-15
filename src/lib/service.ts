import cfg from '../../data/portfolio.json';
import { cacheGet, cacheSet, snapRead } from './cache';
import { getBars } from './sources/yahoo';
import { getAnnouncements, type RawFiling } from './sources/bse';
import { getCompany, searchCompanies } from './sources/screener';
import { classify, foldEvents } from './brain/classify';
import { classifyResidue } from './brain/enrich';
import { buildFacts } from './research/facts';
import { llmAvailable, Meter } from './llm/router';
import { pool } from './util';
import type { FullDossier } from './research/synth';
import type { Bars, BriefPayload, CompanyData, Facts, Filing, Holding } from './types';

export const PORTFOLIO = cfg.portfolio as Holding[];
export const RESEARCH_SET = cfg.research as string[];

type Universe = Record<string, { scrip?: number; name?: string; lender?: boolean }>;

/** NSE symbol → BSE scrip code. Resolved once from the screener page and remembered; nothing is hard-coded. */
export async function holdings(): Promise<Holding[]> {
  const uni = (await snapRead<Universe>('universe.json')) || {};
  return PORTFOLIO.map((h) => ({ ...h, scrip: h.scrip ?? uni[h.symbol]?.scrip }));
}

export async function scripFor(symbol: string): Promise<{ scrip?: number; name: string; lender: boolean }> {
  const key = `scrip:${symbol}`;
  const hit = await cacheGet<{ scrip?: number; name: string; lender: boolean }>(key);
  if (hit) return hit;
  const uni = (await snapRead<Universe>('universe.json')) || {};
  if (uni[symbol]?.scrip) return { scrip: uni[symbol].scrip, name: uni[symbol].name || symbol, lender: Boolean(uni[symbol].lender) };
  const c = await getCompany(symbol);
  const v = { scrip: c.scrip, name: c.name, lender: c.lender };
  await cacheSet(key, v, 30 * 86400);
  return v;
}

export function toFiling(r: RawFiling, h: Holding): Filing {
  const c = classify(r, h);
  return { ...r, symbol: h.symbol, company: h.name, ...c };
}

export const flatten = (fs: Filing[]): Filing[] => fs.flatMap((f) => [{ ...f, related: undefined }, ...(f.related || [])]);

/** Live filings for the whole portfolio. Each company is its own request; one failing does not sink the brief. */
export async function liveFilings(hs: Holding[], days: number): Promise<{ filings: Filing[]; failed: string[] }> {
  const to = new Date(), from = new Date(Date.now() - days * 86400e3);
  const failed: string[] = [];
  const lists = await pool(hs.filter((h) => h.scrip), 5, async (h) => {
    try {
      return (await getAnnouncements(h.scrip!, from, to)).map((r) => toFiling(r, h));
    } catch {
      failed.push(h.symbol);
      return [] as Filing[];
    }
  });
  return { filings: lists.flat(), failed };
}

export async function livePrices(hs: Holding[], range = '6mo'): Promise<{ prices: Record<string, Bars>; failed: string[] }> {
  const prices: Record<string, Bars> = {};
  const failed: string[] = [];
  await pool(hs, 6, async (h) => {
    try { prices[h.symbol] = await getBars(h.symbol, range); } catch { failed.push(h.symbol); }
  });
  return { prices, failed };
}

/** Send only what the rules could not place to the cheap model, in one batch, and apply its answer. */
export async function placeResidue(filings: Filing[], meter = new Meter()): Promise<Filing[]> {
  const residue = filings.filter((f) => f.via === 'fallback');
  if (!residue.length || !llmAvailable()) return filings;
  const placed = await classifyResidue(residue.slice(0, 75), meter);
  return filings.map((f) => { const p = placed.get(f.id); return p ? { ...f, ...p, via: 'llm' as const } : f; });
}

/**
 * The brief: snapshot first, live on top. The committed snapshot guarantees there is always
 * something real to show; live data replaces it source by source as each upstream answers.
 */
export async function buildBrief(days = 30, live = true): Promise<BriefPayload> {
  const snap = await snapRead<BriefPayload>('brief.json');
  const hs = await holdings();
  const notes: string[] = [];
  let filings = snap ? flatten(snap.filings) : [];
  let prices = snap?.prices || {};
  let mode: BriefPayload['mode'] = 'snapshot';
  if (live) {
    const [f, p] = await Promise.all([liveFilings(hs, days), livePrices(hs)]);
    if (f.filings.length) {
      const ids = new Set(f.filings.map((x) => x.id));
      const known = new Map(filings.map((x) => [x.id, x]));
      // keep a model's earlier placement of a filing the rules could not classify
      filings = [...f.filings.map((x) => (x.via === 'fallback' && known.get(x.id)?.via === 'llm' ? known.get(x.id)! : x)), ...filings.filter((x) => !ids.has(x.id))];
      mode = 'live';
    }
    if (f.failed.length) notes.push(`Filings unavailable for ${f.failed.length} of ${hs.length} names right now${f.filings.length ? '' : ' — showing the saved snapshot'}.`);
    if (Object.keys(p.prices).length) { prices = { ...prices, ...p.prices }; mode = 'live'; }
    if (p.failed.length) notes.push(`Prices unavailable for ${p.failed.length} names.`);
    const noScrip = hs.filter((h) => !h.scrip).length;
    if (noScrip) notes.push(`${noScrip} names have no exchange code yet — run the ingest once.`);
  }
  const cutoff = Date.now() - days * 86400e3;
  filings = filings.filter((x) => Date.parse(x.at) >= cutoff);
  return {
    generatedAt: mode === 'live' ? new Date().toISOString() : snap?.generatedAt || new Date().toISOString(),
    mode, portfolio: hs, filings: foldEvents(filings), prices, enrich: snap?.enrich || {}, llm: llmAvailable(), notes,
  };
}

// ---------- research ----------
export async function company(symbol: string): Promise<CompanyData> {
  const key = `co:${symbol}`;
  const hit = await cacheGet<CompanyData>(key);
  if (hit) return hit;
  const c = await getCompany(symbol);
  await cacheSet(key, c, 6 * 3600);
  return c;
}

export async function facts(symbol: string): Promise<Facts> {
  return buildFacts(await company(symbol));
}

export async function savedDossier(symbol: string): Promise<FullDossier | undefined> {
  return (await cacheGet<FullDossier>(`dossier:${symbol}`)) || (await snapRead<FullDossier>(`research/${symbol}.json`));
}

export async function search(q: string) {
  const local = PORTFOLIO.filter((h) => `${h.symbol} ${h.name}`.toLowerCase().includes(q.toLowerCase())).map((h) => ({ symbol: h.symbol, name: h.name }));
  try {
    const remote = await searchCompanies(q);
    const seen = new Set(local.map((x) => x.symbol));
    return [...local, ...remote.filter((x) => !seen.has(x.symbol))].slice(0, 8);
  } catch {
    return local;
  }
}
