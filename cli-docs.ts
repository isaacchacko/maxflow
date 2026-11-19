import { argAt, call, fail, hasArg, listAt, replyOf, str, type Verb } from "./cli-shared";

const at = (path: string) => `/api/docs/${encodeURIComponent(path)}`;

async function answer(path: string, init?: RequestInit) {
  return replyOf(await call(at(path), init));
}

function line(value: unknown) {
  const doc = replyOf(value);
  const open = Number(doc["open"]);
  const owner = doc["owner"] === undefined ? "" : `  owner ${str(doc, "owner")}`;
  return `${str(doc, "path")}${owner}${open > 0 ? `  ${String(open)} open comment(s)` : ""}`;
}

async function ls() {
  const vault = replyOf(await call("/api/docs"));
  console.log(`vault: ${str(vault, "dir")}`);
  for (const doc of listAt(vault, "docs")) console.log(line(doc));
}

async function read(args: string[]) {
  const doc = await answer(argAt(args, 1));
  console.log(str(doc, "text"));
}

async function write(args: string[]) {
  const text = hasArg(args, 2) ? args.slice(2).join(" ") : await Bun.stdin.text();
  const written = await answer(argAt(args, 1), { method: "PUT", body: JSON.stringify({ text }) });
  console.log(str(written, "path"));
}

async function mv(args: string[]) {
  const moved = await answer(argAt(args, 1), { method: "PATCH", body: JSON.stringify({ to: argAt(args, 2) }) });
  console.log(str(moved, "path"));
}

async function rm(args: string[]) {
  const removed = await answer(argAt(args, 1), { method: "DELETE" });
  console.log(`removed ${str(removed, "path")}`);
}

const ACTIONS: Record<string, (args: string[]) => Promise<void>> = { ls, read, write, mv, rm };

export const docVerbs: Verb[] = [
  {
    matches: (verb) => verb === "docs",
    run: async (args) => {
      const action = ACTIONS[argAt(args, 0)];
      if (!action || (args[0] !== "ls" && !hasArg(args, 1))) fail("usage: maxflow docs ls | read <path> | write <path> [text...] (else stdin) | mv <path> <to> | rm <path>");
      await action(args);
    },
  },
];
