import { seqOf } from "./shared/legacy-maxflow";
import { readFileSync } from "node:fs";
import { argAt, base, call, caller, fail, flag, hasArg, isBlank, isTruthy, mySession, positional, post, replies, replyOf, str, timeout, type Reply, type Verb } from "./cli-shared";

type NewSession = { name: string | undefined; cwd: string; cmd: string[] | undefined; role: string | undefined; objective: string | undefined; parent: string | undefined; scope: string | undefined };

async function create(body: NewSession) {
  const res = await fetch(`${base}/api/sessions`, { method: "POST", ...(caller && { headers: caller }), body: JSON.stringify(body), signal: timeout() });
  if (!res.ok) fail(`${res.status} ${await res.text()}`);
  const created = replyOf(await res.json());
  console.log(`${base}/#agent/${str(created, "id")}`);
}

async function sessionList() {
  return replies(await (await fetch(`${base}/api/sessions`, { signal: timeout() })).json());
}

async function listSessions() {
  const sessions = await sessionList();
  for (const s of sessions) console.log(`${str(s, "id")}  ${isTruthy(s["running"]) ? "run " : "exit"}  ${str(s, "name")}  ${base}/#agent/${str(s, "id")}`);
}

function chatMark(c: Reply) {
  if (isTruthy(c["session"])) return "mf  ";
  return isTruthy(c["live"]) ? "live" : " ".repeat(4);
}

async function listChats(args: string[]) {
  const res = await fetch(`${base}/api/chats?limit=30&q=${encodeURIComponent(args.join(" "))}`, { signal: timeout() });
  const chats = replies(await res.json());
  for (const c of chats) console.log(`${str(c, "id")}  ${chatMark(c)}  ${str(c, "title").slice(0, 60).padEnd(60)}  ${str(c, "cwd")}`);
}

async function resumeChat(args: string[]) {
  const res = await fetch(`${base}/api/chats/${argAt(args, 0)}/resume`, { method: "POST", body: JSON.stringify({ bypass: !args.includes("--safe"), force: args.includes("--force") }), signal: timeout() });
  if (res.status === 409) fail("that chat is open in another claude process; rerun with --force to fork it");
  if (!res.ok) fail(await res.text());
  const resumed = replyOf(await res.json());
  console.log(`${base}/#agent/${str(resumed, "id")}`);
}

async function newSession(args: string[]) {
  const dash = args.indexOf("--");
  const flags = dash === -1 ? args : args.slice(0, dash);
  await create({
    name: flag(flags, "--name"),
    cwd: flag(flags, "--cwd") ?? process.cwd(),
    cmd: dash === -1 ? undefined : args.slice(dash + 1),
    role: flag(flags, "--role"),
    objective: flag(flags, "--objective"),
    parent: flag(flags, "--parent"),
    scope: flag(flags, "--scope"),
  });
}

async function typeInto(args: string[]) {
  const [id, ...words] = positional(args, []);
  await post(`/api/sessions/${String(id)}/input`, { text: words.join(" "), enter: !args.includes("--no-enter"), isaac: args.includes("--isaac") });
}

async function screenWait(args: string[]) {
  const limits = Object.entries({ idle: flag(args, "--idle"), match: flag(args, "--match"), timeout: flag(args, "--timeout") }).filter((entry): entry is [string, string] => !isBlank(entry[1]));
  const r = replyOf(await call(`/api/sessions/${argAt(args, 0)}/wait?${new URLSearchParams(limits).toString()}`));
  console.log(r["screen"]);
  console.error(`[${str(r, "reason")}]`);
  if (r["reason"] === "timeout") process.exit(2);
}

type Role = { role: string; objective: unknown; parent: string | undefined; handedTo: string | undefined };
type Around = { id: string; name: string; status: string; running: boolean; role: Role | undefined };

function aroundOf(s: Reply): Around {
  const role = replyOf(s["role"]);
  const [parent, handedTo] = [role["parent"], role["handedTo"]];
  return {
    id: str(s, "id"),
    name: str(s, "name"),
    status: str(s, "status"),
    running: isTruthy(s["running"]),
    role: s["role"] === undefined || s["role"] === null ? undefined : { role: str(role, "role"), objective: role["objective"], parent: typeof parent === "string" ? parent : undefined, handedTo: typeof handedTo === "string" ? handedTo : undefined },
  };
}

function pickerFor(me: Around & { role: Role }, which: string) {
  const routerOf = me.role.role === "router" ? undefined : me.role.parent;
  const pickers = new Map<string, (s: Around & { role: Role }) => boolean>([
    ["router", (s) => (s.role.role === "router" && (isBlank(routerOf) || s.id === routerOf)) || (s.role.role === "owner" && s.id === routerOf)],
    ["parent", (s) => s.id === routerOf],
    ["workers", (s) => s.role.parent === me.id],
    ["objective", () => true],
  ]);
  return pickers.get(which);
}

const hasRole = (s: Around | undefined): s is Around & { role: Role } => s?.role !== undefined;

async function agentsAround(args: string[]) {
  const all = (await sessionList()).map(aroundOf);
  const me = all.find((s) => s.id === mySession());
  if (!hasRole(me)) fail("who works only inside a yarn agent with a role (router, owner or worker)");
  const live = all.filter(hasRole).filter((s) => s.running && s.id !== me.id && s.role.objective === me.role.objective && isBlank(s.role.handedTo));
  const picker = pickerFor(me, argAt(args, 0));
  if (!picker) fail("who router|parent|workers|objective");
  const picked = live.filter(picker);
  for (const s of picked) console.log(`mf-${s.id}  ${s.role.role.padEnd(6)}  ${s.status.padEnd(7)}  ${s.name}`);
}

function sayHowItWent(board: unknown) {
  const how = replyOf(board);
  if (how["via"] === "board") console.log(`on the agent board as #${str(how, "id")}; it reaches the agent at its next idle prompt`);
  else if (how["via"] === "direct") console.log(`the agent board was down (${str(how, "error")}), so it was delivered directly`);
}

async function notify(args: string[]) {
  const [id, ...words] = positional(args, []);
  const answer = replyOf(await post(`/api/sessions/${String(id)}/notify`, { text: words.join(" "), isaac: args.includes("--isaac") }));
  sayHowItWent(answer["board"]);
}

async function replyOnTheBoard(args: string[]) {
  const [re, ...words] = positional(args.slice(1), []);
  const r = replyOf(await post("/api/board-bus/reply", { re, text: words.join(" ") }));
  console.log(`replied on the agent board as #${str(r, "id")}`);
}

async function publish(args: string[]) {
  const data: unknown = hasArg(args, 1) ? JSON.parse(argAt(args, 1)) : null;
  const event = await post("/api/events", { topic: argAt(args, 0), data });
  console.log(JSON.stringify(event));
}

async function subscribe(args: string[]) {
  const topic = encodeURIComponent(argAt(args, 0));
  const now = async () => {
    const res = await fetch(`${base}/api/events?topic=${topic}&after=now`, { signal: timeout() });
    return String(seqOf(res));
  };
  let after = flag(args, "--since") ?? (await now());
  const deadline = Date.now() + Number(flag(args, "--timeout") ?? Infinity);
  for (;;) {
    const wait = Math.min(deadline - Date.now(), 240_000);
    if (wait <= 0) {
      console.error("[timeout]");
      process.exit(2);
    }
    const events = replies(await call(`/api/events?topic=${topic}&after=${after}&wait=${wait}`));
    for (const e of events) console.log(JSON.stringify(e));
    if (events.length > 0 && !args.includes("--follow")) break;
    if (events.length > 0) after = String(events.at(-1)?.["seq"]);
  }
}

async function printScreen(args: string[]) {
  const screen = replyOf(await call(`/api/sessions/${argAt(args, 0)}/screen?history=${flag(args, "--history") ?? 0}`));
  console.log(screen["screen"]);
}

async function handOver(args: string[]) {
  const me = mySession();
  if (isBlank(me)) fail("handoff works only inside a yarn agent");
  const note = readFileSync(argAt(args, 0), "utf8").trim();
  if (note === "") fail(`${argAt(args, 0)} is empty`);
  await post(`/api/sessions/${me}/handoff`, { note });
  console.log("noted: when this turn ends, yarn starts the fresh agent with your note and moves your work to it. End your turn now, without a new wait.");
}

export const sessionVerbs: Verb[] = [
  { matches: (verb, args) => verb === "handoff" && hasArg(args, 0), run: handOver },
  { matches: (verb) => verb === "ls", run: listSessions },
  { matches: (verb) => verb === "chats", run: listChats },
  { matches: (verb, args) => verb === "resume" && hasArg(args, 0), run: resumeChat },
  { matches: (verb) => verb === "new", run: newSession },
  { matches: (verb, args) => verb === "send" && hasArg(args, 1), run: typeInto },
  { matches: (verb, args) => verb === "keys" && hasArg(args, 1), run: async (args) => {
      await post(`/api/sessions/${argAt(args, 0)}/input`, { keys: args.slice(1) });
    },
  },
  { matches: (verb, args) => verb === "screen" && hasArg(args, 0), run: printScreen },
  { matches: (verb, args) => verb === "wait" && hasArg(args, 0), run: screenWait },
  { matches: (verb, args) => verb === "rename" && hasArg(args, 1), run: async (args) => {
      await call(`/api/sessions/${argAt(args, 0)}`, { method: "PATCH", body: JSON.stringify({ name: args.slice(1).join(" ") }) });
    },
  },
  { matches: (verb, args) => verb === "kill" && hasArg(args, 0), run: async (args) => {
      await call(`/api/sessions/${argAt(args, 0)}`, { method: "DELETE" });
    },
  },
  { matches: (verb, args) => verb === "who" && hasArg(args, 0), run: agentsAround },
  { matches: (verb, args) => verb === "notify" && hasArg(args, 1), run: notify },
  { matches: (verb, args) => verb === "board" && args[0] === "reply" && hasArg(args, 2), run: replyOnTheBoard },
];

export const eventVerbs: Verb[] = [
  { matches: (verb, args) => verb === "link" && hasArg(args, 1), run: async (args) => {
      await post("/api/link", { a: argAt(args, 0), b: argAt(args, 1), why: args.slice(2).join(" ") || undefined });
    },
  },
  { matches: (verb, args) => verb === "pub" && hasArg(args, 0), run: publish },
  { matches: (verb, args) => verb === "sub" && hasArg(args, 0), run: subscribe },
];
