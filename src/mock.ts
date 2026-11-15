export type Status = "todo" | "doing" | "review" | "done";

export type Message = { from: "isaac" | "agent" | "sentry"; at: string; text: string };

export type Task = {
  id: string;
  title: string;
  status: Status;
  agent?: string;
  pr?: number;
  dependsOn: string[];
  messages: Message[];
};

export const tasks: Task[] = [
  {
    id: "t1",
    title: "Festo gateway keyset pagination",
    status: "review",
    agent: "mf-1",
    pr: 6250,
    dependsOn: [],
    messages: [
      { from: "isaac", at: "09:12", text: "$skip+$top is quadratic on the big tenants. Swap it for keyset." },
      { from: "agent", at: "09:40", text: "Count-gated hybrid in. Under 5k rows keeps $skip, above it pages by key." },
      { from: "sentry", at: "10:02", text: "CI green on #6250." },
    ],
  },
  {
    id: "t2",
    title: "Backfill exception intake after pagination lands",
    status: "todo",
    dependsOn: ["t1"],
    messages: [{ from: "isaac", at: "09:15", text: "Once #6250 merges, re-run intake for the last 30 days." }],
  },
  {
    id: "t3",
    title: "Overdue cases never close on cleared",
    status: "doing",
    agent: "mf-2",
    dependsOn: [],
    messages: [
      { from: "isaac", at: "08:50", text: "Why do overdue cases stay open after SAP clears them?" },
      { from: "agent", at: "09:30", text: "full_snapshot is false for Festo, so the close path never sees 'cleared'. Tracing which runs set it." },
    ],
  },
  {
    id: "t4",
    title: "Close-path reconciler",
    status: "todo",
    dependsOn: ["t3"],
    messages: [],
  },
  {
    id: "t5",
    title: "Kanban card shows linked PR state",
    status: "done",
    agent: "mf-3",
    pr: 42,
    dependsOn: [],
    messages: [
      { from: "agent", at: "Yesterday", text: "Merged. Card badge now reads open / draft / merged from the gh sentry." },
    ],
  },
  {
    id: "t6",
    title: "Review #7149 for style",
    status: "doing",
    agent: "mf-4",
    pr: 7149,
    dependsOn: [],
    messages: [
      { from: "agent", at: "10:20", text: "Style commit pushed. Two judgment calls drafted as review comments, waiting on you." },
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
  todo: "bg-neutral-500",
  doing: "bg-sky-400",
  review: "bg-amber-400",
  done: "bg-emerald-400",
};
