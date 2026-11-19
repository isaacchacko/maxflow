import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./shared/guards";
import { readStateJson, writeStateJson } from "./state";

const USAGE_STATE = "stats-usage.json";
const PROJECTS = join(homedir(), ".claude", "projects");
const TRANSCRIPT_LOOKBACK_MS = 120 * 86_400_000;
export const ACTIVE_GAP_MS = 5 * 60_000;
const KEPT_MESSAGE_IDS = 30;

export type Tokens = [input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, messages: number];
type DayUsage = { models: Record<string, Tokens>; activeMs: number };
type SessionRouting = { yarn?: string; name?: string; objective?: string; role?: string };
export type FileUsage = SessionRouting & {
  size: number;
  mtime: number;
  offset: number;
  parent?: string;
  cwd?: string;
  first?: number;
  last?: number;
  lastTs?: number;
  // constraint: Claude Code writes one transcript line per content block, each repeating its message's usage, so seen message ids are kept.
  ids: string[];
  days: Record<string, DayUsage>;
};
export type Usage = { at: number; files: Record<string, FileUsage> };

const pacificDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const dayKey = (ms: number) => pacificDay.format(ms);

type Price = [model: RegExp, inputPerMTok: number, outputPerMTok: number, cacheReadPerMTok: number];
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const DEFAULT_PRICE: Price = [/opus-(5|4-[5-9])/, 5, 25, 0.5];
const PRICES_FIRST_MATCH_WINS: Price[] = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  DEFAULT_PRICE,
  [/opus/, 15, 75, 1.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku/, 1, 5, 0.1],
];
const priceOf = (model: string) => PRICES_FIRST_MATCH_WINS.find(([re]) => re.test(model)) ?? DEFAULT_PRICE;

export function cost(model: string, t: Tokens) {
  const [, input, output, cacheRead] = priceOf(model);
  const dollars = (t[0] * input + t[1] * output + t[2] * input * CACHE_WRITE_5M_MULTIPLIER + t[3] * input * CACHE_WRITE_1H_MULTIPLIER + t[4] * cacheRead) / 1e6;
  return { dollars, saved: (t[4] * (input - cacheRead)) / 1e6 };
}

const isUsage = (value: unknown): value is Usage => isRecord(value) && typeof value["at"] === "number" && isRecord(value["files"]);

export function loadUsage(): Usage {
  return readStateJson(USAGE_STATE, isUsage) ?? { at: 0, files: {} };
}

function subagentTranscripts(chatDir: string) {
  const subagents = join(chatDir, "subagents");
  if (!existsSync(subagents)) return [];
  return readdirSync(subagents)
    .filter((s) => s.endsWith(".jsonl"))
    .map((s) => join(subagents, s));
}

function projectTranscripts(dir: string) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.endsWith(".jsonl") ? join(dir, e) : subagentTranscripts(join(dir, e))));
}

function isModifiedSince(path: string, since: number) {
  try {
    return statSync(path).mtimeMs >= since;
  } catch {
    return false;
  }
}

function recentTranscripts() {
  const since = Date.now() - TRANSCRIPT_LOOKBACK_MS;
  return readdirSync(PROJECTS)
    .flatMap((project) => projectTranscripts(join(PROJECTS, project)))
    .filter((p) => isModifiedSince(p, since));
}

// constraint: the SessionStart hook text is JSON-escaped inside the transcript line, so its quotes arrive as \".
const HOOK = /yours is \\"((?:[^\\]|\\.)*?)\\", id ([0-9a-f]{8}), in \$MAXFLOW_SESSION/;
const ROUTING = /you are a (router|worker) on the objective \\"(?:[^\\]|\\.)*?\\" \(([a-z0-9-]+)\)/;

function routingFromHook(line: string): SessionRouting | undefined {
  const hook = HOOK.exec(line);
  if (!hook) return undefined;
  const [, escapedName = "", yarn = ""] = hook;
  const session = { name: escapedName.replaceAll(/\\(.)/g, "$1"), yarn };
  const [, role, objective] = ROUTING.exec(line) ?? [];
  return role === undefined || objective === undefined ? session : { ...session, role, objective };
}

type AssistantMessage = { id: string | undefined; model: string; usage: Record<string, unknown>; timestamp: string; cwd: string | undefined };

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);
const tokenCount = (value: unknown) => (typeof value === "number" ? value : 0);

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const canCarryUsage = (line: string) => line.includes('"usage"') && line.includes('"type":"assistant"');

function assistantMessage(line: string): AssistantMessage | undefined {
  const d = canCarryUsage(line) ? parseJson(line) : undefined;
  const message = isRecord(d) ? d["message"] : undefined;
  if (!isRecord(d) || !isRecord(message) || !isRecord(message["usage"])) return undefined;
  const model = optionalString(message["model"]) ?? "";
  const timestamp = optionalString(d["timestamp"]) ?? "";
  if (model === "" || model === "<synthetic>" || timestamp === "") return undefined;
  const id = optionalString(message["id"]);
  return { id: id === "" ? undefined : id, model, usage: message["usage"], timestamp, cwd: optionalString(d["cwd"]) };
}

function addedTokens(t: Tokens, usage: Record<string, unknown>): Tokens {
  const cacheCreation = isRecord(usage["cache_creation"]) ? usage["cache_creation"] : {};
  const write1h = tokenCount(cacheCreation["ephemeral_1h_input_tokens"]);
  const reported5m = cacheCreation["ephemeral_5m_input_tokens"];
  const write5m = typeof reported5m === "number" ? reported5m : tokenCount(usage["cache_creation_input_tokens"]) - write1h;
  return [
    t[0] + tokenCount(usage["input_tokens"]),
    t[1] + tokenCount(usage["output_tokens"]),
    t[2] + write5m,
    t[3] + write1h,
    t[4] + tokenCount(usage["cache_read_input_tokens"]),
    t[5] + 1,
  ];
}

const activeGap = (lastTs: number | undefined, ts: number) => (lastTs !== undefined && ts > lastTs && ts - lastTs <= ACTIVE_GAP_MS ? ts - lastTs : 0);

function readFromOffset(path: string, offset: number, size: number) {
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  return buf;
}

function talliedDay(day: DayUsage | undefined, m: AssistantMessage, activeMs: number): DayUsage {
  const models = day?.models ?? {};
  return { models: { ...models, [m.model]: addedTokens(models[m.model] ?? [0, 0, 0, 0, 0, 0], m.usage) }, activeMs: (day?.activeMs ?? 0) + activeMs };
}

function spanAfter(f: FileUsage, m: AssistantMessage, ts: number): Partial<FileUsage> {
  return {
    ids: m.id === undefined ? f.ids : [...f.ids.slice(-KEPT_MESSAGE_IDS), m.id],
    lastTs: Math.max(f.lastTs ?? 0, ts),
    first: Math.min(f.first ?? ts, ts),
    last: Math.max(f.last ?? ts, ts),
    ...(f.cwd === undefined && m.cwd !== undefined && { cwd: m.cwd }),
  };
}

const isSeen = (f: FileUsage, m: AssistantMessage) => m.id !== undefined && f.ids.includes(m.id);

function readWholeNewLines(path: string, previous: FileUsage, size: number): FileUsage {
  const buf = readFromOffset(path, previous.offset, size);
  const end = buf.lastIndexOf(10);
  if (end === -1) return previous;
  const f: FileUsage = { ...previous, days: { ...previous.days } };
  const lines = buf.subarray(0, end).toString("utf8").split("\n");
  for (const line of lines) {
    if (f.yarn === undefined && line.includes("$MAXFLOW_SESSION")) Object.assign(f, routingFromHook(line));
    const m = assistantMessage(line);
    if (m === undefined || isSeen(f, m)) continue;
    const ts = Date.parse(m.timestamp);
    const key = dayKey(ts);
    f.days[key] = talliedDay(f.days[key], m, activeGap(f.lastTs, ts));
    Object.assign(f, spanAfter(f, m, ts));
  }
  f.offset += end + 1;
  return f;
}

const emptyFileUsage = (): FileUsage => ({ size: 0, mtime: 0, offset: 0, ids: [], days: {} });
const SUBAGENT_PATH = /^(.*)\/([^/]+)\/subagents\/[^/]+\.jsonl$/;

function scannedFile(path: string, kept: FileUsage | undefined): FileUsage {
  const st = statSync(path);
  const start = kept === undefined || st.size < kept.offset ? emptyFileUsage() : kept;
  if (start.size === st.size && start.mtime === st.mtimeMs) return start;
  let read = start;
  try {
    read = readWholeNewLines(path, start, st.size);
  } catch (error) {
    console.error(`usage: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sub = SUBAGENT_PATH.exec(path);
  return { ...read, size: st.size, mtime: st.mtimeMs, ...(sub && { parent: `${sub[1] ?? ""}/${sub[2] ?? ""}.jsonl` }) };
}

export function scanNewTranscriptLines() {
  const usage = loadUsage();
  const scanned = new Map(recentTranscripts().map((path) => [path, scannedFile(path, usage.files[path])]));
  const files = Object.fromEntries(Object.entries(usage.files).filter(([path]) => scanned.has(path)));
  for (const [path, file] of scanned) files[path] = file;
  writeStateJson(USAGE_STATE, { ...usage, at: Date.now(), files });
}

if (import.meta.main) {
  const started = Date.now();
  scanNewTranscriptLines();
  console.log(`usage: scanned in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
