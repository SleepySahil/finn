import { llmAvailable, resolveModels } from '@/lib/llm/router';
export const dynamic = 'force-dynamic';
export async function GET() {
  const llm = llmAvailable();
  return Response.json({ llm, models: llm ? await resolveModels() : null, gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), groq: Boolean(process.env.GROQ_API_KEY) });
}
