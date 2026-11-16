import { GRID_COLS, GRID_ROWS, type Block, type Status, type Task } from "@/mock";
import { addEvent, addSignal, agentStore, moveTask, putBlock, removeBlock, taskStore, threadStore, type PageRef } from "@/store";
import { click, drag, hide, moveTo, press, show } from "./cursor";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const columnWords: [RegExp, Status][] = [
  [/\btodo\b|\bbacklog\b/, "todo"],
  [/\bdoing\b|\bstart|\bpick up\b|\bwork on\b/, "doing"],
  [/\breview\b/, "review"],
  [/\bdone\b|\bfinish|\bclose\b/, "done"],
];

function bestMatch<T extends { title: string }>(text: string, items: T[]) {
  const words = new Set(text.split(/\W+/).filter(w => w.length > 3));
  let best: T | undefined;
  let bestScore = 0;
  for (const item of items) {
    const score = item.title.toLowerCase().split(/\W+/).filter(w => words.has(w)).length;
    if (score > bestScore) [best, bestScore] = [item, score];
  }
  return best && { item: best, score: bestScore };
}

type Draft = Omit<Block, "id" | "w" | "h"> & Partial<Pick<Block, "w" | "h">>;

function draftFor(text: string, request: string, agent = "agent"): Draft | undefined {
  if (/\b(chart|graph|trend|plot)\b/.test(text))
    return { kind: "chart", title: "Throughput", style: /\bbar/.test(text) ? "bar" : "line", unit: "/min", points: [12, 14, 13, 18, 22, 21, 27, 31] };
  if (/\btable\b/.test(text))
    return { kind: "table", title: "Breakdown", w: 6, columns: ["Item", "State", "Owner"], rows: [["Pager", "merged", "mf-1"], ["Backfill", "queued", "—"], ["Reconciler", "blocked", "—"]] };
  if (/\b(steps|plan|checklist)\b/.test(text))
    return { kind: "steps", title: "Plan", items: [{ text: "Reproduce", done: true }, { text: "Fix the root cause", done: false }, { text: "Verify on prod data", done: false }] };
  if (/\b(log|logs|code)\b/.test(text))
    return { kind: "code", title: "Latest log", w: 6, text: `[${agent}] tick ok\nrows=48,211 elapsed=6m40s\nno errors` };
  if (/\b(ask|question|decide)\b/.test(text))
    return { kind: "question", question: "Ship it as is, or wait for the backfill to verify?", options: ["Ship", "Wait"] };
  if (/\b(stat|number|metric|count)\b/.test(text))
    return { kind: "stat", label: "Cases touched", value: "312", delta: "+48 since 09:00", tone: "good" };
  if (/\b(show|add|note|page)\b/.test(text)) return { kind: "note", title: "Note", text: request };
}

const pinned = new Set<Block["kind"]>(["status", "activity", "question", "vision", "tasks", "agents"]);

type Target = { ref: PageRef; title: string; page: Block[]; agent?: string; task?: Task };

function resolve(ref: PageRef): Target {
  const [type, id] = ref.split("/");
  if (type === "task") {
    const task = taskStore.get().find(t => t.id === id)!;
    return { ref, title: task.title, page: task.page, agent: task.agent, task };
  }
  const thread = threadStore.get().find(t => t.id === id)!;
  return { ref, title: thread.title, page: thread.page };
}

async function openPage(ref: PageRef) {
  if (location.hash === `#${ref}`) return;
  const [type, id] = ref.split("/");
  if (type === "thread") {
    if (!location.hash.startsWith("#timeline") && !location.hash.startsWith("#agents")) await click("tab:timeline");
    return click(`thread:${id}`);
  }
  const view = location.hash.startsWith("#timeline") ? "timeline" : "kanban";
  if (!location.hash.startsWith(`#${view}`)) await click(`tab:${view}`);
  await click(`${view === "kanban" ? "card" : "bar"}:${id}`);
}

async function editPage(ref: PageRef, draft: Draft, say: (s: string) => void) {
  const target = resolve(ref);
  say(`Adding a ${draft.kind} card to "${target.title}".`);
  await openPage(ref);
  await moveTo("page");

  const fresh = resolve(ref).page;
  const replace = fresh.find(b => b.kind === draft.kind && !pinned.has(b.kind));
  const block = { w: 4, h: 2, ...draft, id: replace?.id ?? `b${Date.now()}` } as Block;

  const area = (bs: Block[]) => bs.reduce((n, b) => n + b.w * b.h, 0);
  let page = fresh.filter(b => b.id !== replace?.id);
  while (area(page) + block.w * block.h > GRID_COLS * GRID_ROWS) {
    const victim = [...page].reverse().find(b => !pinned.has(b.kind));
    if (!victim) break;
    say(`Page is full, dropping the ${victim.kind} card.`);
    await press(`block:${victim.id}`);
    removeBlock(ref, victim.id);
    page = page.filter(b => b.id !== victim.id);
    await sleep(300);
  }

  if (replace) await press(`block:${replace.id}`);
  putBlock(ref, block);
  await sleep(120);
  await press(`block:${block.id}`);
  addEvent(ref, { from: "agent", at: "now", text: `${replace ? "Updated" : "Added"} the ${draft.kind} card.` });
}

async function moveCard(task: Task, status: Status, say: (s: string) => void) {
  const ref: PageRef = `task/${task.id}`;
  say(`Moving "${task.title}" to ${status}.`);
  if (!location.hash.startsWith("#kanban")) await click("tab:kanban");
  await drag(`card:${task.id}`, `column:${status}`, task.title, () => moveTask(task.id, status));
  addEvent(ref, { from: "agent", at: "now", text: `Moved to ${status}.` });
  const card = task.page.find(b => b.kind === "status");
  if (card) putBlock(ref, { ...card, summary: `Moved to ${status} by ${task.agent ?? "the agent"}. Previously: ${card.summary}` });
}

function pickTarget(text: string, fallback = true): PageRef | undefined {
  const task = bestMatch(text, taskStore.get());
  const thread = bestMatch(text, threadStore.get());
  const wantsThread = /\bthread\b/.test(text);
  if (thread && (wantsThread || !task || thread.score > task.score)) return `thread/${thread.item.id}`;
  if (task) return `task/${task.item.id}`;
  if (!fallback) return;
  const here = location.hash.match(/^#((task|thread)\/[\w-]+)/)?.[1];
  if (here) return here as PageRef;
  const todo = taskStore.get().find(t => t.status === "todo");
  return todo && `task/${todo.id}`;
}

/** A message typed into the event log: to the pinned agent, else to whoever owns what it mentions. */
export function routeChat(request: string, to?: string) {
  if (to) return addSignal({ source: "isaac", target: "chat", text: request, routedTo: [to] });
  const ref = pickTarget(request.toLowerCase(), false);
  if (ref) return routePrompt(ref, request);
  return addSignal({ source: "isaac", target: "chat", text: request, routedTo: [] });
}

function routePrompt(ref: PageRef, request: string) {
  const [type, id] = ref.split("/");
  const threadId = type === "thread" ? id : threadStore.get().find(t => t.taskIds.includes(id!))?.id;
  const router = agentStore.get().find(a => a.role === "router" && a.threadId === threadId);
  const worker = type === "task" ? taskStore.get().find(t => t.id === id)?.agent : undefined;
  return addSignal({ source: "isaac", target: "chat", text: request, routedTo: [router?.id, worker].filter((a): a is string => !!a) });
}

export async function act(request: string, say: (s: string) => void) {
  const text = request.toLowerCase();
  const ref = pickTarget(text);
  if (!ref) return say("Nothing on the board to work on.");
  const target = resolve(ref);
  routePrompt(ref, request);

  const status = target.task && columnWords.find(([re]) => re.test(text))?.[1];
  const draft = draftFor(text, request, target.agent);

  await show();
  try {
    if (status && target.task) await moveCard(target.task, status, say);
    if (draft) await editPage(ref, draft, say);
    if (!status && !draft) {
      say(`Opening "${target.title}".`);
      await openPage(ref);
    }
    say("Done.");
  } finally {
    await hide();
  }
}
