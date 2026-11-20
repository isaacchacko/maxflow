import { argAt, base, call, fail, flag, hasArg, isBlank, isTruthy, listAt, localTime, mySession, positional, post, replies, replyOf, str, withImages, type Reply, type Verb } from "./cli-shared";
import { loadRestrictions, resolve } from "./restrictions";
import { isRecord } from "./shared/guards";

async function ask(args: string[]) {
  if (isBlank(mySession())) fail("ask works only inside a yarn session");
  const text = await withImages(positional(args, ["--re", "--default", "--image"]).join(" "), args);
  const t = replyOf(await post("/api/asks", { text, re: flag(args, "--re"), default: flag(args, "--default"), new: args.includes("--new") }));
  console.log(
    `${str(t, "id")}: asked in "${str(t, "title")}" in his inbox, flagged as waiting on him (it goes in the thread you were handed; --new for a thread of its own, --re <id> for another). Keep working; his reply arrives in your prompt. Once nothing is left that doesn't hang on it, run \`yarn wait thread:${str(t, "id")}\` and end your turn.`,
  );
}

type Todo = { id: unknown; day: unknown; state: unknown; text: unknown; threadIds: unknown; at: unknown };
const todoOf = (r: Reply): Todo => ({ id: r["id"], day: r["day"], state: r["state"], text: r["text"], threadIds: r["threadIds"], at: r["at"] });

function byDayThenTime(a: Todo, b: Todo) {
  const byDay = String(a.day).localeCompare(String(b.day));
  return byDay === 0 ? String(a.at).localeCompare(String(b.at)) : byDay;
}

function todoLine(t: Reply) {
  const threadIds = listAt(t, "threadIds");
  return `${str(t, "id")}  ${str(t, "day")}  ${str(t, "state").padEnd(9)}  ${str(t, "text")}${threadIds.length > 0 ? `  [${threadIds.join(" ")}]` : ""}`;
}

async function listTodos(args: string[]) {
  const day = flag(args, "--day");
  const todos = replies(await call("/api/todos"))
    .map(todoOf)
    .filter((t) => isBlank(day) || t.day === day)
    .toSorted(byDayThenTime)
    .map(({ id, day: onDay, state, text, threadIds }) => ({ id, day: onDay, state, text, threadIds }));
  if (args.includes("--json")) console.log(JSON.stringify(todos, null, 2));
  else for (const t of todos) console.log(todoLine(t));
}

async function tagTodo(args: string[]) {
  const t = replyOf(await call(`/api/todos/${argAt(args, 1)}/threads/${argAt(args, 2)}`, { method: args[0] === "tag" ? "POST" : "DELETE" }));
  console.log(`${str(t, "id")}  ${str(t, "text")}  [${listAt(t, "threadIds").join(" ")}]`);
}

function restrictionLine(r: Reply) {
  const scope = replyOf(r["scope"]);
  const where = [scope["objective"], scope["cwd"]];
  const scoped = where.some((part) => isTruthy(part)) ? `  (${where.filter((part) => isTruthy(part)).join(" ")})` : "";
  return `${str(r, "id").padEnd(12)}  ${str(r, "mode").padEnd(5)}  ${str(r, "label")}${scoped}`;
}

async function listRestrictions(args: string[]) {
  const list = await call("/api/restrictions");
  if (args.includes("--json")) console.log(JSON.stringify(list, null, 2));
  else for (const r of replies(list)) console.log(restrictionLine(r));
}

function parsedInput(args: string[]) {
  try {
    const parsed: unknown = JSON.parse(flag(args, "--input") ?? "{}");
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return fail("--input: not JSON");
  }
}

function checkRestriction(args: string[]) {
  const input = parsedInput(args);
  const objective = flag(args, "--objective");
  const restrictionCall = { tool: flag(args, "--tool") ?? "", ...(input && { input }), cwd: flag(args, "--cwd") ?? process.cwd(), ...(objective !== undefined && { objective }) };
  const { mode, restriction } = resolve(loadRestrictions(), restrictionCall);
  console.log(restriction ? `${mode}  ${restriction.id}  ${restriction.label}` : `${mode}  (no restriction matches)`);
}

function taskText(t: Reply) {
  const timeline = replies(t["timeline"]).map((e) => `  ${localTime(e["at"])}  ${str(e, "text")}`);
  const answer = isTruthy(t["answer"]) ? `\n  answer: ${str(t, "answer")}` : "";
  return `t${str(t, "id")}  ${str(t, "status").padEnd(7)}  ${t["kind"] === "question" ? "? " : ""}${str(t, "title")}  [${listAt(t, "sessions").join(" ")}]\n${timeline.join("\n")}${answer}\n`;
}

async function listTasks(args: string[]) {
  const isAll = args.includes("--all");
  const tasks = replies(await call("/api/tasks"));
  for (const t of tasks) if (isAll || (t["status"] !== "done" && t["status"] !== "dropped")) console.log(taskText(t));
}

const TASK_VALUED = ["--title", "--status", "--answer", "--session", "--link", "--event", "--at", "--objective"];

const parsedAt = (at: string) => (/^\d+$/.test(at) ? Number(at) : Date.parse(at));

async function editTask(args: string[]) {
  const [ref, ...words] = positional(args, TASK_VALUED);
  const at = flag(args, "--at");
  if (ref === undefined) fail("usage: yarn task new <title...> | yarn task <id> [--title T] ...");
  const edit = {
    title: flag(args, "--title") ?? (ref === "new" ? words.join(" ") : undefined),
    status: flag(args, "--status"),
    kind: args.includes("--question") ? "question" : undefined,
    answer: flag(args, "--answer"),
    session: flag(args, "--session"),
    link: flag(args, "--link"),
    event: flag(args, "--event"),
    objective: flag(args, "--objective"),
    at: isBlank(at) ? undefined : parsedAt(at),
  };
  const t = replyOf(await post(ref === "new" ? "/api/tasks" : `/api/tasks/${ref.replace(/^t/, "")}`, edit));
  console.log(`t${str(t, "id")} ${str(t, "status")}: ${str(t, "title")}`);
}

async function listObjectives() {
  const objectives = replies(await call("/api/objectives"));
  for (const o of objectives) if (!isTruthy(o["closed"])) console.log(`${str(o, "id")}  ${str(o, "title")}  ${str(o, "cwd")}`);
}

async function newObjective(args: string[]) {
  const title = positional(args.slice(1), ["--cwd", "--scope"]).join(" ");
  const o = replyOf(await post("/api/objectives", { title, cwd: flag(args, "--cwd") ?? process.cwd(), scope: flag(args, "--scope") }));
  console.log(`objective ${str(o, "id")}, router ${str(o, "router")}  ${base}/#objective/${str(o, "id")}`);
}

async function mergeObjective(args: string[]) {
  const r = replyOf(await post(`/api/objectives/${argAt(args, 1)}/merge`, { into: argAt(args, 2) }));
  console.log(`objective ${str(r, "from")} merged into ${str(r, "into")} (moved ${listAt(r, "sessions").length} sessions)`);
}

async function routeSignal(args: string[]) {
  const thread = flag(args, "--thread");
  if (!isBlank(thread)) {
    const r = replyOf(await post(`/api/signals/${argAt(args, 0)}/route`, { thread }));
    console.log(`signal ${argAt(args, 0)} → thread ${str(r, "thread")} (owner ${listAt(r, "routedTo").join(", ")})`);
    return;
  }
  const title = flag(args, "--new");
  const r = replyOf(await post(`/api/signals/${argAt(args, 0)}/route`, isBlank(title) ? { objective: argAt(args, 1) } : { title, cwd: flag(args, "--cwd") ?? process.cwd() }));
  console.log(`signal ${argAt(args, 0)} → objective ${str(r, "objective")} (routers ${listAt(r, "routedTo").join(", ")})`);
}

async function editPage(args: string[]) {
  const isPut = args[0] === "put";
  const block: unknown = isPut ? JSON.parse(argAt(args, 2)) : undefined;
  const body = isPut ? { ref: argAt(args, 1), block } : { ref: argAt(args, 1), id: argAt(args, 2) };
  await call("/api/pages", { method: isPut ? "POST" : "DELETE", body: JSON.stringify(body) });
}

export const boardVerbs: Verb[] = [
  { matches: (verb, args) => verb === "ask" && hasArg(args, 0), run: ask },
  { matches: (verb, args) => verb === "todo" && args[0] === "ls", run: listTodos },
  { matches: (verb, args) => verb === "todo" && (args[0] === "tag" || args[0] === "untag") && hasArg(args, 1) && hasArg(args, 2), run: tagTodo },
  { matches: (verb, args) => verb === "restrictions" && args[0] === "ls", run: listRestrictions },
  { matches: (verb, args) => verb === "restrictions" && args[0] === "check" && !isBlank(flag(args, "--tool")), run: checkRestriction },
  { matches: (verb) => verb === "tasks", run: listTasks },
  { matches: (verb, args) => verb === "task" && hasArg(args, 0), run: editTask },
];

async function sizeSignal(args: string[]) {
  const body = { size: argAt(args, 1), cwd: flag(args, "--cwd"), name: flag(args, "--name"), note: flag(args, "--note"), about: flag(args, "--about") };
  const r = replyOf(await post(`/api/signals/${argAt(args, 0)}/size`, body));
  const made = isBlank(str(r, "session")) ? "" : `, ${str(r, "size") === "owner" ? "owner" : "worker"} ${str(r, "session")}${isBlank(str(r, "thread")) ? "" : ` of thread ${str(r, "thread")}`}`;
  console.log(`signal ${argAt(args, 0)} sized ${str(r, "size")}${made}${isBlank(str(r, "noted")) ? "" : `, noted in ${str(r, "noted")}`}`);
}

async function flipOwners(args: string[]) {
  const which = args[0];
  const r = replyOf(which === "on" || which === "off" ? await post("/api/thread-owners", { on: which === "on" }) : await call("/api/thread-owners"));
  console.log(`thread owners are ${isTruthy(r["on"]) ? "on: new threads get an owner, and no router starts" : "off: the funnel routes to objectives and routers"}`);
}

async function promote(args: string[]) {
  if (isBlank(mySession())) fail("promote works only inside a yarn agent");
  const r = replyOf(await post("/api/promote", { title: positional(args, []).join(" ") }));
  console.log(`you are now the router of objective ${str(r, "objective")}. Read your brief, ${str(r, "brief")}, before you go on.`);
}

export const objectiveVerbs: Verb[] = [
  { matches: (verb) => verb === "objectives", run: listObjectives },
  { matches: (verb, args) => verb === "objective" && args[0] === "new" && hasArg(args, 1), run: newObjective },
  { matches: (verb, args) => verb === "objective" && args[0] === "merge" && hasArg(args, 2), run: mergeObjective },
  { matches: (verb, args) => verb === "route" && hasArg(args, 1), run: routeSignal },
  { matches: (verb, args) => verb === "size" && hasArg(args, 1), run: sizeSignal },
  { matches: (verb, args) => verb === "promote" && hasArg(args, 0), run: promote },
  { matches: (verb) => verb === "owners", run: flipOwners },
  { matches: (verb, args) => verb === "page" && (args[0] === "put" || args[0] === "rm") && hasArg(args, 2), run: editPage },
];
