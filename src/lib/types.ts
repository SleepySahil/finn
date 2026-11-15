// Shared shapes. Everything the UI renders is one of these.

export type Category =
  | 'results' | 'm_and_a' | 'fund_raise' | 'management_change' | 'litigation'
  | 'insider_trading' | 'earnings_call' | 'investor_meetings' | 'credit_rating'
  | 'dividend' | 'bonus_split' | 'capex' | 'press_release' | 'postal_ballot'
  | 'agm_egm' | 'pledging' | 'unclassified';

/** act = surface it now · know = one line · bury = counted, collapsed */
export type Tier = 'act' | 'know' | 'bury';

export interface Holding {
  symbol: string;        // NSE symbol
  name: string;
  sector: string;
  cap: 'Large' | 'Mid' | 'Small';
  scrip?: number;        // BSE scrip code, resolved from screener at ingest
  lender?: boolean;      // banks / NBFCs: debt issuance is routine, EBITDA is not a thing
}

export interface Filing {
  id: string;
  symbol: string;
  company: string;
  scrip: number;
  at: string;            // ISO, IST offset
  subject: string;       // exchange subject line
  headline: string;      // company's own headline (often more specific)
  bseCat: string;
  bseSub: string;
  pdf?: string;
  pdfBytes?: number;
  category: Category;
  subtype: string;       // finer than category: "Results filed", "CFO change", "Newspaper ad"
  tier: Tier;            // FINN's default call; the user's routing can override it
  why: string;           // one clause: why it sits in that tier
  noise?: boolean;       // stays buried even when the user surfaces its category
  via: 'rule' | 'llm' | 'fallback';
  related?: Filing[];    // same event, folded in (results day = 5 filings, 1 card)
}

export interface Bars {
  symbol: string;
  name?: string;
  t: number[];           // epoch seconds
  c: number[];           // close
  v: number[];           // volume
  hi52?: number;
  lo52?: number;
}

export interface Metric { key: string; cur: number | null; prev: number | null; yago: number | null; qoq: number | null; yoy: number | null; unit: 'cr' | '%' }

export interface ResultsCut {
  kind: 'results';
  period: string;        // "Q2 FY27"
  periodEnd: string;     // "Sep 2026"
  metrics: Metric[];     // Revenue, EBITDA, PBT, PAT
  margin?: { cur: number | null; yago: number | null; bps: number | null; label: string };
  line: string;          // deterministic one-liner
  source: 'filing' | 'screener';
  note?: string;
  checked?: 'matches' | 'differs';   // filing-extracted vs standardised table
}

export interface PersonChange {
  person: string;
  role: string;
  action: string;        // appointed | resigned | retired | re-appointed | ceased
  effective?: string;
  reason?: string;
  background?: string;   // from the brief profile in the filing itself
  prior?: string[];
  lookup: string;        // LinkedIn search link — we link, we don't scrape
}

export interface MgmtCut { kind: 'mgmt'; changes: PersonChange[]; line: string; source: 'filing' | 'web' }
export interface SummaryCut { kind: 'summary'; line: string; numbers?: string[] }
export type Enrichment = (ResultsCut | MgmtCut | SummaryCut) & { cost?: Cost; at?: string };

export interface Cost { calls: number; cached: number; tokIn: number; tokOut: number; usd: number; models: string[] }

// ---------- research ----------

export interface Table { periods: string[]; rows: Record<string, (number | null)[]> }

export interface DocLink { title: string; url: string; period?: string; quarter?: string }

export interface CompanyData {
  symbol: string;
  name: string;
  scrip?: number;
  consolidated: boolean;
  lender: boolean;
  top: Record<string, string>;
  quarters: Table;
  pnl: Table;
  balance: Table;
  cash: Table;
  ratios: Table;
  holding: Table;
  growth: Record<string, Record<string, string>>;
  annualReports: DocLink[];
  concalls: DocLink[];
  fetchedAt: string;
}

export interface Flag { tone: 'good' | 'bad' | 'neutral'; text: string }

export interface Facts {
  symbol: string;
  name: string;
  lender: boolean;
  asOf: string;
  price?: string;
  mcap?: string;
  snapshot: { label: string; value: string; sub?: string }[];
  trajectory: { years: string[]; revenue: (number | null)[]; opm: (number | null)[]; pat: (number | null)[]; flags: Flag[]; cagr: Record<string, string> };
  quarters: { periods: string[]; revenue: (number | null)[]; revYoy: (number | null)[]; opm: (number | null)[]; pat: (number | null)[]; patYoy: (number | null)[] };
  balance: { years: string[]; debt: (number | null)[]; equity: (number | null)[]; de: (number | null)[]; ccc: (number | null)[]; debtorDays: (number | null)[]; inventoryDays: (number | null)[]; roce: (number | null)[]; flags: Flag[] };
  cash: { years: string[]; cfo: (number | null)[]; pat: (number | null)[]; fcf: (number | null)[]; conv: (number | null)[]; cum: { cfo: number; pat: number; ratio: number | null; n: number }; flags: Flag[] };
  docs: { concalls: DocLink[]; annualReports: DocLink[] };
}

export interface GuidanceItem {
  metric: string;
  statement: string;
  quote: string;
  speaker?: string;
  page?: number;
  horizon?: string;
  low?: number | null;
  high?: number | null;
  unit?: string;
  firmness?: 'explicit' | 'directional';
}

export interface CallNotes {
  url: string;
  quarter: string;       // "Q2 FY27"
  period: string;        // "Oct 2026"
  pages: number;
  guidance: GuidanceItem[];
  claims: { claim: string; quote: string; page?: number }[];
  pressure: string[];    // what analysts pushed on
  business?: string;
  segments?: { name: string; note: string }[];
  risks?: string[];
  cost?: Cost;
}

export interface LedgerRow {
  promise: string;
  saidIn: string;
  quote?: string;
  page?: number;
  url?: string;
  metric?: string;
  target?: string;
  actual?: string;
  actualPeriod?: string;
  verdict: 'delivered' | 'missed' | 'partly' | 'too_early' | 'unverifiable';
  gap?: string;
  checked?: 'code' | 'model';
}

export interface Dossier {
  symbol: string;
  name: string;
  facts: Facts;
  notes: CallNotes[];
  ledger: LedgerRow[];
  sayDo: { delivered: number; missed: number; partly: number; open: number };
  divergences: { theme: string; narrative: string; numbers: string; verdict: 'agree' | 'diverge' }[];
  guidanceNow: { metric: string; target: string; horizon?: string; saidIn: string; quote?: string; page?: number; url?: string }[];
  bull: { point: string; evidence: string }[];
  bear: { point: string; evidence: string }[];
  business?: { what: string; segments: { name: string; note: string }[] };
  oneLine?: string;
  cost: Cost;
  builtAt: string;
  depth: 'numbers' | 'full';   // numbers = no LLM key; full = transcripts read
}

export interface BriefPayload {
  generatedAt: string;
  mode: 'live' | 'snapshot';
  portfolio: Holding[];
  filings: Filing[];
  prices: Record<string, Bars>;
  enrich: Record<string, Enrichment>;
  llm: boolean;
  notes?: string[];
}
