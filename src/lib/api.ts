export type Session = {
  id: string;
  name: string;
  cmd: string[];
  cwd: string;
  createdAt: number;
  lastOutputAt: number;
  activeAt: number;
  clients: number;
  running: boolean;
  exitCode: number | null;
  chatId?: string;
  pending: number;
  status: "working" | "waiting" | "idle" | "exited";
  agent: boolean;
  links: string[];
  archivedLinks: string[];
  prs: Record<string, "open" | "closed" | "merged">;
  group: string | null;
  role: "review" | "implement" | "conflicts" | null;
  archived: boolean;
  sentry: boolean;
  // Edges a sentry draws itself, to the sessions it ties to.
  ties: { session: string; label: string }[];
};

// sentry:review's board of the PRs that need the user, and the queue of every open PR with its stage.
export type ReviewBoard = { updated: string; next: string; sections: { title: string; items: { pr: string; url: string; note: string }[] }[] };
export type QueuedPr = { pr: string; url: string; title: string; stage: string; created: string; updated: string; sessions: { id: string; name: string }[] };

// A question an agent raised for the user, as the server keeps it; sentry:questions gates it before it is pending.
export type Question = {
  id: number;
  session: string;
  name: string;
  status: "gating" | "pending" | "answered" | "bounced" | "dismissed";
  at: number;
  thread: { from: "agent" | "user" | "sentry"; text: string; at: number }[];
};

export type Chat = { id: string; title: string; prompt: string; cwd: string; mtime: number; live: boolean; session: string | null };

export const isSentry = (s: Session) => s.sentry;
export const displayName = (s: Session) => (isSentry(s) ? s.name.replace(/^sentry:/, "") : s.name);
export const isBusy = (s: Session) => s.status === "working";
export const isWaiting = (s: Session) => s.status === "waiting";
export const kindOf = (s: Session) => (isSentry(s) ? "sentry" : s.agent ? "Claude chat" : "shell");

export const ago = (t: number) => {
  const m = (Date.now() - t) / 60000;
  return m < 1 ? "now" : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
export const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
// Marks keep a path left-to-right inside the rtl boxes that truncate it from the left.
export const ltr = (t: string) => `‎${t}‎`;

export const api = {
  sessions: (): Promise<Session[]> => fetch("/api/sessions").then((r) => r.json()),
  create: (name: string): Promise<Session> => fetch("/api/sessions", { method: "POST", body: JSON.stringify({ name }) }).then((r) => r.json()),
  agent: (prompt: string, cwd: string, bypass: boolean, name = prompt): Promise<Session> =>
    fetch("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name: name.slice(0, 40) || "claude", cwd, cmd: ["claude", ...(bypass ? ["--permission-mode", "bypassPermissions"] : []), ...(prompt ? [prompt] : [])] }),
    }).then((r) => r.json()),
  notify: (id: string, text: string) => fetch(`/api/sessions/${id}/notify`, { method: "POST", body: JSON.stringify({ text }) }),
  link: (a: string, b: string, why?: string) => fetch("/api/link", { method: "POST", body: JSON.stringify({ a, b, why }) }),
  kill: (id: string) => fetch(`/api/sessions/${id}`, { method: "DELETE" }),
  archive: (id: string, archived: boolean) => fetch(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ archived }) }),
  archiveLinks: (urls: string[], archived: boolean) => fetch("/api/links", { method: "PATCH", body: JSON.stringify({ urls, archived }) }),
  rename: (id: string, name: string) => fetch(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  chats: (q: string, limit = 150): Promise<Chat[]> => fetch(`/api/chats?limit=${limit}&q=${encodeURIComponent(q)}`).then((r) => r.json()),
  review: (): Promise<{ board: ReviewBoard | null; queue: QueuedPr[] }> => fetch("/api/review").then((r) => r.json()),
  questions: (): Promise<Question[]> => fetch("/api/questions").then((r) => r.json()),
  settle: (id: number, action: "reply" | "dismiss", text?: string) => fetch(`/api/questions/${id}`, { method: "POST", body: JSON.stringify({ action, text }) }),
  resume: (id: string, bypass: boolean, force: boolean) => fetch(`/api/chats/${id}/resume`, { method: "POST", body: JSON.stringify({ bypass, force }) }),
};

export const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};
