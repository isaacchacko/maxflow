import { argAt, base, fail, flag, hasArg, mySession, positional, timeout, type Verb } from "./cli-shared";
import { addEvent, didCommit, ensureTimelines, findEvents, listTimelines, readTimeline, setNow, TIMELINES_DIR } from "./timelines";

const USAGE = `usage: maxflow timeline add <path> <title> [text...] (else stdin) | now <path> [text...] (else stdin) | read <path> [--last N] | ls [prefix] | find <words...>
  timelines live in ${TIMELINES_DIR}/<folders>/<label>/, one "<UTC time> <title>.txt" per event plus now.txt, the current state`;
const DEFAULT_LAST = 10;

async function author() {
  const id = mySession();
  if (id === undefined || id === "") return "maxflow";
  try {
    const res = await fetch(`${base}/api/sessions`, { signal: timeout() });
    const rows = (await res.json()) as { id: string; name: string }[];
    const name = rows.find((s) => s.id === id)?.name;
    return name === undefined ? id : `${name} (${id})`;
  } catch {
    return id;
  }
}

const textFrom = async (args: string[], from: number) => (hasArg(args, from) ? args.slice(from).join(" ") : await Bun.stdin.text());

async function add(args: string[]) {
  if (!hasArg(args, 2)) fail(USAGE);
  const file = addEvent(argAt(args, 1), argAt(args, 2), await textFrom(args, 3));
  didCommit(`${argAt(args, 1)}: ${argAt(args, 2)}`, await author());
  console.log(file);
}

async function now(args: string[]) {
  if (!hasArg(args, 1)) fail(USAGE);
  const file = setNow(argAt(args, 1), await textFrom(args, 2));
  didCommit(`${argAt(args, 1)}: now`, await author());
  console.log(file);
}

function read(args: string[]) {
  const [, path = ""] = positional(args, ["--last"]);
  if (path === "") fail(USAGE);
  const last = Number(flag(args, "--last") ?? DEFAULT_LAST);
  const t = readTimeline(path, Number.isNaN(last) ? DEFAULT_LAST : last);
  if (t.now === undefined && t.total === 0) {
    const inside = listTimelines(path);
    if (inside.length === 0) fail(`no timeline at ${path}; \`maxflow timeline ls\` lists them`);
    console.log(`${path} holds no events itself; its timelines:`);
    for (const x of inside) console.log(`  ${x.path}  (${String(x.events)} events)`);
    return;
  }
  console.log(`# ${t.path}/now.txt\n${t.now?.trim() ?? "(no now.txt yet: write one with `maxflow timeline now`)"}\n`);
  if (t.total > t.events.length) console.log(`(${String(t.total - t.events.length)} earlier events not shown; --last ${String(t.total)} for all)\n`);
  for (const e of t.events) console.log(`## ${e.file}\n${e.text.trim()}\n`);
}

function ls(args: string[]) {
  for (const t of listTimelines(argAt(args, 1))) {
    const state = t.now?.trim().split("\n")[0] ?? "";
    console.log(`${t.path}  ${String(t.events)} events${t.latest === undefined ? "" : `, latest ${t.latest.slice(0, 20)}`}${state === "" ? "" : `\n    now: ${state}`}`);
  }
}

function find(args: string[]) {
  const words = args.slice(1);
  if (words.length === 0) fail(USAGE);
  for (const hit of findEvents(words)) console.log(`${hit.file}\n    ${hit.line}`);
}

const ACTIONS: Record<string, (args: string[]) => Promise<void> | void> = { add, now, read, ls, find };

export const timelineVerbs: Verb[] = [
  {
    matches: (verb) => verb === "timeline" || verb === "timelines",
    run: async (args) => {
      const action = ACTIONS[argAt(args, 0)];
      if (!action) fail(USAGE);
      ensureTimelines();
      await action(args);
    },
  },
];
