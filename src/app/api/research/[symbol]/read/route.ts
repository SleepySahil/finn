import { readAnnualReport, readCall } from '@/lib/research/read';
import { Meter } from '@/lib/llm/router';
import { cleanSymbol, fail, safeUrl } from '@/lib/guard';
import type { DocLink } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Step 2: read exactly one primary document (a concall transcript or the annual report) and return notes. */
export async function POST(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    cleanSymbol((await ctx.params).symbol);
    const { doc, kind, company } = (await req.json()) as { doc: DocLink; kind: 'call' | 'ar'; company: string };
    const d = { ...doc, url: safeUrl(doc?.url) };
    const meter = new Meter();
    const name = String(company || '').slice(0, 80);
    return Response.json(kind === 'ar' ? { ar: await readAnnualReport(d, name, meter) } : { notes: await readCall(d, name, meter) });
  } catch (e) {
    return fail(e);
  }
}
