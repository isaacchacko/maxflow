export type Status = "todo" | "doing" | "review" | "done";

export type Event = { from: "isaac" | "agent" | "router" | "sentry"; at: string; text: string };

type Size = { w: number; h: number };

export type Block = Size & { id: string } & (
    | { kind: "status"; summary: string }
    | { kind: "note"; title: string; text: string }
    | { kind: "steps"; title: string; items: { text: string; done: boolean }[] }
    | { kind: "stat"; label: string; value: string; delta?: string; tone?: "good" | "bad" | "flat" }
    | { kind: "chart"; title: string; style: "line" | "bar"; unit?: string; points: number[] }
    | { kind: "activity" }
    | { kind: "pr"; checks: { name: string; state: "pass" | "fail" | "running" }[]; review: string }
    | { kind: "table"; title: string; columns: string[]; rows: string[][] }
    | { kind: "code"; title: string; text: string }
    | { kind: "question"; question: string; options: string[] }
    | { kind: "vision"; goal: string; doneWhen: string[] }
    | { kind: "tasks" }
    | { kind: "agents" }
  );

export type BlockKind = Block["kind"];

export type Task = {
  id: string;
  title: string;
  status: Status;
  board?: string;
  links?: string[];
  agent?: string;
  pr?: number;
  dependsOn: string[];
  start: string;
  end?: string;
  events: Event[];
  page: Block[];
};

export type Objective = { id: string; title: string; taskIds: string[]; events: Event[]; page: Block[] };
export type External = { source: "slack" | "github"; name: string; user?: string; link: string; where?: string; context?: boolean; own?: boolean };

export type Thread = {
  id: string;
  title: string;
  objectiveId: string;
  routerIds: string[];
  pending?: { routerIds: string[]; since: string; status?: string; stale: boolean };
  resolved?: { at: string } | undefined;
  pinned?: { at: string; order: number } | undefined;
  paused?: { until: string; at: string; said: string; posts: number; wake?: string | undefined } | undefined;
  resurfaced?: { at: string; from: number };
  feed?: { source: string; who: string; link: string };
  asks?: { sessionId: string; since: string; shown: boolean };
  movedTo?: { id: string; title: string; objectiveId: string; messageId: string; at: string };
  taskId?: string;
  parentId?: string;
  parentMessageId?: string;
  messages: { id?: string; from: string; at: string; text: string; nudge?: "subthread" | undefined; wake?: boolean; ext?: External }[];
};

export type AgentState = "working" | "waiting" | "idle" | "asleep";

export type Agent = {
  id: string;
  role: "router" | "worker";
  objectiveId: string;
  parent?: string;
  scope?: string;
  taskIds: string[];
  state: AgentState;
  since?: string;
  doing: string;
  name?: string;
  cwd?: string;
  links?: string[];
  wait?: Wait | null;
  browser?: boolean;
};
export type Wait = { kind: string; ref: string; at: number; desc?: string };
export type Shell = { id: string; desc: string; owner: string; kind: "cmd" | "pane" | "pid"; cmd?: string; cwd?: string; pid?: number; at: number; end?: { at: number; code: number | null; tail: string } };
export type Source = "isaac" | "gh" | "slack" | "agent" | "sentry" | "maxflow";

export type Signal = {
  id: string;
  source: Source;
  at: string;
  target: string;
  text: string;
  routedTo: string[];
  from?: string;
  route?: { at: string; to: string[]; objective?: string; kind?: string; routed?: boolean }[];
  thread?: string;
  who?: string;
  where?: string;
  link?: string;
  taskId?: string;
  context?: { who?: string; at: string; text: string; own?: boolean }[];
  own?: boolean;
  delivery?: Record<string, "queued" | "delivered" | "gone">;
};

export type Sentry = {
  id: Source;
  label: string;
  state: "polling" | "backoff" | "live";
  every?: string | undefined;
  lastPoll?: string;
  watching: { target: string; what: string; routedTo: string[] }[];
};

export const localAt = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
export const NOW_AT = localAt();
export const NOW = new Date(NOW_AT);

export const GRID_COLS = 12;
export const GRID_ROWS = 6;

export type SentrySession = { id: string; name: string; running: boolean; agent?: boolean; status: string; lastOutputAt: number; createdAt: number; ties: { session: string; label: string }[]; use: string };

export const columns: { status: Status; label: string }[] = [
  { status: "todo", label: "Todo" },
  { status: "doing", label: "Doing" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

export const agentStateColor: Record<AgentState, string> = {
  working: "bg-link",
  waiting: "bg-warn",
  idle: "bg-muted-foreground",
  asleep: "bg-muted-foreground/40",
};

export function objectiveStatus(statuses: Status[]): Status {
  if (statuses.includes("doing")) return "doing";
  if (statuses.includes("review")) return "review";
  if (statuses.every(s => s === "done")) return "done";
  return "todo";
}

export const statusColor: Record<Status, string> = {
  todo: "bg-muted-foreground",
  doing: "bg-link",
  review: "bg-warn",
  done: "bg-ok",
};
