import { reloadResource } from "@/lib/effects";

export type Timeline = { path: string; events: number; latest?: string; now?: string };
export type Index = { dir: string; timelines: Timeline[] };
export type TimelineEvent = { file: string; at: string | null; title: string; author: string | null; text: string };
export type Events = { path: string; now: string | null; events: TimelineEvent[] };
export type Hit = { file: string; line: string };

export const INDEX_KEY = "timelines";
export const eventsKey = (path: string) => `timeline:${path}`;
const shown = { path: "" };

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export const loadIndex = async () => json<Index>("/api/timelines");
export const loadEvents = async (path: string) => json<Events>(`/api/timelines/events?path=${encodeURIComponent(path)}`);
export const findEvents = async (q: string) => json<Hit[]>(`/api/timelines/find?q=${encodeURIComponent(q)}`);

export function showing(path: string) {
  shown.path = path;
}

export function timelinesChanged() {
  void reloadResource(INDEX_KEY);
  if (shown.path !== "") void reloadResource(eventsKey(shown.path));
}
