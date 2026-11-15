export type Status = "todo" | "doing" | "review" | "done";

export type Event = { from: "isaac" | "agent" | "sentry"; at: string; text: string };

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
  );

export type BlockKind = Block["kind"];

export type Task = {
  id: string;
  title: string;
  status: Status;
  agent?: string;
  pr?: number;
  dependsOn: string[];
  events: Event[];
  page: Block[];
};

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
];

export const columns: { status: Status; label: string }[] = [
  { status: "todo", label: "Todo" },
  { status: "doing", label: "Doing" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

export const statusColor: Record<Status, string> = {
  todo: "bg-muted-foreground",
  doing: "bg-sky-400",
  review: "bg-amber-400",
  done: "bg-emerald-400",
};
