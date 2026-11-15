import { GRID_COLS, GRID_ROWS, type Block, type Status, type Task } from "@/mock";
import { addEvent, moveTask, putBlock, removeBlock, taskStore } from "@/store";
import { click, drag, hide, moveTo, press, show } from "./cursor";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const columnWords: [RegExp, Status][] = [
  [/\btodo\b|\bbacklog\b/, "todo"],
  [/\bdoing\b|\bstart|\bpick up\b|\bwork on\b/, "doing"],
  [/\breview\b/, "review"],
  [/\bdone\b|\bfinish|\bclose\b/, "done"],
];

function matchTask(text: string, tasks: Task[]) {
  const words = new Set(text.split(/\W+/).filter(w => w.length > 3));
  let best: Task | undefined;
  let bestScore = 0;
  for (const t of tasks) {
    const score = t.title.toLowerCase().split(/\W+/).filter(w => words.has(w)).length;
    if (score > bestScore) [best, bestScore] = [t, score];
  }
  return best;
}

type Draft = Omit<Block, "id" | "w" | "h"> & Partial<Pick<Block, "w" | "h">>;

function draftFor(text: string, request: string, task: Task): Draft | undefined {
  if (/\b(chart|graph|trend|plot)\b/.test(text))
    return { kind: "chart", title: "Throughput", style: /\bbar/.test(text) ? "bar" : "line", unit: "/min", points: [12, 14, 13, 18, 22, 21, 27, 31] };
  if (/\btable\b/.test(text))
    return { kind: "table", title: "Breakdown", w: 6, columns: ["Item", "State", "Owner"], rows: [["Pager", "merged", "mf-1"], ["Backfill", "queued", "—"], ["Reconciler", "blocked", "—"]] };
  if (/\b(steps|plan|checklist)\b/.test(text))
    return { kind: "steps", title: "Plan", items: [{ text: "Reproduce", done: true }, { text: "Fix the root cause", done: false }, { text: "Verify on prod data", done: false }] };
  if (/\b(log|logs|code)\b/.test(text))
    return { kind: "code", title: "Latest log", w: 6, text: `[${task.agent ?? "agent"}] tick ok\nrows=48,211 elapsed=6m40s\nno errors` };
  if (/\b(ask|question|decide)\b/.test(text))
    return { kind: "question", question: "Ship it as is, or wait for the backfill to verify?", options: ["Ship", "Wait"] };
  if (/\b(stat|number|metric|count)\b/.test(text))
    return { kind: "stat", label: "Cases touched", value: "312", delta: "+48 since 09:00", tone: "good" };
  if (/\b(show|add|note|page)\b/.test(text)) return { kind: "note", title: "Note", text: request };
}

const pinned = new Set<Block["kind"]>(["status", "activity", "question"]);

async function openTask(task: Task) {
  if (location.hash === `#task/${task.id}`) return;
  const view = location.hash.startsWith("#graph") ? "graph" : "kanban";
  if (!location.hash.startsWith(`#${view}`)) await click(`tab:${view}`);
  await click(`${view === "graph" ? "node" : "card"}:${task.id}`);
}

async function editPage(task: Task, draft: Draft, say: (s: string) => void) {
  say(`Adding a ${draft.kind} card to "${task.title}".`);
  await openTask(task);
  await moveTo("page");

  const fresh = taskStore.get().find(t => t.id === task.id)!;
  const replace = fresh.page.find(b => b.kind === draft.kind && !pinned.has(b.kind));
  const block = { w: 4, h: 2, ...draft, id: replace?.id ?? `b${Date.now()}` } as Block;

  const area = (bs: Block[]) => bs.reduce((n, b) => n + b.w * b.h, 0);
  let page = fresh.page.filter(b => b.id !== replace?.id);
  while (area(page) + block.w * block.h > GRID_COLS * GRID_ROWS) {
    const victim = [...page].reverse().find(b => !pinned.has(b.kind));
    if (!victim) break;
    say(`Page is full, dropping the ${victim.kind} card.`);
    await press(`block:${victim.id}`);
    removeBlock(task.id, victim.id);
    page = page.filter(b => b.id !== victim.id);
    await sleep(300);
  }

  if (replace) await press(`block:${replace.id}`);
  putBlock(task.id, block);
  await sleep(120);
  await press(`block:${block.id}`);
  addEvent(task.id, { from: "agent", at: "now", text: `${replace ? "Updated" : "Added"} the ${draft.kind} card.` });
}

async function moveCard(task: Task, status: Status, say: (s: string) => void) {
  say(`Moving "${task.title}" to ${status}.`);
  if (!location.hash.startsWith("#kanban")) await click("tab:kanban");
  await drag(`card:${task.id}`, `column:${status}`, task.title, () => moveTask(task.id, status));
  addEvent(task.id, { from: "agent", at: "now", text: `Moved to ${status}.` });
  const card = task.page.find(b => b.kind === "status");
  if (card) putBlock(task.id, { ...card, summary: `Moved to ${status} by ${task.agent ?? "the agent"}. Previously: ${card.summary}` });
}

export async function act(request: string, say: (s: string) => void) {
  const text = request.toLowerCase();
  const tasks = taskStore.get();
  const onPage = location.hash.match(/^#task\/(\w+)/)?.[1];
  const task = matchTask(text, tasks) ?? tasks.find(t => t.id === onPage) ?? tasks.find(t => t.status === "todo");
  if (!task) return say("Nothing on the board to work on.");

  const status = columnWords.find(([re]) => re.test(text))?.[1];
  const draft = draftFor(text, request, task);

  await show();
  try {
    if (status) await moveCard(task, status, say);
    if (draft) await editPage(task, draft, say);
    if (!status && !draft) {
      say(`Opening "${task.title}".`);
      await openTask(task);
    }
    say("Done.");
  } finally {
    await hide();
  }
}
