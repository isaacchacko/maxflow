// Only pages served from this server may drive it; blocks other sites from reaching localhost.
// Favicons are served from this origin so the graph can read their pixels and plate the dark ones.
export const favicons = new Map<string, Promise<Response | null>>();
export async function fetchFavicon(host: string) {
  const own = `${/^localhost(:|$)/.test(host) ? "http" : "https"}://${host}/favicon.ico`;
  for (const src of [own, `https://www.google.com/s2/favicons?domain=${host}&sz=64`]) {
    const res = await fetch(src, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (res?.ok && res.headers.get("content-type")?.startsWith("image/")) return new Response(await res.arrayBuffer(), { headers: { "content-type": res.headers.get("content-type")!, "cache-control": "max-age=86400" } });
  }
  return null;
}
