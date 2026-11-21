import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DIR, IS_LIVE, STATE_DIR } from "./instance";
import { TIMELINES_DIR } from "./timelines";
import { PREVIEW_CAP, PREVIEW_IDLE_MS, type Preview, endPreview, freePort, isPortTaken, isServing, previewDir, previewName, previews, readPreview, snapshotLive, stopServer, writePreview } from "./previews";
import { base, fail, flag, mySession, post, replyOf, str, type Verb } from "./cli-shared";

const BOOT_DEADLINE_MS = 180_000;
const BOOT_POLL_MS = 1000;
const USAGE = "usage: yarn preview [--seed | --copy-live] --what '<what changed>' --try '<what to try>' [--thread ID]   from your worktree";

const git = (cwd: string, args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe" }).stdout.toString().trim();
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)}h`;

function describeRunning(p: Preview) {
  return `${p.name}  http://localhost:${String(p.port)}  branch ${p.branch}, agent ${p.agent}, last looked at ${hours(Date.now() - p.seenAt)} ago`;
}

function refuseOverTheCap(name: string) {
  const others = previews().filter((p) => p.name !== name && isServing(p));
  if (others.length < PREVIEW_CAP)
    return;
  fail(`${String(others.length)} previews already run, the cap on this machine:\n${others.map(describeRunning).join("\n")}\nStop one of yours with \`yarn preview stop <name>\`, or ask its agent to; each stops on its own after ${hours(PREVIEW_IDLE_MS)} unused.`);
}

function prepareState(dir: string, args: string[]) {
  if (args.includes("--copy-live")) {
    snapshotLive(STATE_DIR, TIMELINES_DIR, dir);
    return "a snapshot of live's threads, tasks, objectives, todos and timelines";
  }
  if (args.includes("--seed") || !existsSync(join(dir, "yarn.db"))) return "the fixture seed";
  return "the state it had";
}

async function answersAs(port: number, name: string) {
  try {
    const r = await fetch(`http://localhost:${String(port)}/api/instance`, { signal: AbortSignal.timeout(BOOT_POLL_MS) });
    return r.ok && str(replyOf(await r.json()), "instance") === name;
  } catch {
    return false;
  }
}

async function waitForBoot(p: Preview) {
  for (const end = Date.now() + BOOT_DEADLINE_MS; Date.now() < end; await Bun.sleep(BOOT_POLL_MS)) if (await answersAs(p.port, p.name)) return;
  fail(`${p.name} didn't answer on port ${String(p.port)} within ${String(BOOT_DEADLINE_MS / 1000)}s; its log is ${join(previewDir(p.name), "preview.log")}`);
}

async function stopAndWaitForThePort(p: Preview) {
  stopServer(p.name);
  for (const end = Date.now() + BOOT_POLL_MS * 10; Date.now() < end && isPortTaken(p.port); ) await Bun.sleep(BOOT_POLL_MS / 4);
}

function launch(p: Preview, isSeeding: boolean) {
  const log = join(previewDir(p.name), "preview.log");
  const env = `YARN_INSTANCE=${p.name} YARN_PORT=${String(p.port)} YARN_SESSION= MAXFLOW_SESSION= TMUX=`;
  const script = `nohup env ${env} sh ${JSON.stringify(join(p.worktree, "dev.sh"))}${isSeeding ? " --seed" : ""} >> ${JSON.stringify(log)} 2>&1 &`;
  Bun.spawnSync(["sh", "-c", script], { cwd: p.worktree });
}

async function startPreview(args: string[]) {
  const what = flag(args, "--what");
  const tryThis = flag(args, "--try");
  if (what === undefined || tryThis === undefined) fail(USAGE);
  const agent = mySession();
  if (agent === undefined) fail("run this from your yarn session: YARN_SESSION names the agent his verdict goes back to");
  const worktree = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (worktree === "" || !existsSync(join(worktree, "dev.sh"))) fail(`run this from a worktree of yarn; ${process.cwd()} isn't one`);
  if (worktree === DIR && IS_LIVE) fail(`${DIR} is the checkout live runs from, so it is live already; preview your own worktree`);
  const branch = git(worktree, ["branch", "--show-current"]) || git(worktree, ["rev-parse", "--short", "HEAD"]);
  const name = previewName(branch);
  refuseOverTheCap(name);
  const dir = previewDir(name);
  const before = readPreview(dir);
  if (before) await stopAndWaitForThePort(before);
  const port = before?.port ?? freePort(previews()) ?? fail("no free port for a preview in 4960-4979");
  mkdirSync(dir, { recursive: true });
  const state = prepareState(dir, args);
  const now = Date.now();
  const p: Preview = { name, branch, worktree, port, agent, what, tryThis, live: base, token: crypto.randomUUID(), startedAt: now, seenAt: now, ...(before?.thread !== undefined && { thread: before.thread }) };
  writePreview(p);
  launch(p, state === "the fixture seed");
  await waitForBoot(p);
  const answer = replyOf(await post(`/api/previews/${name}/announce`, { thread: flag(args, "--thread") }));
  console.log(`${name} serves ${branch} from ${worktree} on http://localhost:${String(port)}, with ${state}.\nPosted the link in ${str(answer, "thread")}. His verdict reaches you as a [yarn · preview verdict] message; end your turn with \`yarn wait done\` until then.`);
}

function listPreviews() {
  const all = previews();
  if (all.length === 0) console.log("no previews");
  for (const p of all) console.log(isServing(p) ? describeRunning(p) : `${p.name}  stopped (its state is cleaned on the next sweep)`);
}

function stopPreview(args: string[]) {
  const name = args[1] ?? previewName(git(process.cwd(), ["branch", "--show-current"]));
  const p = readPreview(previewDir(name));
  if (!p) fail(`no preview ${name}`);
  endPreview(name);
  console.log(`stopped ${name} and deleted its state`);
}

export const previewVerbs: Verb[] = [
  { matches: (verb, args) => verb === "preview" && args[0] === "ls", run: listPreviews },
  { matches: (verb, args) => verb === "preview" && args[0] === "stop", run: stopPreview },
  { matches: (verb) => verb === "preview", run: startPreview },
];
