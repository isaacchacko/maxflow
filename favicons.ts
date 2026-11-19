// constraint: served from this origin so the graph's canvas can read their pixels (cross-origin images taint it) and plate the dark ones
export const favicons = new Map<string, Promise<Response | null>>();

async function fetchedOrUndefined(src: string): Promise<Response | undefined> {
  try {
    return await fetch(src, { signal: AbortSignal.timeout(5000) });
  } catch {
    return undefined;
  }
}

export async function fetchFavicon(host: string) {
  const own = `${/^localhost(:|$)/.test(host) ? "http" : "https"}://${host}/favicon.ico`;
  for (const src of [own, `https://www.google.com/s2/favicons?domain=${host}&sz=64`]) {
    const res = await fetchedOrUndefined(src);
    const type = res?.ok === true ? res.headers.get("content-type") : null;
    if (res !== undefined && type?.startsWith("image/") === true) return new Response(await res.arrayBuffer(), { headers: { "content-type": type, "cache-control": "max-age=86400" } });
  }
  return null;
}
