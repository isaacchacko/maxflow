#!/usr/bin/env bun
import { statSync } from "node:fs";
import { isRecord } from "../shared/guards";
import { peekStateJson, readGatingStateJson, readStateText, stateDisplayPath, writeStateJson, writeStateText } from "../state";
import { type BoardConfig, type BoardEvent, boardConfigOf, boardEventOf, boardLink, busData, busTopic, feedText, feedTitle, isFed } from "./board-events";
import { dig, type FeedThread, getThreads, log, post } from "./inbox-board";
import { takeOver } from "./singleton";

const CONFIG_FILE = "board.json";
const STATE_FILE = "board-state.json";
const TAIL_PID_FILE = "board-tail.pid";
const TOKEN_MS = 60_000;
const NO_CONFIG_MS = 60_000;
const CONFIG_CHECK_MS = 15_000;
const FIRST_BACKOFF_MS = 5000;
const LONGEST_BACKOFF_MS = 2 * 60_000;

type BoardState = { cursor: string; published: string; threads: Record<string, string> };
const isBoardState = (value: unknown): value is BoardState => isRecord(value) && typeof value["cursor"] === "string" && isRecord(value["threads"]);
const state: BoardState = { cursor: "", published: "", threads: {} };
const tail: { pid: number } = { pid: 0 };

const configChangedAt = () => {
  try {
    return statSync(stateDisplayPath(CONFIG_FILE)).mtimeMs;
  } catch {
    return 0;
  }
};

async function tokenFor(config: BoardConfig) {
  if (config.tokenCommand === undefined || config.tokenCommand.length === 0) return undefined;
  const proc = Bun.spawn(config.tokenCommand, { stdout: "pipe", stderr: "pipe", timeout: TOKEN_MS });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 || out.trim() === "") throw new Error(`token command exited ${String(code)}: ${err.trim().slice(0, 300)}`);
  return out.trim();
}

function didStopGroup(pid: number) {
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function stopTail() {
  if (tail.pid !== 0) didStopGroup(tail.pid);
  tail.pid = 0;
}

function stopTailLeftByAnEarlierCopy() {
  const pid = Number((readStateText(TAIL_PID_FILE) ?? "0").trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  const command = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
  if (command.includes("board") && command.includes("tail") && didStopGroup(pid)) log(`stopped the board tail (group ${String(pid)}) an earlier copy left running`);
}

function liveThread(threads: FeedThread[], id: string | undefined): FeedThread | undefined {
  const thread = threads.find((x) => x.id === id);
  return thread?.mergedInto === undefined || thread.mergedInto === "" ? thread : liveThread(threads, thread.mergedInto);
}

async function openFeedThreadOf(boardThread: string) {
  const known = state.threads[boardThread];
  if (known === undefined) return undefined;
  const thread = liveThread(await getThreads(), known);
  return thread === undefined || Boolean(thread.resolved) ? undefined : thread.id;
}

async function feedToMaxflow(event: BoardEvent, config: BoardConfig) {
  const text = feedText(event, config);
  const open = await openFeedThreadOf(event.thread);
  if (open !== undefined) {
    const res = await post(`/api/threads/${open}/messages`, { text, feed: true });
    if (!res.ok) throw new Error(`more into ${open} failed: ${res.status} ${await res.text()}`);
    log(`board ${event.id} from ${event.who}: more into ${open}`);
    return;
  }
  const res = await post("/api/threads", { title: feedTitle(event), text, feed: { source: "board", who: event.who, link: boardLink(event) } });
  if (!res.ok) throw new Error(`feed thread failed: ${res.status} ${await res.text()}`);
  const id = dig(await res.json(), ["id"]);
  if (typeof id === "string") state.threads[event.thread] = id;
  log(`board ${event.id} from ${event.who}: feed thread ${String(id)} for the funnel`);
}

async function take(event: BoardEvent, config: BoardConfig) {
  if (state.published !== event.cursor) {
    const res = await post("/api/events", { topic: busTopic(event), data: busData(event, config) });
    if (!res.ok) throw new Error(`publishing ${event.cursor} failed: ${res.status} ${await res.text()}`);
    state.published = event.cursor;
    writeStateJson(STATE_FILE, state);
  }
  if (isFed(event, config)) await feedToMaxflow(event, config);
  state.cursor = event.cursor;
  writeStateJson(STATE_FILE, state);
}

function tailCommand(config: BoardConfig) {
  const from = state.cursor === "" ? [] : ["--after", state.cursor];
  return [...config.cli, "tail", "--json", "--as", config.profile, ...from];
}

async function* linesOf(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    yield* lines;
  }
  if (rest !== "") yield rest;
}

async function tailUntilItEnds(config: BoardConfig) {
  const token = await tokenFor(config);
  const env = { ...process.env, BOARD_URL: config.url, ...(token !== undefined && { BOARD_TOKEN: token }) };
  const proc = Bun.spawn(tailCommand(config), { env, stdout: "pipe", stderr: "pipe", detached: true });
  tail.pid = proc.pid;
  const stderr = new Response(proc.stderr).text();
  writeStateText(TAIL_PID_FILE, String(proc.pid));
  log(`tailing ${config.url} as ${config.profile}${state.cursor === "" ? " from now" : ` after ${state.cursor}`}`);
  const startedAt = Date.now();
  const configAt = configChangedAt();
  const timer = setInterval(() => {
    if (Date.now() - startedAt >= config.restartMs || configChangedAt() !== configAt) stopTail();
  }, CONFIG_CHECK_MS);
  let taken = 0;
  try {
    for await (const line of linesOf(proc.stdout)) {
      const event = boardEventOf(line);
      if (event === undefined) continue;
      await take(event, config);
      taken += 1;
    }
  } finally {
    clearInterval(timer);
    stopTail();
  }
  const code = await proc.exited;
  const err = (await stderr).trim();
  const isRestartedOnPurpose = Date.now() - startedAt >= config.restartMs || configChangedAt() !== configAt;
  if (!isRestartedOnPurpose) log(`tail ended (exit ${String(code)}) after ${String(taken)} events${err === "" ? "" : `: ${err.slice(-300)}`}`);
  return { isHealthy: isRestartedOnPurpose || taken > 0 };
}

function loadState() {
  const saved = readGatingStateJson(STATE_FILE, isBoardState);
  if (saved !== undefined) Object.assign(state, { published: "", ...saved });
}

function seedCursor(value: unknown) {
  if (state.cursor !== "" || !isRecord(value)) return;
  const startAfter = value["startAfter"];
  if (typeof startAfter === "string" && startAfter !== "") state.cursor = startAfter;
}

async function run() {
  let backoff = FIRST_BACKOFF_MS;
  let hasSaidNoConfig = false;
  for (;;) {
    const raw = peekStateJson(CONFIG_FILE);
    const config = boardConfigOf(raw);
    if (config === undefined) {
      if (!hasSaidNoConfig) log(`no board configured: write ${stateDisplayPath(CONFIG_FILE)} ({"url": ..., "tokenCommand": [...], "self": [...]}) and it starts`);
      hasSaidNoConfig = true;
      await Bun.sleep(NO_CONFIG_MS);
      continue;
    }
    hasSaidNoConfig = false;
    seedCursor(raw);
    try {
      const { isHealthy } = await tailUntilItEnds(config);
      if (isHealthy) backoff = FIRST_BACKOFF_MS;
    } catch (error) {
      log(`board tail failed: ${String(error)}`);
    }
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, LONGEST_BACKOFF_MS);
  }
}

if (import.meta.main) {
  takeOver("board");
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => {
      stopTail();
      process.exit(0);
    });
  stopTailLeftByAnEarlierCopy();
  loadState();
  await run();
}
