import type { Category, Filing, Holding, Tier } from '../types';

/**
 * Tier 0 of the model router: no model at all.
 *
 * Exchange filings are formulaic — the subject line is picked from a dropdown — so an ordered
 * rule list classifies the bulk for free, in microseconds, and deterministically. Only what
 * falls through to the last rule is ever sent to a (cheap) model, in one batched call.
 *
 * The categories are ENAM's 17. The judgment is in `subtype` and `tier`: "results" covers both
 * the results themselves (surface) and the newspaper ad confirming they were published (bury).
 */
interface Rule {
  cat: Category;
  sub: string;
  tier: Tier;
  why: string;
  test: RegExp;
  /** must also match */
  needs?: RegExp;
  /** must not match */
  not?: RegExp;
  noise?: boolean;
  /** tier for banks / NBFCs when it differs (their debt issuance is routine) */
  lender?: { tier: Tier; why: string };
}

const R = (cat: Category, sub: string, tier: Tier, why: string, test: RegExp, extra: Partial<Rule> = {}): Rule => ({ cat, sub, tier, why, test, ...extra });

const KEY_ROLE = /managing director|\bM\.?D\.?\b|chief executive|\bCEO\b|chief financial|\bCFO\b|chair(man|person)|whole[- ]?time director|(?<!non[- ]?)executive director|chief operating|\bCOO\b|(?<!vice[- ]?)\bpresident\b|chief technology|\bCTO\b/i;

export const RULES: Rule[] = [
  // --- clarifications first: a rumour denial mentions the thing it denies ---
  R('press_release', 'Rumour clarification', 'act', 'Company responding to a media report or price move', /clarification|media report|news (item|report)|rumou?r|price movement|spurt in (volume|price)/i),

  // --- paperwork that must never surface, whatever words it contains ---
  R('results', 'Newspaper ad', 'bury', 'Advertisement confirming results were published', /newspaper|advertisement|published in/i, { needs: /result/i, noise: true }),
  R('unclassified', 'Newspaper notice', 'bury', 'Statutory newspaper notice', /newspaper|advertisement/i, { noise: true }),
  R('unclassified', 'Trading window', 'bury', 'Routine insider-trading window closure', /trading window/i, { noise: true }),
  R('unclassified', 'Compliance filing', 'bury', 'Periodic compliance paperwork', /reg(ulation)?\.? ?74 ?\(5\)|reg(ulation)?\.? ?40 ?\(9\)|reg(ulation)?\.? ?7 ?\(3\)|compliance certificate|certificate (under|pursuant)|pursuant to SEBI circular|compliances?\s*[-:]|investor (complaints|grievance)|secretarial compliance|reg\.? ?39 ?\(3\)|loss of (share )?certificate|duplicate (share )?certificate|statement of (deviation|investor)|monitoring agency|business responsibility|\bBRSR\b|\bESG\b|sustainability report|change in (registered|corporate) office|shifting of registered office|\bISIN\b|\bRTA\b|registrar (and|&) (share )?transfer|large corporate|annual disclosure|reminder (letter|notice)|\bIEPF\b|investor education|demateriali[sz]|half[- ]?yearly report|related party transactions?/i, { noise: true }),
  R('unclassified', 'ESOP allotment', 'bury', 'Employee stock options: tiny dilution, routine', /\bESOP|\bESPS|\bESOS|employee stock|stock option|\bRSU\b|grant of options/i, { noise: true }),
  R('unclassified', 'Auditor exit', 'act', 'A statutory auditor leaving mid-term is a governance red flag', /resignation of (the )?(statutory )?auditor|auditor.{0,20}resign/i),
  R('unclassified', 'Auditor appointment', 'bury', 'Routine auditor appointment', /(statutory|secretarial|cost|internal|tax) auditors?|appointment of (the )?auditor/i, { noise: true }),

  // --- insolvency before results/M&A: "resolution plan approved" is not an acquisition ---
  R('litigation', 'Insolvency / NCLT', 'act', 'Insolvency or tribunal proceedings', /\bCIRP\b|insolvency|\bNCLT\b|\bNCLAT\b|\bIBC\b|resolution (plan|professional)|liquidat|winding up/i),

  // --- earnings-call material before results: a transcript's headline says "financial results" too ---
  R('earnings_call', 'Call transcript', 'know', 'Transcript is out — FINN can now read it for guidance', /transcript/i),
  R('earnings_call', 'Results presentation', 'know', "Management's own framing of the quarter", /(investor|earnings|results?|analysts?) presentation|presentation (to|for|made to) (analyst|investor)|investor_presentation/i),
  R('earnings_call', 'Call notice / recording', 'bury', 'Logistics of the earnings call', /(earnings|conference|investor|analyst|con)[- ]?call|audio|video recording|recording of|webcast/i, { noise: true }),
  R('investor_meetings', 'Investor meet', 'bury', 'Calendar of meetings with funds', /analyst|investor.{0,30}(meet|conference|interaction)|institutional investor|schedule of|non-?deal roadshow|investor day/i, { noise: true }),

  // --- results ---
  R('results', 'Results date set', 'know', 'Board meeting scheduled to approve results', /(intimation|notice).{0,100}results?\b|board meeting.{0,60}(to consider|for considering|consider and approve).{0,60}result/i, { not: /voting|postal ballot|\bAGM\b|annual general|outcome/i }),
  R('results', 'Shareholder letter', 'know', "Management's letter alongside the numbers", /shareholders?'? letter/i),
  R('press_release', 'Parent or peer results', 'know', 'Refers to another company’s results', /reference to.{0,40}results|results? (issued|announced|declared) by/i),
  R('results', 'Results filed', 'act', 'Quarterly or annual numbers are out', /financial results?|(un)?-?audited.{0,80}(result|financial statements?)|results? for (the )?(quarter|half|year|period)|integrated filing.{0,20}financial/i),

  // --- people ---
  R('management_change', 'Company secretary / compliance officer', 'bury', 'Compliance-role change', /company secretary|compliance officer/i, { noise: true }),
  R('management_change', 'Re-appointment', 'know', 'Same person, same seat — no change at the top', /re-?appoint/i, { not: /resign|retire|cessation|ceas|step(s|ped|ping)? down|demise/i }),
  R('management_change', 'Top-management change', 'act', 'Change in the people running the company', /(appoint|resign|cessation|ceas|retire|step(s|ped|ping)? down|demise|passed away|change in (management|directorate|key managerial)|elevat|succession|re-?designat|relinquish)/i, { needs: KEY_ROLE }),
  R('management_change', 'Senior management / KMP', 'know', 'Senior-management change below the top', /(appoint|resign|cessation|retire|change in).{0,60}(senior management|key managerial|\bKMP\b|\bSMP\b|head of|vice president)/i),
  R('management_change', 'Board change', 'know', 'Director joining or leaving the board', /(appoint|resign|cessation|ceas|retire|change in directorate|completion of tenure).{0,80}director|director.{0,60}(appoint|resign|cessation|ceas|retire)|change in directorate|change in management|retirement|resignation|cessation/i),

  // --- ownership signals ---
  R('pledging', 'Pledge created / invoked', 'act', 'Promoter shares pledged or a pledge invoked', /(creation|invocation|invoked|created).{0,40}(pledge|encumbr)|(pledge|encumbr).{0,40}(creation|invocation|invoked|created)/i),
  R('pledging', 'Pledge update', 'know', 'Change in promoter pledge status', /pledge|encumbr|reg(ulation)?\.? ?31 ?\(/i),
  R('insider_trading', 'Insider / promoter trade', 'know', 'Promoter or insider changed their holding', /insider trading|\bSAST\b|reg(ulation)?\.? ?29 ?\(|reg(ulation)?\.? ?7 ?\(2\)|\bPIT\b|substantial acquisition|(acquisition|sale|disposal) of shares by (promoter|director)|promoter.{0,40}(acquir|sold|purchas|bought)/i),

  // --- a subsidiary going public is a stake sale by another name ---
  R('m_and_a', 'Subsidiary IPO / listing', 'act', 'A group company is being listed — value moves outside the parent', /initial public offer|\bIPO\b|listing of (the )?(equity )?shares of|offer for sale|\bOFS\b|red herring|\bDRHP\b/i),

  // --- money in / out: debt before equity, because both are filed as "Allotment" ---
  R('fund_raise', 'Buyback', 'act', 'Company returning cash by buying its own shares', /buy-?back/i),
  R('fund_raise', 'Debt issuance', 'know', 'New borrowing', /commercial papers?|\bCPs?\b|\bNCDs?\b|non-?convertible|debentures?|\bbonds?\b|term loan|\bECB\b|borrowing/i, { lender: { tier: 'bury', why: 'Routine funding for a lender' } }),
  R('fund_raise', 'Equity raise', 'act', 'Fresh equity — dilution for existing holders', /\bQIP\b|qualified institution|rights issue|preferential (issue|allotment)|\bPI 20\d\d\b|further public offer|\bFPO\b|warrants|\bFCCB\b|raising of funds|fund ?rais|issue of (equity|securities)/i),
  R('fund_raise', 'Share allotment', 'know', 'New shares allotted — check whether it is a raise or staff options', /allotment/i),
  R('unclassified', 'Committee meeting', 'know', 'Board committee outcome — usually a step in a fund raise', /committee|meeting updates/i),

  // --- regulators and courts ---
  R('litigation', 'Regulatory action', 'act', 'Regulator or enforcement action', /\bSEBI\b.{0,40}(order|notice|penalt)|show cause|search (and|&) seizure|\braid\b|enforcement directorate|\bCBI\b|warning letter|import alert|form 483|\bOAI\b|\bfraud\b|\bdefault\b|debar|suspension of|cancellation of licen[cs]e/i),
  R('litigation', 'USFDA inspection', 'know', 'Plant inspection outcome', /\bUS ?FDA\b|\bEIR\b|inspection/i),
  R('litigation', 'Tax / legal order', 'know', 'Tax demand or court order — size decides whether it matters', /litigation|dispute|penalt|\bfine\b|\bGST\b|income tax|tax demand|demand (order|notice)|assessment order|arbitra|court|tribunal|adjudicat|appeal|regulatory action|order (passed|received)/i),

  // --- corporate actions ---
  R('m_and_a', 'Entity housekeeping', 'bury', 'Dormant group entity struck off or merged away', /strike off|striking off|dissolution|de-?registration/i),
  R('m_and_a', 'Deal', 'act', 'Changes what the company owns', /acqui|merger|amalgamat|demerger|scheme of arrangement|joint venture|slump sale|divest|disinvest|restructuring|open offer|takeover|sale (or disposal )?of.{0,30}(stake|shares|undertaking|unit|subsidiar|business)|strategic (stake|investment)|share purchase agreement|binding (term sheet|agreement)/i, { not: /update|incorporat/i }),
  R('m_and_a', 'Deal update', 'know', 'Progress on a deal, or a new subsidiary', /acqui|merger|amalgamat|demerger|scheme of arrangement|joint venture|incorporation of|wholly[- ]owned subsidiary|investment in|subsidiar/i),
  R('credit_rating', 'Rating change', 'act', 'Rating or outlook moved', /(credit )?rating.{0,60}(upgrad|downgrad|revis|watch|withdraw)|(upgrad|downgrad).{0,40}rating|outlook.{0,20}(revis|chang)/i),
  R('credit_rating', 'Rating reaffirmed', 'bury', 'Rating unchanged', /credit rating|\brating\b|\bCRISIL\b|\bICRA\b|care ratings|india ratings/i),
  R('bonus_split', 'Bonus / split', 'know', 'Share count changes, value does not', /bonus|stock split|sub-?division|split of/i),
  R('dividend', 'Dividend', 'know', 'Cash payout declared', /dividend|record date/i),
  R('capex', 'Capacity / capex', 'know', 'New plant or capacity', /capex|capital expenditure|capacity (expansion|addition|enhancement)|new (plant|facility|unit|line)|greenfield|brownfield|commenc.{0,30}(production|operations)|commission|expansion|setting up/i),

  // --- shareholder meetings ---
  R('postal_ballot', 'Postal ballot', 'bury', 'Shareholder vote by post', /postal ballot|e-?voting|voting results?|scrutini[sz]er/i),
  R('agm_egm', 'Shareholder meeting', 'bury', 'Meeting notice or proceedings', /\bAGM\b|\bEGM\b|annual general|extra-?ordinary general|shareholders?'? meeting|book closure|annual report/i),

  // --- business news ---
  R('press_release', 'Business update', 'know', 'Operating numbers from the company', /(monthly|quarterly|business|operational|sales|production|volume|provisional).{0,20}(update|data|figures|numbers|performance|volume)|production volume|sales volume|auto sales|\bsales (in|for|during)\b|market update|\bAUM\b|deposits|advances|disbursement/i),
  R('press_release', 'Order win', 'know', 'New order or contract', /\border\b|contract|letter of (award|intent|acceptance)|\bLOA\b|\bLOI\b|bags|secures|wins?\b|empanel/i),
  R('unclassified', 'Guarantee given', 'know', 'A guarantee is a liability that sits off the balance sheet', /guarantee|indemnity|surety/i),
  R('press_release', 'Press release', 'know', 'Company news', /press release|media (release|statement)|launch|partnership|collaborat|\bMoU\b|memorandum of understanding|agreement|tie-?up|approval|patent|licen[cs]e|award/i),

  R('unclassified', 'Board meeting', 'know', 'Board outcome with no recognised agenda — worth a glance', /outcome of (the )?(board|meeting)|board meeting/i),
  // The company filed it under a title that says nothing. Do not guess: say so, and let the reader (or the model) open it.
  R('unclassified', 'Untitled disclosure', 'know', 'Filed with a title that says nothing — one tap and FINN reads it', /^(disclosure|intimation|announcement|general )?\s*(under regulation 30|updates?\b|general updates?)/i),
];

export const FALLBACK = { cat: 'unclassified' as Category, sub: 'Other', tier: 'bury' as Tier, why: 'No rule matched — routine by default' };

export const CATEGORY_LABEL: Record<Category, string> = {
  results: 'Results', m_and_a: 'M&A', fund_raise: 'Fund raise', management_change: 'Management', litigation: 'Legal & regulatory',
  insider_trading: 'Insider trades', earnings_call: 'Earnings call', investor_meetings: 'Investor meets', credit_rating: 'Credit rating',
  dividend: 'Dividend', bonus_split: 'Bonus / split', capex: 'Capex', press_release: 'Company news', postal_ballot: 'Postal ballot',
  agm_egm: 'AGM / EGM', pledging: 'Pledging', unclassified: 'Paperwork',
};
export const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[];

export interface Classified { category: Category; subtype: string; tier: Tier; why: string; noise?: boolean; via: 'rule' | 'fallback' }

export function classify(f: { subject: string; headline: string; bseCat: string; bseSub: string }, h?: Pick<Holding, 'lender'>): Classified {
  // BSE's own bucket is a strong prior for results; everything else is too coarse ("Company Update" is 60% of the feed).
  const text = `${f.subject} | ${f.headline} | ${f.bseSub}`;
  for (const r of RULES) {
    if (!r.test.test(text)) continue;
    if (r.needs && !r.needs.test(text)) continue;
    if (r.not && r.not.test(text)) continue;
    const l = h?.lender && r.lender;
    return { category: r.cat, subtype: r.sub, tier: l ? l.tier : r.tier, why: l ? l.why : r.why, noise: r.noise, via: 'rule' };
  }
  if (f.bseCat === 'Result') return { category: 'results', subtype: 'Results filed', tier: 'act', why: 'Quarterly or annual numbers are out', via: 'rule' };
  return { category: FALLBACK.cat, subtype: FALLBACK.sub, tier: FALLBACK.tier, why: FALLBACK.why, via: 'fallback' };
}

/**
 * One event, one card.
 *  - A results day is five or six filings (board outcome, results, press release, deck, call
 *    recording, newspaper ad): fold them under the results filing.
 *  - A fund raise, a deal, a tribunal case or a rumour is a THREAD of procedural filings
 *    (intimation → committee → pricing → allotment): keep the latest, fold the rest behind it.
 */
const THREAD_DAYS: Record<string, number> = { 'Equity raise': 30, 'Subsidiary IPO / listing': 30, 'Insolvency / NCLT': 30, Deal: 5, 'Rumour clarification': 2, 'Top-management change': 3, 'Debt issuance': 30 };
const H = 3600e3;

export function foldEvents(filings: Filing[]): Filing[] {
  const sorted = [...filings].map((f) => ({ ...f, related: undefined as Filing[] | undefined })).sort((a, b) => a.at.localeCompare(b.at));
  const eaten = new Set<string>();
  const gap = (a: Filing, b: Filing) => Math.abs(Date.parse(a.at) - Date.parse(b.at));
  const eat = (anchor: Filing, f: Filing) => { (anchor.related ||= []).push(f); eaten.add(f.id); };

  // 1. results days: the first "results filed" of a company is the anchor
  const anchors: Filing[] = [];
  for (const f of sorted) {
    if (f.subtype !== 'Results filed') continue;
    const prev = anchors.find((k) => k.symbol === f.symbol && gap(k, f) < 36 * H);
    if (prev) eat(prev, f); else anchors.push(f);
  }
  for (const a of anchors) {
    for (const f of sorted) {
      if (f.id === a.id || eaten.has(f.id) || f.symbol !== a.symbol || gap(f, a) > 36 * H) continue;
      const text = `${f.subject} ${f.headline}`;
      const sameEvent = f.category === 'results' || f.category === 'earnings_call' || f.subtype === 'Board meeting' || f.subtype === 'Investor meet' ||
        // a press release within hours of the numbers is the results release, whatever its title says
        (f.category === 'press_release' && f.subtype !== 'Rumour clarification' && (gap(f, a) < 12 * H || /result|quarter|Q[1-4]|earnings|financial|performance|H[12]\b/i.test(text))) ||
        (f.category === 'dividend' && gap(f, a) < 12 * H);
      if (sameEvent) eat(a, f);
    }
  }

  // 2. threads: newest filing of the thread stays, earlier ones fold behind it
  for (let i = sorted.length - 1; i >= 0; i--) {
    const f = sorted[i];
    if (eaten.has(f.id)) continue;
    const days = THREAD_DAYS[f.subtype];
    if (days) {
      for (let j = sorted.length - 1; j >= 0; j--) {
        const g = sorted[j];
        if (j === i || eaten.has(g.id) || g.symbol !== f.symbol || gap(f, g) > days * 24 * H) continue;
        // committee outcomes and the final allotment are steps of the same raise, before or after the headline filing
        const procedural = f.subtype === 'Equity raise' && (g.subtype === 'Committee meeting' || g.subtype === 'Share allotment' || g.subtype === 'Board meeting') && gap(f, g) < 21 * 24 * H;
        if ((g.subtype === f.subtype && j < i) || procedural) eat(f, g);
      }
    }
  }
  // filter at the end: a thread can absorb a filing that was filed after its anchor
  return sorted.filter((f) => !eaten.has(f.id)).sort((a, b) => b.at.localeCompare(a.at));
}

/** User routing: per category the investor can force Surface / Note / Bury, or leave it to FINN. */
export type Routing = Partial<Record<Category, Tier | 'auto'>>;
export function tierFor(f: Filing, routing: Routing): Tier {
  const r = routing[f.category];
  if (!r || r === 'auto') return f.tier;
  if (r === 'bury') return 'bury';
  if (f.noise) return 'bury';            // "surface results" must not surface the newspaper ad
  return r;
}
