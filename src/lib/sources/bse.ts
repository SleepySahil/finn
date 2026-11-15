import { getJson } from '../http';
import { bseTime, ymdIST } from '../util';
import { offline, offlineRows } from './offline';

const API = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
// The API answers only when it thinks bseindia.com's own page is calling.
const HEADERS = { Referer: 'https://www.bseindia.com/', Origin: 'https://www.bseindia.com', Accept: 'application/json, text/plain, */*' };

export interface BseRow {
  NEWSID: string; SCRIP_CD: number; NEWSSUB: string; HEADLINE: string; DT_TM: string; NEWS_DT: string;
  CATEGORYNAME: string | null; SUBCATNAME: string | null; ATTACHMENTNAME: string | null; SLONGNAME: string;
  Fld_Attachsize?: number | null; CRITICALNEWS?: string;
}
interface BseResp { Table?: BseRow[]; Table1?: { ROWCNT: number }[] }

export interface RawFiling {
  id: string; scrip: number; company: string; at: string; subject: string; headline: string;
  bseCat: string; bseSub: string; pdf?: string; pdfBytes?: number;
}

/** AttachHis serves both fresh and old attachments (AnnPdfOpen.aspx just redirects there). */
export const pdfUrl = (name: string) => `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${name}`;
export function directPdf(url: string): string {
  const m = url.match(/AnnPdfOpen\.aspx\?Pname=([\w-]+\.pdf)/i);
  return m ? pdfUrl(m[1]) : url;
}

export function normalise(r: BseRow): RawFiling {
  // Subjects arrive as "Company Ltd - 500325 - Actual subject" on the all-companies feed.
  const subject = (r.NEWSSUB || '').replace(/^.*? - \d{6} - /, '').replace(/\s+/g, ' ').trim();
  return {
    id: r.NEWSID,
    scrip: r.SCRIP_CD,
    company: (r.SLONGNAME || '').replace(/-\$$/, '').trim(),
    at: bseTime(r.DT_TM || r.NEWS_DT),
    subject,
    headline: (r.HEADLINE || '').replace(/\s+/g, ' ').trim(),
    bseCat: r.CATEGORYNAME || '',
    bseSub: (r.SUBCATNAME || '').replace(/\s+/g, ' ').trim(),
    pdf: r.ATTACHMENTNAME ? pdfUrl(r.ATTACHMENTNAME) : undefined,
    pdfBytes: r.Fld_Attachsize || undefined,
  };
}

/** Every announcement a company filed with BSE between two dates (inclusive). 50 rows per page. */
export async function getAnnouncements(scrip: number, from: Date, to: Date, revalidate = 600): Promise<RawFiling[]> {
  if (offline) return offlineRows(scrip).map(normalise).filter((f) => Date.parse(f.at) >= from.getTime() && Date.parse(f.at) <= to.getTime());
  const out: RawFiling[] = [];
  for (let page = 1; page <= 8; page++) {
    const url = `${API}?pageno=${page}&strCat=-1&strPrevDate=${ymdIST(from)}&strScrip=${scrip}&strSearch=P&strToDate=${ymdIST(to)}&strType=C&subcategory=-1`;
    const j = await getJson<BseResp>(url, { headers: HEADERS, revalidate, timeout: 10000 });
    const rows = j.Table || [];
    out.push(...rows.map(normalise));
    const total = j.Table1?.[0]?.ROWCNT ?? rows.length;
    if (rows.length < 50 || out.length >= total) break;
  }
  return out;
}
