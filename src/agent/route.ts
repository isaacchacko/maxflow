import { addSignal, agentStore, liveStore, objectiveStore, sendChat, taskStore, type PageRef } from "@/store";

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

function pickTarget(text: string): PageRef | undefined {
  const task = bestMatch(text, taskStore.get());
  const objective = bestMatch(text, objectiveStore.get());
  if (objective && (/\bobjective\b/.test(text) || !task || objective.score > task.score)) return `objective/${objective.item.id}`;
  if (task) return `task/${task.item.id}`;
}

/** A message typed into the event log goes to whoever owns what it mentions, else stays unrouted. */
export function routeChat(request: string) {
  if (liveStore.get()) return void sendChat(request);
  const ref = pickTarget(request.toLowerCase());
  if (!ref) return addSignal({ source: "isaac", target: "chat", text: request, routedTo: [] });
  const [type, id] = ref.split("/");
  const objectiveId = type === "objective" ? id : objectiveStore.get().find(o => o.taskIds.includes(id!))?.id;
  const router = agentStore.get().find(a => a.role === "router" && a.objectiveId === objectiveId);
  const worker = type === "task" ? taskStore.get().find(t => t.id === id)?.agent : undefined;
  return addSignal({ source: "isaac", target: "chat", text: request, routedTo: [router?.id, worker].filter((a): a is string => !!a) });
}
