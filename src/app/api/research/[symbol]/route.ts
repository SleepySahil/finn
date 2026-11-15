import { facts, savedDossier } from '@/lib/service';
import { llmAvailable, ZERO } from '@/lib/llm/router';
import { cleanSymbol, fail } from '@/lib/guard';
import type { FullDossier } from '@/lib/research/synth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Step 1 of on-demand research, for ANY NSE ticker. Returns a finished dossier if one is saved;
 * otherwise the numbers (no model needed) plus the list of documents the client should ask
 * FINN to read next. The client drives the reading one document per request, so nothing here
 * can outlive a serverless timeout and the investor watches real progress.
 */
export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const symbol = cleanSymbol((await ctx.params).symbol);
    const fresh = new URL(req.url).searchParams.get('fresh') === '1';
    const saved = fresh ? undefined : await savedDossier(symbol);
    if (saved && (saved.depth === 'full' || !llmAvailable())) return Response.json({ dossier: saved, llm: llmAvailable(), saved: true });
    let f;
    try {
      f = await facts(symbol);
    } catch (e) {
      // upstream unreachable: a saved numbers-only dossier still beats an error
      if (saved) return Response.json({ dossier: saved, llm: llmAvailable(), saved: true, stale: (e as Error).message });
      throw e;
    }
    const dossier: FullDossier = {
      symbol: f.symbol, name: f.name, facts: f, notes: [], ledger: [], sayDo: { delivered: 0, missed: 0, partly: 0, open: 0 },
      divergences: [], guidanceNow: [], bull: [], bear: [], cost: ZERO, builtAt: new Date().toISOString(), depth: 'numbers',
    };
    return Response.json({ dossier, llm: llmAvailable(), saved: false, toRead: { calls: f.docs.concalls.slice(0, 5), annualReport: f.docs.annualReports[0] || null } });
  } catch (e) {
    return fail(e, /NSE ticker|404/.test(String(e)) ? 404 : 502);
  }
}
