import { backgroundShells, backgroundSubagents, subagentRowsOn, transcriptTail } from "./background";
import { publish } from "./bus";
import type { Message, Thread } from "./model";
import { type Session, type Wait, sessions } from "./sessions";
import { isLive, saveThreads, threads } from "./stores";
import { isFilled } from "./shared/guards";

const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? "" : "s"}`;

export async function workStillRunningInside(s: Session, screen: string) {
  const tail = isFilled(s.transcript) ? await transcriptTail(s.transcript) : "";
  const subagents = Math.max(backgroundSubagents(tail).size, subagentRowsOn(screen).length);
  const shells = backgroundShells(tail).size;
  return [...(subagents > 0 ? [plural(subagents, "subagent")] : []), ...(shells > 0 ? [plural(shells, "background shell")] : [])];
}

export const threadsItIsOn = (s: Session) =>
  threads.filter((t) => t.mergedInto === undefined && t.resolved === undefined && (t.routers.includes(s.id) || t.pending?.routers.includes(s.id) === true));

export function wakesWhen(wait: Wait | undefined) {
  if (wait === undefined || wait.kind === "done") return "a message reaches it";
  switch (wait.kind) {
    case "thread": {
      return `Isaac answers in thread ${wait.ref}`;
    }
    case "approval": {
      return `${wait.ref} is approved`;
    }
    case "ci": {
      return `CI finishes on ${wait.ref}`;
    }
    case "agent": {
      return `agent ${wait.ref.replaceAll(",", " or ")} replies or finishes`;
    }
    case "slack": {
      return `someone posts in Slack at ${wait.ref}`;
    }
    case "until": {
      return `"${wait.desc ?? wait.ref}" ends`;
    }
  }
}

const isDeadAgentWait = (wait: Wait) => wait.kind === "agent" && wait.ref.split(",").every((id) => !isLive(sessions.get(id)));
const isDeadThreadWait = (wait: Wait) => wait.kind === "thread" && threads.every((t) => t.id !== wait.ref);
function deadWait(s: Session) {
  const { wait } = s;
  if (wait === undefined || wait.kind === "done") return;
  return isDeadAgentWait(wait) || isDeadThreadWait(wait) ? `its wait on ${wait.kind}:${wait.ref} can never end` : undefined;
}

const unansweredFromIsaac = (s: Session) => threads.filter((t) => t.mergedInto === undefined && t.pending?.routers.includes(s.id) === true && !isFilled(t.pending.status));

export function workLeftOpenAtSleep(s: Session) {
  const unanswered = unansweredFromIsaac(s).map((t) => `Isaac's message in ${t.id} ("${t.title}") has no answer`);
  return [...unanswered, ...[deadWait(s)].filter(isFilled)];
}

export function postAsMaxflow(t: Thread, text: string) {
  const m: Message = { id: `m-${crypto.randomUUID().slice(0, 6)}`, from: "maxflow", at: Date.now(), text };
  t.messages.push(m);
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: m.from });
}
