import { reloadResource } from "@/lib/effects";

export type Channel = { path: string; messages?: number; threads?: number; lastIndex?: number };
type Author = { kind?: string; handle?: string; name?: string; via?: { name?: string } | null };
export type BoardMessage = { id: string; channel: string; text: string; re: string | null; createdAt: string; deleted?: boolean; author?: Author; by?: { actor?: string } };
export type ThreadSummary = { message: BoardMessage; replies?: number; latest?: BoardMessage | null };
export type Vouched = Record<string, string>;
export type Threads = { threads: ThreadSummary[]; yarn: Vouched };
export type Thread = { message: BoardMessage; replies: BoardMessage[]; yarn: Vouched };

export const CHANNELS_KEY = "board:channels";
export const threadsKey = (channel: string, q: string) => `board:threads:${channel}:${q}`;
export const threadKey = (id: string) => `board:thread:${id}`;
const shown = { threads: "", thread: "" };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export const loadChannels = async () => json<{ channels: Channel[] }>("/api/board/channels");
export const loadThreads = async (channel: string, q: string) => json<Threads>(`/api/board/threads?${new URLSearchParams({ channel, q }).toString()}`);
export const loadThread = async (id: string) => json<Thread>(`/api/board/thread?id=${encodeURIComponent(id)}`);
export const postAsHim = async (body: { channel: string; re?: string; text: string }) =>
  json<{ id: string }>("/api/board/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function showing(what: { threads?: string; thread?: string }) {
  shown.threads = what.threads ?? "";
  shown.thread = what.thread ?? "";
}

export function boardChanged() {
  void reloadResource(CHANNELS_KEY);
  if (shown.threads !== "") void reloadResource(shown.threads);
  if (shown.thread !== "") void reloadResource(threadKey(shown.thread));
}
