import { argAt, call, fail, hasArg, listAt, replyOf, str, type Verb } from "./cli-shared";

const at = (path: string, rest = "") => `/api/canvas/${encodeURIComponent(path)}${rest}`;
const send = async (url: string, method: string, body?: unknown) => replyOf(await call(url, { method, ...(body !== undefined && { body: JSON.stringify(body) }) }));
const textFrom = async (args: string[], from: number) => (hasArg(args, from) ? args.slice(from).join(" ") : Bun.stdin.text());
const numberAt = (args: string[], i: number) => {
  const n = Number(argAt(args, i));
  return Number.isFinite(n) && hasArg(args, i) ? n : fail(`expected a number at "${argAt(args, i)}"`);
};
const oneLine = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text).replaceAll("\n", " ⏎ ");

const boxLine = (n: Record<string, unknown>) => `${str(n, "id")}  @${str(n, "x")},${str(n, "y")} ${str(n, "width")}x${str(n, "height")}  ${oneLine(str(n, "text"))}`;

async function show(args: string[]) {
  const url = at(argAt(args, 1));
  const shown = replyOf(await call(url));
  console.log(`${str(shown, "path")}  rev ${str(shown, "rev")}`);
  const nodes = listAt(replyOf(shown["canvas"]), "nodes");
  for (const node of nodes) console.log(boxLine(replyOf(node)));
}

async function create(args: string[]) {
  const made = await send(at(argAt(args, 1)), "POST");
  console.log(str(made, "path"));
}

async function placement(args: string[]) {
  if (args[2] === "--near") return { near: argAt(args, 3), text: await textFrom(args, 4) };
  return { x: numberAt(args, 2), y: numberAt(args, 3), text: await textFrom(args, 4) };
}

async function add(args: string[]) {
  const node = await send(at(argAt(args, 1), "/nodes"), "POST", await placement(args));
  console.log(str(node, "id"));
}

async function propose(args: string[]) {
  await send(at(argAt(args, 1), `/nodes/${argAt(args, 2)}/propose`), "POST", { text: await textFrom(args, 3) });
  console.log(`proposed new text for ${argAt(args, 2)}; isaac accepts or rejects it on the canvas`);
}

async function edit(args: string[]) {
  await send(at(argAt(args, 1), `/nodes/${argAt(args, 2)}`), "PATCH", { text: await textFrom(args, 3) });
  console.log(`edited ${argAt(args, 2)}`);
}

async function replace(args: string[]) {
  const [find, ...rest] = args.slice(3);
  if (find === undefined || find === "") fail("usage: yarn canvas replace <path> <id> <find> <replacement...>");
  await send(at(argAt(args, 1), `/nodes/${argAt(args, 2)}`), "PATCH", { find, replace: rest.join(" ") });
  console.log(`edited ${argAt(args, 2)}`);
}

async function append(args: string[]) {
  await send(at(argAt(args, 1), `/nodes/${argAt(args, 2)}`), "PATCH", { append: await textFrom(args, 3) });
  console.log(`appended to ${argAt(args, 2)}`);
}

async function move(args: string[]) {
  const size = hasArg(args, 5) ? { width: numberAt(args, 5), height: numberAt(args, 6) } : {};
  await send(at(argAt(args, 1), `/nodes/${argAt(args, 2)}`), "PATCH", { x: numberAt(args, 3), y: numberAt(args, 4), ...size });
  console.log(`moved ${argAt(args, 2)}`);
}

async function rm(args: string[]) {
  await send(at(argAt(args, 1), `/nodes/${argAt(args, 2)}`), "DELETE");
  console.log(`deleted ${argAt(args, 2)}`);
}

async function link(args: string[]) {
  const node = await send(at(argAt(args, 1), `/nodes/${argAt(args, 2)}/link`), "POST", { to: argAt(args, 3), text: await textFrom(args, 4) });
  console.log(oneLine(str(node, "text")));
}

const ACTIONS: Record<string, { run: (args: string[]) => Promise<void>; needs: number }> = {
  show: { run: show, needs: 2 },
  new: { run: create, needs: 2 },
  add: { run: add, needs: 4 },
  edit: { run: edit, needs: 3 },
  propose: { run: propose, needs: 3 },
  replace: { run: replace, needs: 4 },
  append: { run: append, needs: 3 },
  move: { run: move, needs: 5 },
  rm: { run: rm, needs: 3 },
  link: { run: link, needs: 4 },
};

export const CANVAS_USAGE =
  "yarn canvas show <path> | new <path> | add <path> <x> <y> | --near <id> [text...] | propose <path> <isaac's box id> [new text...] | edit <path> <id> [text...] | replace <path> <id> <find> <replacement...> | append <path> <id> [text...] | move <path> <id> <x> <y> [w h] | rm <path> <id> | link <path> <from-id> <to-id> [text...]";

export const canvasVerbs: Verb[] = [
  {
    matches: (verb) => verb === "canvas",
    run: async (args) => {
      const action = ACTIONS[argAt(args, 0)];
      if (!action || !hasArg(args, action.needs - 1)) fail(`usage: ${CANVAS_USAGE}\n(text comes from stdin when omitted. An agent changes only boxes that aren't isaac's; on his it proposes. edit replaces the whole text and is refused while isaac is typing in that box; replace and append merge with his typing. add --near puts the box in free space beside that box, joined by a line.
link marks the first unlinked occurrence of text in <from-id> as [text](#<to-id>))`);
      await action.run(args);
    },
  },
];
