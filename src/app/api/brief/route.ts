import { buildBrief } from '@/lib/service';
import { fail } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const days = Math.min(60, Math.max(1, Number(new URL(req.url).searchParams.get('days')) || 30));
  try {
    return Response.json(await buildBrief(days, true));
  } catch (e) {
    try { return Response.json(await buildBrief(days, false)); } catch { return fail(e); }
  }
}
