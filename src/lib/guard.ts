/** Routes fetch PDFs by URL on the caller's say-so; only plain public https hosts are allowed. */
export function safeUrl(u: unknown): string {
  if (typeof u !== 'string') throw new Error('Missing document URL');
  const url = new URL(u);
  const h = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.') || /\.(local|internal)$/.test(h))
    throw new Error('Document URL not allowed');
  return url.toString();
}
export const cleanSymbol = (s: string) => {
  const x = decodeURIComponent(s).toUpperCase().trim();
  if (!/^[A-Z0-9&\-]{1,20}$/.test(x)) throw new Error('That does not look like an NSE ticker');
  return x;
};
export const fail = (e: unknown, status = 502) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
