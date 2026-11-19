#!/usr/bin/env bun
import { BASE as base } from "../instance";
import { readStateJson, stateDirectory, writeStateJson } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("rename");

const STATE_FILE = "rename-state.json";
const INTERVAL_MS = Number(process.env["RENAME_INTERVAL"] ?? 20_000);
const FIRST_CHARS = Number(process.env["RENAME_FIRST_CHARS"] ?? 400);
const EVERY_CHARS = Number(process.env["RENAME_EVERY_CHARS"] ?? 4000);
const MODEL = process.env["RENAME_MODEL"] ?? "haiku";
const API_TIMEOUT_MS = 30_000;
const HEADERS_SO_THE_GRAPH_DRAWS_THIS_SENTRY = { "x-maxflow-from": process.env["MAXFLOW_SESSION"] ?? "" };

const SYSTEM = `You title terminal sessions in a sidebar. Given a session's recent screen, reply with only its title: 3 to 7 words naming the topic the session owns, e.g. "PRO-6201 safety stock dismissals" or "maxflow gh sentry". Name the ticket, PR, bug or feature when the screen shows one. Write a noun phrase, not a verb phrase ("stalled CI on PRs 12194, 12192", not "Kicking stalled CI"). Never describe status, progress or the current step: no "fixing", "waiting on CI", "testing", "done". If the current title still names the right topic, reply with it unchanged. No quotes, no trailing period. If the screen shows no work yet (only a startup banner, an empty prompt, a bare shell), reply SKIP.`;

type Session = { id: string; name: string; cmd: string[]; cwd: string; running: boolean; sentry: boolean };
type Mark = { lastSet?: string; pinned?: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMarks(value: unknown): value is Record<string, Mark> {
  return isObject(value) && Object.values(value).every((mark) => isObject(mark));
}

function isSessionList(value: unknown): value is Session[] {
  return Array.isArray(value) && value.every((s) => isObject(s) && typeof s["id"] === "string" && Array.isArray(s["cmd"]));
}

function readMarks() {
  return new Map(Object.entries(readStateJson(STATE_FILE, isMarks) ?? {}));
}

const marks = readMarks();
const linesAtLastRename = new Map<string, Set<string>>();

async function screenLines(id: string) {
  const res = await fetch(`${base}/api/sessions/${id}/screen?history=300`, { headers: HEADERS_SO_THE_GRAPH_DRAWS_THIS_SENTRY, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  const body: unknown = await res.json();
  const screen = isObject(body) ? body["screen"] : undefined;
  if (typeof screen !== "string") throw new TypeError(`session ${id}'s screen came back without text`);
  return screen
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function title(s: Session, lines: string[]) {
  const screen = lines.join("\n").slice(-8000);
  const input = `Command: ${s.cmd.join(" ")}\nFolder: ${s.cwd}\nCurrent title: ${s.name}\n\nScreen:\n${screen}`;
  const proc = Bun.spawn(
    ["claude", "-p", "--model", MODEL, "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", SYSTEM],
    { cwd: stateDirectory("."), stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error(`claude exited ${String(proc.exitCode)}: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  return (out.split("\n", 1)[0] ?? "").replaceAll(/^["'`]+|["'`.]+$/g, "").trim().slice(0, 60);
}

async function runningSessions() {
  const body: unknown = await (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) })).json();
  if (!isSessionList(body)) throw new TypeError("/api/sessions did not return a list of sessions");
  return body.filter((s) => s.running && !s.sentry);
}

function countOnlyTextArrivingAfterARestart(s: Session, mark: Mark, lines: string[]) {
  if (!linesAtLastRename.has(s.id) && mark.lastSet !== undefined && mark.lastSet !== "") linesAtLastRename.set(s.id, new Set(lines));
}

function newChars(id: string, lines: string[]) {
  const before = linesAtLastRename.get(id) ?? new Set();
  return lines.filter((l) => !before.has(l)).reduce((n, l) => n + l.length, 0);
}

async function retitle(s: Session, mark: Mark): Promise<Mark> {
  const hasTitled = mark.lastSet !== undefined && mark.lastSet !== "";
  const isRenamedByHand = hasTitled && s.name !== mark.lastSet;
  if (isRenamedByHand || mark.pinned === true) return { ...mark, pinned: true };
  const lines = await screenLines(s.id);
  countOnlyTextArrivingAfterARestart(s, mark, lines);
  if (newChars(s.id, lines) < (hasTitled ? EVERY_CHARS : FIRST_CHARS)) return mark;
  const name = await title(s, lines);
  linesAtLastRename.set(s.id, new Set(lines));
  if (["", "SKIP", s.name].includes(name)) return mark;
  await fetch(`${base}/api/sessions/${s.id}`, { method: "PATCH", headers: HEADERS_SO_THE_GRAPH_DRAWS_THIS_SENTRY, body: JSON.stringify({ name }), signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  console.log(`${new Date().toLocaleTimeString()}  ${s.id}  ${s.name}  ->  ${name}`);
  return { ...mark, lastSet: name };
}

async function tick() {
  const sessions = await runningSessions();
  for (const id of marks.keys()) if (sessions.every((s) => s.id !== id)) marks.delete(id);
  for (const s of sessions) {
    const mark = marks.get(s.id) ?? {};
    marks.set(s.id, mark);
    marks.set(s.id, await retitle(s, mark));
  }
  writeStateJson(STATE_FILE, Object.fromEntries(marks));
}

console.log(`rename sentry: first title after ${FIRST_CHARS} new chars, then every ${EVERY_CHARS}, via ${MODEL}`);
for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, error);
  }
  await Bun.sleep(INTERVAL_MS);
}
