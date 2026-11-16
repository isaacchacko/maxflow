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
  agent?: string;
  pr?: number;
  dependsOn: string[];
  start: string;
  end?: string;
  events: Event[];
  page: Block[];
};

export type Objective = { id: string; title: string; taskIds: string[]; events: Event[]; page: Block[] };

/**
 * A virtual chat routers (and their objective) post into. Message text is prose with inline references:
 * [[agent:id]], [[router:id]], [[task:id]], [[objective:id]], and [label](https://url) for external links.
 */
export type Thread = {
  id: string;
  title: string;
  objectiveId: string;
  routerIds: string[];
  messages: { from: string; at: string; text: string }[];
};

export type AgentState = "working" | "waiting" | "idle" | "asleep";

export type Agent = {
  id: string;
  role: "router" | "worker";
  objectiveId: string;
  parent?: string;
  /** Routers only: the part of the objective this router owns. */
  scope?: string;
  taskIds: string[];
  state: AgentState;
  doing: string;
  /** Live agents only: the session's title, folder, the links it surfaced and what it sleeps on. */
  name?: string;
  cwd?: string;
  links?: string[];
  wait?: { kind: string; ref: string; at: number } | null;
};

/** Where a signal came from: Isaac, a GitHub or Slack sentry, another agent, another sentry, or maxflow itself. */
export type Source = "isaac" | "gh" | "slack" | "agent" | "sentry" | "maxflow";

export type Signal = { id: string; source: Source; at: string; target: string; text: string; routedTo: string[]; from?: string };

export type Sentry = {
  id: Source;
  label: string;
  state: "polling" | "backoff" | "live";
  every?: string;
  lastPoll?: string;
  watching: { target: string; what: string; routedTo: string[] }[];
};

/** Local wall-clock time as the data writes it, "YYYY-MM-DDTHH:MM". */
export const localAt = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
export const NOW_AT = localAt();
export const NOW = new Date(NOW_AT);

export const GRID_COLS = 12;
export const GRID_ROWS = 6;

export const tasks: Task[] = [
  {
    id: "t1",
    title: "Festo gateway keyset pagination",
    status: "review",
    agent: "mf-1",
    pr: 6250,
    dependsOn: [],
    start: "2026-11-10T09:00",
    events: [
      { from: "isaac", at: "09:12", text: "$skip+$top is quadratic on the big tenants. Swap it for keyset." },
      { from: "agent", at: "09:40", text: "Count-gated hybrid in: $skip under 5k rows, keyset above." },
      { from: "sentry", at: "10:02", text: "CI green on #6250." },
    ],
    page: [
      { id: "b1", kind: "status", w: 4, h: 2, summary: "Hybrid pager is in review. Keyset above 5k rows, $skip below, sweep time down 81% on prod-shaped data." },
      { id: "b2", kind: "stat", w: 2, h: 2, label: "Full sweep", value: "6m 40s", delta: "-81%", tone: "good" },
      { id: "b3", kind: "stat", w: 2, h: 2, label: "Requests / sweep", value: "212", delta: "same", tone: "flat" },
      { id: "b4", kind: "pr", w: 4, h: 2, review: "Waiting on approval", checks: [
        { name: "backend-tests", state: "pass" }, { name: "lint", state: "pass" }, { name: "e2e", state: "pass" },
      ] },
      { id: "b5", kind: "chart", w: 8, h: 2, title: "Sweep time per tick", style: "line", unit: "min", points: [34, 35, 33, 36, 34, 35, 12, 7.2, 6.8, 6.7, 6.6, 6.7] },
      { id: "b6", kind: "steps", w: 4, h: 2, title: "Plan", items: [
        { text: "Measure $skip cost per page", done: true },
        { text: "Count-gate the pager", done: true },
        { text: "Keyset above threshold", done: true },
        { text: "Merge, then backfill intake", done: false },
      ] },
      { id: "b7", kind: "activity", w: 6, h: 2 },
      { id: "b8", kind: "code", w: 6, h: 2, title: "Last tick", text: "tick 4812  rows=48,211  pages=212\nmode=keyset  key=MaterialNumber\nelapsed=6m40s  p95_page=1.8s\nok" },
    ],
  },
  {
    id: "t2",
    title: "Backfill exception intake after pagination lands",
    status: "todo",
    dependsOn: ["t1"],
    start: "2026-11-15T09:15",
    events: [{ from: "isaac", at: "09:15", text: "Once #6250 merges, re-run intake for the last 30 days." }],
    page: [
      { id: "b1", kind: "status", w: 6, h: 2, summary: "Blocked on #6250. Re-runs intake for the last 30 days once the pager merges." },
      { id: "b2", kind: "activity", w: 6, h: 2 },
    ],
  },
  {
    id: "t3",
    title: "Overdue cases never close on cleared",
    status: "doing",
    agent: "mf-2",
    dependsOn: [],
    start: "2026-11-13T08:50",
    events: [
      { from: "isaac", at: "08:50", text: "Why do overdue cases stay open after SAP clears them?" },
      { from: "agent", at: "09:30", text: "full_snapshot is false for Festo, so the close path never sees 'cleared'." },
    ],
    page: [
      { id: "b1", kind: "status", w: 4, h: 2, summary: "Root cause found: Festo runs are partial, so 'cleared' never reaches the close path. Need a call on the fix." },
      { id: "b2", kind: "question", w: 4, h: 2, question: "Flipping full_snapshot would falsely close ~45% of open cases. Build a reconciler instead?", options: ["Build reconciler", "Flip the flag", "Talk first"] },
      { id: "b3", kind: "stat", w: 4, h: 2, label: "Overdue cases stuck open", value: "1,284", delta: "+37 today", tone: "bad" },
      { id: "b4", kind: "table", w: 8, h: 2, title: "Recent runs", columns: ["Run", "full_snapshot", "Rows", "Closed"], rows: [
        ["r-9921", "false", "48,211", "0"], ["r-9918", "false", "47,930", "0"], ["r-9902", "false", "48,004", "0"],
      ] },
      { id: "b5", kind: "chart", w: 4, h: 2, title: "Stuck cases by day", style: "bar", points: [1102, 1131, 1160, 1189, 1220, 1247, 1284] },
      { id: "b6", kind: "activity", w: 6, h: 2 },
      { id: "b7", kind: "code", w: 6, h: 2, title: "Close path", text: "if run.full_snapshot and case.key not in run.keys:\n    close(case, reason=\"cleared\")\n# Festo: full_snapshot is always false" },
    ],
  },
  {
    id: "t4",
    title: "Close-path reconciler",
    status: "todo",
    dependsOn: ["t3"],
    start: "2026-11-15T10:00",
    events: [],
    page: [{ id: "b1", kind: "status", w: 6, h: 2, summary: "Waiting on the decision in the overdue-cases task." }],
  },
  {
    id: "t5",
    title: "Kanban card shows linked PR state",
    status: "done",
    agent: "mf-3",
    pr: 42,
    dependsOn: [],
    start: "2026-11-11T11:00",
    end: "2026-11-14T16:00",
    events: [{ from: "agent", at: "Yesterday", text: "Merged. Card badge reads open / draft / merged from the gh sentry." }],
    page: [
      { id: "b1", kind: "status", w: 6, h: 2, summary: "Merged. Cards show open, draft or merged from the gh sentry." },
      { id: "b2", kind: "pr", w: 6, h: 2, review: "Approved and merged", checks: [{ name: "ci", state: "pass" }] },
      { id: "b3", kind: "activity", w: 12, h: 2 },
    ],
  },
  {
    id: "t6",
    title: "Review #7149 for style",
    status: "doing",
    agent: "mf-4",
    pr: 7149,
    dependsOn: [],
    start: "2026-11-14T15:00",
    events: [{ from: "agent", at: "10:20", text: "Style commit pushed. Two judgment calls drafted as review comments." }],
    page: [
      { id: "b1", kind: "status", w: 4, h: 2, summary: "Style commit pushed. Two judgment calls are drafted and need your OK before the review goes out." },
      { id: "b2", kind: "pr", w: 4, h: 2, review: "Review drafted, not submitted", checks: [{ name: "ci", state: "running" }, { name: "lint", state: "pass" }] },
      { id: "b3", kind: "steps", w: 4, h: 2, title: "Review", items: [
        { text: "Cut comments", done: true }, { text: "Rename toward intent", done: true }, { text: "Submit review", done: false },
      ] },
      { id: "b4", kind: "activity", w: 12, h: 2 },
    ],
  },
  {
    id: "t7",
    title: "Measure $skip cost per page",
    status: "done",
    agent: "mf-1",
    dependsOn: [],
    start: "2026-11-03T10:00",
    end: "2026-11-06T17:00",
    events: [{ from: "agent", at: "Nov 6", text: "Page cost grows linearly with $skip: 0.2s at page 1, 9.8s at page 200." }],
    page: [
      { id: "b1", kind: "status", w: 6, h: 2, summary: "Measured: each page re-reads every row before it, so a full sweep is quadratic." },
      { id: "b2", kind: "chart", w: 6, h: 2, title: "Seconds per page by page number", style: "line", unit: "s", points: [0.2, 1.1, 2.3, 3.6, 4.8, 6.1, 7.4, 8.6, 9.8] },
      { id: "b3", kind: "activity", w: 12, h: 2 },
    ],
  },
  {
    id: "t8",
    title: "Review #7102 for style",
    status: "done",
    agent: "mf-4",
    pr: 7102,
    dependsOn: [],
    start: "2026-11-05T13:00",
    end: "2026-11-07T11:00",
    events: [{ from: "agent", at: "Nov 7", text: "Approved with two nits." }],
    page: [{ id: "b1", kind: "status", w: 6, h: 2, summary: "Approved with two nits after one style commit." }, { id: "b2", kind: "activity", w: 6, h: 2 }],
  },
  {
    id: "t9",
    title: "Trace why overdue cases pile up",
    status: "done",
    agent: "mf-2",
    dependsOn: [],
    start: "2026-11-08T09:00",
    end: "2026-11-12T18:00",
    events: [{ from: "agent", at: "Nov 12", text: "Cases close only on full snapshots. Handed off to the closing fix." }],
    page: [{ id: "b1", kind: "status", w: 6, h: 2, summary: "Overdue cases only close on full-snapshot runs, and Festo never sends one." }, { id: "b2", kind: "activity", w: 6, h: 2 }],
  },
];

export const objectives: Objective[] = [
  {
    id: "festo-perf",
    title: "Festo gateway performance",
    taskIds: ["t7", "t1", "t2"],
    events: [
      { from: "isaac", at: "Nov 3", text: "Get Festo sweeps under the prod tick, then backfill what we missed." },
      { from: "router", at: "Nov 3", text: "Split into measure, pager, backfill. Backfill waits on the pager." },
      { from: "router", at: "Nov 10", text: "Measurement done: $skip is quadratic. Started mf-1 on the keyset pager." },
      { from: "sentry", at: "10:02", text: "CI green on #6250." },
    ],
    page: [
      { id: "v", kind: "vision", w: 8, h: 2, goal: "Festo's full sweep finishes well inside the 12-minute prod tick, and intake catches up on the 30 days it missed.", doneWhen: [
        "A full sweep takes under 12 minutes at full tenant size",
        "No request pages with $skip above 5k rows",
        "Intake backfilled for Oct 16 to Nov 15",
      ] },
      { id: "s1", kind: "stat", w: 2, h: 2, label: "Tasks done", value: "1 / 3", tone: "flat" },
      { id: "s2", kind: "stat", w: 2, h: 2, label: "Sweep time", value: "6m 40s", delta: "was 34m", tone: "good" },
      { id: "t", kind: "tasks", w: 6, h: 2 },
      { id: "a", kind: "agents", w: 6, h: 2 },
      { id: "c", kind: "chart", w: 6, h: 2, title: "Sweep time per tick", style: "line", unit: "min", points: [34, 35, 33, 36, 34, 35, 12, 7.2, 6.8, 6.7, 6.6, 6.7] },
      { id: "e", kind: "activity", w: 6, h: 2 },
    ],
  },
  {
    id: "overdue",
    title: "Overdue cases never close",
    taskIds: ["t9", "t3", "t4"],
    events: [
      { from: "isaac", at: "Nov 8", text: "Overdue cases keep piling up. Find out why and stop it." },
      { from: "router", at: "Nov 12", text: "Cause: Festo never sends full snapshots. Fix needs a decision." },
      { from: "router", at: "09:30", text: "Asked Isaac: reconciler or flip the flag." },
    ],
    page: [
      { id: "v", kind: "vision", w: 8, h: 2, goal: "Overdue cases close on their own once SAP clears them, without falsely closing the ones still open.", doneWhen: [
        "Cleared cases close within one tick",
        "Zero false closes on a full replay of last week",
        "The 1,284 stuck cases are closed or explained",
      ] },
      { id: "s1", kind: "stat", w: 4, h: 2, label: "Stuck open", value: "1,284", delta: "+37 today", tone: "bad" },
      { id: "t", kind: "tasks", w: 6, h: 2 },
      { id: "a", kind: "agents", w: 6, h: 2 },
      { id: "q", kind: "question", w: 6, h: 2, question: "Should the reconciler also cover postponed cases, or only overdue ones for now?", options: ["Overdue only", "Both"] },
      { id: "e", kind: "activity", w: 6, h: 2 },
    ],
  },
  {
    id: "board",
    title: "maxflow board",
    taskIds: ["t5"],
    events: [{ from: "router", at: "Nov 14", text: "PR state on cards shipped. Nothing else queued." }],
    page: [
      { id: "v", kind: "vision", w: 12, h: 2, goal: "The board tells Isaac what needs him at a glance, without opening a terminal.", doneWhen: ["Every card shows its PR state", "Cards that need a decision stand out"] },
      { id: "t", kind: "tasks", w: 6, h: 2 },
      { id: "a", kind: "agents", w: 6, h: 2 },
      { id: "e", kind: "activity", w: 12, h: 2 },
    ],
  },
  {
    id: "reviews",
    title: "Style reviews",
    taskIds: ["t8", "t6"],
    events: [
      { from: "sentry", at: "Nov 14", text: "New #reviews-pls ping names Isaac on #7149." },
      { from: "router", at: "Nov 14", text: "Started mf-4 on #7149." },
    ],
    page: [
      { id: "v", kind: "vision", w: 12, h: 2, goal: "Every review request that names Isaac gets a style pass and a verdict within the day.", doneWhen: ["No #reviews-pls ping older than a day", "Judgment calls reach Isaac as drafted comments"] },
      { id: "t", kind: "tasks", w: 6, h: 2 },
      { id: "a", kind: "agents", w: 6, h: 2 },
      { id: "e", kind: "activity", w: 12, h: 2 },
    ],
  },
];

export const agents: Agent[] = [
  { id: "r-festo", role: "router", scope: "Whole objective", objectiveId: "festo-perf", taskIds: [], state: "waiting", doing: "Holding the backfill until #6250 merges" },
  { id: "mf-1", role: "worker", objectiveId: "festo-perf", parent: "r-festo", taskIds: ["t7", "t1"], state: "waiting", doing: "#6250 waiting on approval" },
  { id: "r-overdue", role: "router", scope: "Close-path fix", objectiveId: "overdue", taskIds: [], state: "waiting", doing: "Waiting on your call: reconciler or flag" },
  { id: "r-sap", role: "router", scope: "SAP data: which runs send full snapshots", objectiveId: "overdue", taskIds: [], state: "working", doing: "Pulling which Festo runs ever sent a full snapshot" },
  { id: "mf-2", role: "worker", objectiveId: "overdue", parent: "r-overdue", taskIds: ["t9", "t3"], state: "working", doing: "Tracing which runs set full_snapshot" },
  { id: "r-board", role: "router", scope: "Whole objective", objectiveId: "board", taskIds: [], state: "idle", doing: "Nothing queued" },
  { id: "mf-3", role: "worker", objectiveId: "board", parent: "r-board", taskIds: ["t5"], state: "asleep", doing: "Merged #42" },
  { id: "r-reviews", role: "router", scope: "Whole objective", objectiveId: "reviews", taskIds: [], state: "working", doing: "Watching #reviews-pls" },
  { id: "mf-4", role: "worker", objectiveId: "reviews", parent: "r-reviews", taskIds: ["t8", "t6"], state: "working", doing: "Drafting review comments on #7149" },
];

export const threads: Thread[] = [
  {
    id: "th-pager",
    title: "Pager rollout",
    objectiveId: "festo-perf",
    routerIds: ["r-festo"],
    messages: [
      { from: "r-festo", at: "2026-11-10T09:05", text: "Started [[agent:mf-1]] on [[task:t1]]. Measurement from [[task:t7]] says $skip is quadratic." },
      { from: "r-festo", at: "2026-11-15T10:04", text: "CI is green on [#6250](https://github.com/acme/app/pull/6250). Holding [[task:t2]] until it merges." },
    ],
  },
  {
    id: "th-close-path",
    title: "Close path decision",
    objectiveId: "overdue",
    routerIds: ["r-overdue", "r-sap"],
    messages: [
      { from: "r-sap", at: "2026-11-12T17:40", text: "No Festo run has ever sent a full snapshot. Checked the last 30 days." },
      { from: "r-overdue", at: "2026-11-13T09:30", text: "So flipping the flag would close ~45% falsely. Asked Isaac on [[objective:overdue]]; [[agent:mf-2]] keeps tracing meanwhile." },
      { from: "isaac", at: "2026-11-13T11:00", text: "Reconciler." },
      { from: "r-overdue", at: "2026-11-13T11:05", text: "Queued [[task:t4]] behind [[task:t3]]." },
    ],
  },
  {
    id: "th-board",
    title: "Board notes",
    objectiveId: "board",
    routerIds: ["r-board"],
    messages: [{ from: "r-board", at: "2026-11-14T16:10", text: "[[agent:mf-3]] merged [#42](https://github.com/acme/maxflow/pull/42). Nothing queued." }],
  },
  {
    id: "th-reviews",
    title: "Review queue",
    objectiveId: "reviews",
    routerIds: ["r-reviews"],
    messages: [
      { from: "r-reviews", at: "2026-11-14T15:02", text: "Ping on [#7149](https://github.com/acme/app/pull/7149). Started [[agent:mf-4]]." },
      { from: "r-reviews", at: "2026-11-15T10:25", text: "Two judgment calls drafted on [[task:t6]], waiting on you." },
    ],
  },
];

/** A question an agent raised for Isaac through the questions sentry; pending ones wait on his answer. */
export type Question = { id: number; session: string; name: string; status: "gating" | "pending"; at: number; thread: { from: "agent" | "user" | "sentry"; text: string; at: number }[] };

/** A sentry session from the live server: one of main's sentries, run in tmux. */
export type SentrySession = { id: string; name: string; running: boolean; status: string; lastOutputAt: number; createdAt: number; ties: { session: string; label: string }[]; use: string };

export const sentries: Sentry[] = [
  {
    id: "isaac",
    label: "You",
    state: "live",
    watching: [{ target: "chat", what: "prompts", routedTo: ["r-festo", "r-overdue", "r-board", "r-reviews"] }],
  },
  {
    id: "gh",
    label: "GitHub",
    state: "polling",
    every: "60s",
    lastPoll: "13:59:48",
    watching: [
      { target: "#6250", what: "CI, reviews, merge", routedTo: ["mf-1", "r-festo"] },
      { target: "#7149", what: "CI, comments", routedTo: ["mf-4"] },
      { target: "#42", what: "merged", routedTo: ["mf-3", "r-board"] },
    ],
  },
  {
    id: "slack",
    label: "Slack",
    state: "backoff",
    every: "2m",
    lastPoll: "13:58:02",
    watching: [
      { target: "#festo-ops", what: "messages, threads", routedTo: ["r-festo", "r-sap"] },
      { target: "#reviews-pls", what: "pings naming Isaac", routedTo: ["r-reviews"] },
      { target: "DM Ayush", what: "replies", routedTo: ["r-overdue"] },
    ],
  },
];

export const signals: Signal[] = [
  { id: "s1", source: "gh", at: "2026-11-15T13:41", target: "#7149", text: "Author replied: \"why rename fetchRows?\"", routedTo: ["mf-4"] },
  { id: "s2", source: "slack", at: "2026-11-15T13:20", target: "#festo-ops", text: "\"Is the backfill safe to run yet?\"", routedTo: ["r-festo"] },
  { id: "s3", source: "slack", at: "2026-11-15T11:02", target: "DM Ayush", text: "\"SAP side can't change the CDS view until 2027\"", routedTo: ["r-overdue", "r-sap"] },
  { id: "s4", source: "gh", at: "2026-11-15T10:02", target: "#6250", text: "CI green", routedTo: ["mf-1", "r-festo"] },
  { id: "s5", source: "gh", at: "2026-11-15T09:58", target: "#6250", text: "Review requested from Ayush", routedTo: ["mf-1"] },
  { id: "s6", source: "isaac", at: "2026-11-15T09:15", target: "chat", text: "Once #6250 merges, re-run intake for the last 30 days.", routedTo: ["r-festo"] },
  { id: "s7", source: "isaac", at: "2026-11-15T08:50", target: "chat", text: "Why do overdue cases stay open after SAP clears them?", routedTo: ["r-overdue", "mf-2"] },
  { id: "s8", source: "slack", at: "2026-11-14T14:55", target: "#reviews-pls", text: "Review ping naming Isaac on #7149", routedTo: ["r-reviews"] },
  { id: "s9", source: "gh", at: "2026-11-14T16:00", target: "#42", text: "Merged", routedTo: ["mf-3", "r-board"] },
  { id: "s10", source: "isaac", at: "2026-11-11T10:40", target: "chat", text: "Cards should show their PR state.", routedTo: ["r-board"] },
  { id: "s11", source: "isaac", at: "2026-11-08T09:00", target: "chat", text: "Overdue cases keep piling up. Find out why and stop it.", routedTo: ["r-overdue"] },
  { id: "s12", source: "isaac", at: "2026-11-03T10:00", target: "chat", text: "Get Festo sweeps under the prod tick, then backfill what we missed.", routedTo: ["r-festo"] },
];

export const columns: { status: Status; label: string }[] = [
  { status: "todo", label: "Todo" },
  { status: "doing", label: "Doing" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

export const agentStateColor: Record<AgentState, string> = {
  working: "bg-sky-400",
  waiting: "bg-amber-400",
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
  doing: "bg-sky-400",
  review: "bg-amber-400",
  done: "bg-emerald-400",
};
