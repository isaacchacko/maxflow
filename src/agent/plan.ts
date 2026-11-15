import type { Status, Task } from "../mock";
import { draftStore, moveTask, taskStore } from "../store";
import { click, drag, hide, show, type } from "./cursor";

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

type Say = (text: string) => void;

async function moveCard(task: Task, status: Status, say: Say) {
  say(`Moving "${task.title}" to ${status}.`);
  await click("tab:kanban");
  await drag(`card:${task.id}`, `column:${status}`, task.title, () => moveTask(task.id, status));
}

async function postInThread(task: Task, text: string, say: Say) {
  say(`Posting in the "${task.title}" thread.`);
  await click("tab:threads");
  await click(`thread:${task.id}`);
  await type("composer", text, value => draftStore.set({ text: value, from: "agent" }));
  await click("send");
}

export async function act(request: string, say: Say) {
  const text = request.toLowerCase();
  const tasks = taskStore.get();
  const status = columnWords.find(([re]) => re.test(text))?.[1];
  const task = matchTask(text, tasks) ?? tasks.find(t => t.status === "todo");

  if (!task) {
    say("Nothing on the board to pick up.");
    return;
  }

  await show();
  try {
    if (/\b(tell|ask|message|post|say)\b/.test(text)) {
      await postInThread(task, request.replace(/^.*?\b(tell|ask|message|post|say)\b\s*/i, ""), say);
    } else {
      const target = status ?? "doing";
      await moveCard(task, target, say);
      await postInThread(task, `Picked this up, moved it to ${target}.`, say);
    }
    say("Done.");
  } finally {
    await hide();
  }
}
