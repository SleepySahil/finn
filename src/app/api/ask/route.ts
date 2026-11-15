import { PORTFOLIO, savedDossier, search } from '@/lib/service';
import { askCompany, type FullDossier } from '@/lib/research/synth';
import { llmAvailable, Meter } from '@/lib/llm/router';
import { fail } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Work out which company a free-text question is about: explicit context, then a ticker or name in the text. */
async function resolve(question: string, hint?: string): Promise<string | undefined> {
  if (hint) return hint.toUpperCase();
  const q = question.toLowerCase();
  const own = PORTFOLIO.find((h) => new RegExp(`\\b${h.symbol.toLowerCase()}\\b`).test(q) || q.includes(h.name.toLowerCase().split(' ')[0]));
  if (own) return own.symbol;
  const caps = question.match(/\b[A-Z][A-Za-z&]{2,}\b/g) || [];
  for (const w of caps.slice(0, 3)) {
    const hits = await search(w);
    if (hits[0]) return hits[0].symbol;
  }
  return undefined;
}

export async function POST(req: Request) {
  try {
    const { question, symbol, dossier } = (await req.json()) as { question: string; symbol?: string; dossier?: FullDossier };
    const q = String(question || '').trim().slice(0, 400);
    if (!q) return fail('Ask a question', 400);
    const sym = await resolve(q, symbol);
    if (!sym) return Response.json({ needs: 'company', answer: 'Which company? Name it or type its NSE ticker.' });
    // Serverless instances do not share a disk, so the phone sends back the dossier it already holds.
    const d = dossier && dossier.symbol === sym && dossier.depth === 'full' ? dossier : await savedDossier(sym);
    if (!d || d.depth !== 'full') return Response.json({ needs: 'research', symbol: sym, answer: `FINN has not read ${sym}'s calls yet. Open it in Research first — it takes about a minute.` });
    if (!llmAvailable()) return Response.json({ needs: 'key', symbol: sym, answer: 'No model key is configured on this deployment, so FINN can show saved research but cannot answer new questions.' });
    const meter = new Meter();
    const a = await askCompany(q, d, meter);
    return Response.json({ ...a, symbol: sym, name: d.name, cost: meter.cost() });
  } catch (e) {
    return fail(e);
  }
}
