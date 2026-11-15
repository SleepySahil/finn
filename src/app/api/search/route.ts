import { search } from '@/lib/service';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') || '').trim().slice(0, 40);
  return Response.json({ hits: q.length < 2 ? [] : await search(q) });
}
