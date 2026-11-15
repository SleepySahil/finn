import { facts } from '@/lib/service';
import { synthesise } from '@/lib/research/synth';
import { cacheSet } from '@/lib/cache';
import { Meter } from '@/lib/llm/router';
import { cleanSymbol, fail } from '@/lib/guard';
import type { ArNotes } from '@/lib/research/read';
import type { CallNotes } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Step 3: reconcile what was said with what was reported. One call on the stronger model. */
export async function POST(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const symbol = cleanSymbol((await ctx.params).symbol);
    const { notes, ar } = (await req.json()) as { notes: CallNotes[]; ar?: ArNotes };
    const dossier = await synthesise(await facts(symbol), (notes || []).slice(0, 6), ar, new Meter());
    if (dossier.depth === 'full') await cacheSet(`dossier:${symbol}`, dossier, 7 * 86400);
    return Response.json({ dossier });
  } catch (e) {
    return fail(e);
  }
}
