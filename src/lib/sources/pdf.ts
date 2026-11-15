import { getBytes } from '../http';
import { cached } from '../cache';

export interface PdfText { pages: string[]; total: number; scanned: boolean; bytes: number }

/**
 * Filing PDF → text, per page, locally. Zero tokens. Page boundaries are kept so every later
 * claim can cite "p.7" and deep-link to #page=7. Cached forever: a filed PDF never changes.
 */
export async function pdfText(url: string, maxBytes = 45_000_000): Promise<PdfText> {
  const { v } = await cached<PdfText>(`pdf:${url}`, 365 * 86400, async () => {
    let bytes: Uint8Array;
    try {
      bytes = await getBytes(url, { maxBytes, headers: { Referer: 'https://www.bseindia.com/' } });
    } catch (e) {
      if (!/AttachHis/.test(url)) throw e;
      bytes = await getBytes(url.replace('AttachHis', 'AttachLive'), { maxBytes, headers: { Referer: 'https://www.bseindia.com/' } });
    }
    if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('Exchange returned something that is not a PDF');
    const { extractText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(bytes);
    const r = await extractText(doc, { mergePages: false });
    const pages = (r.text as string[]).map((p) => p.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
    const chars = pages.reduce((a, p) => a + p.length, 0);
    // Signed, stamped, scanned results are common in India: a PDF with pages but almost no text.
    return { pages, total: r.totalPages, scanned: chars / Math.max(1, r.totalPages) < 150, bytes: bytes.length };
  });
  return v;
}

/** Pages joined with markers the model is told to cite. Hard character budget, never mid-page. */
export function withPageMarks(pages: string[], from = 0, budget = 120_000): string {
  let out = '';
  for (let i = from; i < pages.length; i++) {
    const block = `\n=== PAGE ${i + 1} ===\n${pages[i]}\n`;
    if (out.length + block.length > budget) break;
    out += block;
  }
  return out;
}

/**
 * Local page ranking for long documents (annual reports run 300+ pages). Score each page
 * against weighted terms, keep the best N in reading order. This is the whole "RAG":
 * no embeddings, no vector store — an annual report has headings, so keyword scoring finds
 * the MD&A and the notes cheaper and more predictably than a similarity search would.
 */
export function topPages(pages: string[], terms: Record<string, number>, n = 12): number[] {
  const scored = pages.map((p, i) => {
    const low = p.toLowerCase();
    let s = 0;
    for (const [t, w] of Object.entries(terms)) {
      const hits = low.split(t).length - 1;
      if (hits) s += w * Math.min(hits, 4);
    }
    return { i, s: s / Math.sqrt(Math.max(400, p.length) / 400) };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.i).sort((a, b) => a - b);
}
