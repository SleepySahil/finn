import { enrichFiling } from '@/lib/brain/enrich';
import { PORTFOLIO } from '@/lib/service';
import { fail, safeUrl } from '@/lib/guard';
import type { Filing } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Read one filing on demand. FINN does not spend tokens on a filing until someone looks at it. */
export async function POST(req: Request) {
  try {
    const { filing } = (await req.json()) as { filing: Filing };
    if (!filing?.id || !filing.symbol) return fail('Missing filing', 400);
    if (filing.pdf) filing.pdf = safeUrl(filing.pdf);
    const h = PORTFOLIO.find((x) => x.symbol === filing.symbol);
    return Response.json({ enrichment: await enrichFiling(filing, h) });
  } catch (e) {
    return fail(e);
  }
}
