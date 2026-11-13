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
  // What the agent declared it waits on; it sleeps (archived) until a message wakes it.
  wait: { kind: "q" | "approval" | "ci" | "agent" | "slack" | "done"; ref: string; at: number } | null;
  // Messages that have waited 2+ minutes behind a draft the user left in its prompt; the server clears the draft after 5 unchanged.
  blocked: { count: number; since: number } | null;
};
export const blockedLabel = (b: NonNullable<Session["blocked"]>) => `${b.count} message${b.count === 1 ? "" : "s"} waiting behind your draft`;

// sentry:review's board of the PRs that need the user, and the queue of every open PR with its stage.
// request: the paste-ready review-request message the user sends teammates himself.
export type ReviewBoard = { updated: string; next: string; request?: string; sections: { title: string; items: { pr: string; url: string; note: string }[] }[] };
export type QueuedPr = { pr: string; url: string; title: string; stage: string; created: string; updated: string; sessions: { id: string; name: string }[] };

// A question an agent raised for the user, as the server keeps it; sentry:questions gates it before it is pending.
export type Question = {
  id: number;
  session: string;
  name: string;
  status: "gating" | "pending" | "answered" | "bounced" | "dismissed" | "defaulted";
  at: number;
  thread: { from: "agent" | "user" | "sentry"; text: string; at: number }[];
  // The agent's recommendation for a reversible step, which it goes ahead with if he hasn't answered in time.
  default?: string;
};

// A task on the user's board, which sentry:assistant derives from his prompts and moves as agents work.
// The main pane shows exactly one of these.
export type View = "agent" | "graph" | "tasks";

export type Task = {
  id: number;
  title: string;
  kind: "task" | "question";
  status: "todo" | "doing" | "you" | "waiting" | "blocked" | "done" | "dropped";
  answer?: string;
  sessions: string[];
  links: string[];
  at: number;
  updated: number;
  timeline: { at: number; text: string; session?: string }[];
  // Its linked PRs whose state is known: how many merged, closed unmerged, and in all.
  prs: { merged: number; closed: number; total: number };
  change?: { at: number; from: Task["status"] | null; to: Task["status"] };
  seen?: number;
};

// One of the user's own PR comments not yet resolved: a review thread still open, or a top-level comment nobody answered yet.
export type OpenComment = { id: string; pr: string; kind: "comment" | "thread"; url: string; body: string; path?: string; at: number; title: string; replies: number };

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
  // The health sentry answers in the server's place while it's down; reloading shows its down page.
  sessions: (): Promise<Session[]> =>
    fetch("/api/sessions").then((r) => (r.headers.has("x-maxflow-down") ? (location.reload(), new Promise<never>(() => {})) : r.json())),
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
  comments: (): Promise<OpenComment[]> => fetch("/api/comments").then((r) => r.json()),
  tasks: (): Promise<Task[]> => fetch("/api/tasks").then((r) => r.json()),
  seen: (ids?: number[]) => fetch("/api/tasks/seen", { method: "POST", body: JSON.stringify({ ids }) }),
  settle: (id: number, action: "reply" | "dismiss", text?: string) => fetch(`/api/questions/${id}`, { method: "POST", body: JSON.stringify({ action, text }) }),
  resume: (id: string, bypass: boolean, force: boolean) => fetch(`/api/chats/${id}/resume`, { method: "POST", body: JSON.stringify({ bypass, force }) }),
};

export const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};
