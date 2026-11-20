import { slackNames } from "./slack-meta";
import { publish } from "./bus";
import { CLI } from "./instance";
import { setOption } from "./tmux";
import { type Role, type Session, sessions } from "./sessions";
import type { Message, Objective, Thread } from "./model";
import { objectives, saveObjectives, saveThreads, threads } from "./stores";
import { dispatch, setWait } from "./lifecycle";
import { IMAGE, message } from "./threads";
import { slackChannels } from "./routing";
import { patch } from "./patch";
import { isFilled } from "./shared/guards";

function slug(title: string) {
  const dashed = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "").slice(0, 32);
  return dashed === "" ? "objective" : dashed;
}
const isObjectiveId = (id: string) => objectives.some((o) => o.id === id);

export function setRole(s: Session, role: Role) {
  patch(s, { role });
  setOption(s.id, "@mf-role", JSON.stringify(role));
}
export function newObjective(title: string, cwd: string) {
  let id = slug(title);
  while (isObjectiveId(id)) id = `${slug(title).slice(0, 28)}-${crypto.randomUUID().slice(0, 3)}`;
  const o: Objective = { id, title, cwd, at: Date.now(), page: [] };
  objectives.push(o);
  saveObjectives();
  publish(`objective/${id}`, { id, title });
  return o;
}
export const doesPointAtItself = (text: string, t: Thread) => text.includes(`[[thread:${t.id}]]`) || new RegExp(String.raw`\b${t.id}\b`).test(text);
const isKeptWhenFoldedInto = (m: Message, into: Thread) => m.from === "isaac" || m.from === "feed" || !doesPointAtItself(m.text, into);
function joinMembers(from: Thread, into: Thread) {
  const joining = [...new Set(from.members)].filter((id) => into.members?.includes(id) !== true);
  if (joining.length === 0) return;
  if (into.members === undefined) patch(into, { members: joining });
  else into.members.push(...joining);
}
function takeOverMessagesRoutersAndAsk(from: Thread, into: Thread) {
  patch(into, { messages: [...into.messages, ...from.messages.filter((m) => isKeptWhenFoldedInto(m, into))].toSorted((a, b) => a.at - b.at) });
  for (const id of from.routers) if (!into.routers.includes(id)) into.routers.push(id);
  joinMembers(from, into);
  if (from.asks !== undefined && into.asks === undefined) patch(into, { asks: from.asks });
}
export function mergeThread(from: Thread, into: Thread) {
  takeOverMessagesRoutersAndAsk(from, into);
  for (const t of threads) if (t.parent?.thread === from.id) t.parent.thread = into.id;
  for (const s of sessions.values()) if (s.wait?.kind === "thread" && s.wait.ref === from.id) setWait(s, { ...s.wait, ref: into.id });
  Object.assign(from, { mergedInto: into.id, asks: undefined, pending: undefined, ...(from.messages.some((m) => m.from === "isaac") && { moved: { at: Date.now() } }) });
  saveThreads();
  for (const t of [from, into]) publish(`thread/${t.id}`, { thread: t.id, ...(t === from && { mergedInto: into.id }) });
}
function agentAsTyped(chip: string, id: string) {
  const agent = sessions.get(id);
  return agent ? `@${agent.name.replace(/^sentry:/, "")}` : chip;
}
export function titleOf(text: string) {
  const slack = slackNames(slackChannels);
  const line =
    text
      .replaceAll(IMAGE, "")
      .replaceAll(/\[\[(?:agent|router):([\w-]+)\]\]/g, (chip, id: string) => agentAsTyped(chip, id))
      .replaceAll(/<@([UW]\w+)(?:\|([^>]*))?>/g, (_, id: string, name: string | undefined) => `@${[name, slack[id]].find(isFilled) ?? id}`)
      .replaceAll(/<#(C\w+)(?:\|([^>]*))?>/g, (_, id: string, name: string | undefined) => (isFilled(name) ? `#${name}` : (slack[id] ?? "#channel")))
      .replaceAll(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
      .replaceAll(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2")
      .trim()
      .split("\n", 1)[0] ?? "";
  return (line === "" ? "image" : line).slice(0, 80);
}
export function subthread(parent: Thread, messageId: string) {
  const m = parent.messages.find((x) => x.id === messageId);
  if (!m) return null;
  if (!parent.parent && parent.messages[0] === m) return parent;
  const found = threads.find((t) => t.parent?.thread === parent.id && t.parent.message === m.id);
  if (found) return found;
  const t: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: titleOf(m.text), objective: parent.objective, routers: [...parent.routers], messages: [], parent: { thread: parent.id, message: m.id } };
  threads.push(t);
  saveThreads();
  return t;
}

export function reparentWorkers(old: Session, to: Session) {
  for (const w of sessions.values()) if (w.role?.role === "worker" && w.role.parent === old.id) setRole(w, { ...w.role, parent: to.id });
}
export function handOff(old: Session, oldRole: Role, to: Session) {
  reparentWorkers(old, to);
  setRole(old, { role: "worker", objective: oldRole.objective, parent: to.id, handedTo: to.id });
  const handed = threads.filter((t) => t.mergedInto === undefined && t.routers.includes(old.id));
  for (const t of handed) {
    t.routers = [...t.routers.filter((id) => id !== old.id && id !== to.id), to.id];
    if (t.pending?.routers.includes(old.id) === true) t.pending.routers = [...t.pending.routers.filter((id) => id !== old.id && id !== to.id), to.id];
    if (t.asks?.session === old.id) t.asks.session = to.id;
    t.messages.push(message("yarn", `Handed from [[agent:${old.id}]] to [[agent:${to.id}]], which answers here from now on.`));
    publish(`thread/${t.id}`, { thread: t.id, from: "yarn" });
  }
  saveThreads();
  publish(`handoff/${old.id}`, { from: old.id, to: to.id, objective: oldRole.objective, threads: handed.map((t) => t.id) });
  return handed;
}
export function askOldRouterToBriefTheNew(old: Session, oldRole: Role, to: Session, handed: Thread[]) {
  const handedList = handed.length > 0 ? ` (${handed.map((t) => t.id).join(", ")})` : "";
  dispatch({ to: [old], target: to.id, text: `[yarn] You handed objective ${oldRole.objective} to the new router ${to.id}. Its threads${handedList} and your workers are its now, and his messages there go to it alone; each thread shows the hand-off, so don't post there or announce it. Tell ${to.id} what it needs with \`${CLI} notify ${to.id} '<text>'\`, then end with \`${CLI} wait done\`.` });
}
const HANDS_TO_ANOTHER = /\b(pass(?:ed|ing)?|hand(?:ed|ing)?(?: (?:it|this))?(?: off| over)?|forward(?:ed|ing)?|relay(?:ed|ing)?|routed|gave|given|giving)\b[^.\n]{0,40}\bto\b|\b(?:takes?|taking|took) over\b|\bnew router\b/i;
export function relayRefusal(t: Thread, from: Session, text: string): string | undefined {
  const handedTo = from.role?.handedTo;
  if (handedTo !== undefined && t.routers.includes(handedTo))
    return `You handed ${t.id} to ${handedTo}, which answers him here. Tell it what it needs with \`${CLI} notify ${handedTo} '<text>'\` instead.`;
  const otherRouter = text
    .matchAll(/\[\[(?:agent|router):([\w-]+)\]\]/g)
    .map((m) => sessions.get(m[1] ?? ""))
    .find((s): s is Session => s !== undefined && s !== from && s.role?.role === "router");
  return otherRouter !== undefined && from.role?.role === "router" && HANDS_TO_ANOTHER.test(text)
    ? `This hands ${t.id} to ${otherRouter.id}, and yarn shows hand-offs in the thread itself; ${otherRouter.id} answers him. Post what you found or did, without the hand-off, or nothing.`
    : undefined;
}
