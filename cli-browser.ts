import { tmpdir } from "node:os";
import { join } from "node:path";
import { argAt, base, caller, fail, flag, mySession, positional, type Verb } from "./cli-shared";

const BROWSER_TIMEOUT_MS = 60_000;

function ownSession() {
  const session = mySession();
  if (session === undefined || session === "") fail("browser verbs drive your own browser, so they run inside a yarn session ($MAXFLOW_SESSION is unset)");
  return session;
}

async function ask(verb: string, body: Record<string, unknown> = {}): Promise<Response> {
  const res = await fetch(`${base}/api/browsers/${ownSession()}/${verb}`, { method: "POST", headers: caller ?? {}, body: JSON.stringify(body), signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS) });
  if (!res.ok) fail(`browser ${verb}: ${await res.text()}`);
  return res;
}

const printed = async (res: Response) => {
  console.log(await res.text());
};

async function shoot(args: string[]) {
  const file = argAt(args, 1) === "" ? join(tmpdir(), `yarn-browser-${ownSession()}-${String(Date.now())}.png`) : argAt(args, 1);
  await Bun.write(file, await (await ask("screenshot")).arrayBuffer());
  console.log(file);
}

async function evaluate(args: string[]) {
  const code = args.length > 1 ? args.slice(1).join(" ") : await Bun.stdin.text();
  const { value } = (await (await ask("eval", { code })).json()) as { value: unknown };
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

const BROWSER_VERBS: Record<string, (args: string[]) => Promise<void>> = {
  open: async (args) => printed(await ask("open", { url: argAt(args, 1) })),
  goto: async (args) => printed(await ask("open", { url: argAt(args, 1) })),
  screenshot: shoot,
  read: async (args) => printed(await ask("read", { ax: args.includes("--ax") })),
  click: async (args) => printed(await ask("click", { target: args.slice(1).join(" ") })),
  type: async (args) => {
    const [, target = "", ...words] = positional(args, []);
    await printed(await ask("type", { target, text: words.join(" "), enter: args.includes("--enter") }));
  },
  eval: evaluate,
  console: async (args) => {
    const last = Number(flag(args, "--last") ?? 100);
    await printed(await ask("console", { last }));
  },
  cdp: async () => printed(await ask("cdp")),
  close: async () => {
    await ask("close");
    console.log("closed");
  },
};

export const browserVerbs: Verb[] = [
  {
    matches: (verb, args) => verb === "browser" && Object.hasOwn(BROWSER_VERBS, argAt(args, 0)),
    run: async (args) => BROWSER_VERBS[argAt(args, 0)]?.(args),
  },
];
