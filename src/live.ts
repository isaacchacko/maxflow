import type { Agent, Objective, Sentry, SentrySession, Signal, Task, Thread } from "./mock";
import { agentStore, liveStore, objectiveStore, refreshed, sentryStore, signalStore, sourceStore, taskStore, threadStore } from "./store";

type World = { objectives: Objective[]; agents: Agent[]; tasks: Task[]; threads: Thread[]; signals: Signal[]; sentries: SentrySession[] };

const SOURCE_SENTRY: Partial<Record<Sentry["id"], string>> = { gh: "gh", slack: "slack" };
const LABEL: Record<Sentry["id"], string> = { isaac: "You", gh: "GitHub", slack: "Slack", agent: "Agents", sentry: "Sentries", maxflow: "maxflow" };
const EVERY: Partial<Record<Sentry["id"], string>> = { gh: "30s", slack: "60s" };

function sourcesOf(sentries: SentrySession[]): Sentry[] {
  return (Object.keys(LABEL) as Sentry["id"][]).map(id => {
    const name = SOURCE_SENTRY[id];
    const s = name ? sentries.find(x => x.name === name) : undefined;
    return { id, label: LABEL[id], state: !name ? "live" : s?.running ? "polling" : "backoff", every: EVERY[id], watching: [] };
  });
}

function apply(w: World) {
  objectiveStore.set(w.objectives);
  agentStore.set(w.agents);
  taskStore.set(w.tasks);
  threadStore.set(w.threads);
  signalStore.set(w.signals);
  sentryStore.set(w.sentries);
  sourceStore.set(sourcesOf(w.sentries));
  liveStore.set(true);
}

// The health sentry answers in the server's place while it is down; reloading lands on its "Oh no!" page.
let misses = 0;
async function refresh() {
  try {
    const res = await fetch("/api/world", { cache: "no-store" });
    if (res.headers.has("x-maxflow-down")) return location.reload();
    if (res.ok) {
      misses = 0;
      apply(await res.json());
    }
  } catch {
    if (liveStore.get() && ++misses >= 5) location.reload();
  }
}

async function loop() {
  await refresh();
  setTimeout(loop, liveStore.get() ? 1500 : 5000);
}

/** Loads the world once before the first render, then keeps it fresh; a change made through the API refreshes at once. */
export async function startLive() {
  await refresh();
  refreshed.current = refresh;
  setTimeout(loop, 1500);
}
