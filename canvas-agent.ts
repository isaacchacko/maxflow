import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { canvasPath, type Change, ISAAC, onCanvasChange, readCanvas } from "./canvas";
import { diffOf, type Snapshot, snapshotOf } from "./canvas-look";
import { DOCS_DIR } from "./docs";
import { CLI, DIR } from "./instance";
import { createSession, dispatch, setArchived } from "./lifecycle";
import { type Session, sessions } from "./sessions";
import { readStateJson, writeStateJson } from "./state";

const IDLE_MS = Number(process.env["CANVAS_IDLE_MS"] ?? 20_000);
const OPEN_MS = 30_000;
const CLOSE_CHECK_MS = 10_000;
const HOUR_MS = 3_600_000;
const LOOKS_PER_HOUR = 12;
const PER_LOOK = { box: 3, proposal: 2 } as const;
const STATE_FILE = "canvas-agents.json";
const BRIEF = join(DIR, "agents/canvas.md");

type Spend = keyof typeof PER_LOOK;
type Look = { snapshot: Snapshot; events: string[]; spent: Record<Spend, number>; lookedAt: number[] };

const isAgentMap = (value: unknown): value is Record<string, string> => typeof value === "object" && value !== null && Object.values(value).every((id) => typeof id === "string");
const agents: Record<string, string> = readStateJson(STATE_FILE, isAgentMap) ?? {};
const openUntil = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const looks = new Map<string, Look>();

const log = (line: string) => console.log(`canvas agent: ${line}`);
const isOpen = (path: string) => (openUntil.get(path) ?? 0) > Date.now();
const short = (text: string) => JSON.stringify(text.length > 120 ? `${text.slice(0, 119)}…` : text);

function lookAt(path: string): Look {
  const was = looks.get(path);
  if (was) return was;
  const look = { snapshot: {}, events: [], spent: { box: 0, proposal: 0 }, lookedAt: [] };
  looks.set(path, look);
  return look;
}

export function agentOf(path: string): Session | undefined {
  const id = agents[canvasPath(path)];
  const s = id === undefined ? undefined : sessions.get(id);
  return s?.exitCode === null ? s : undefined;
}

export function chargeAgent(path: string, author: string, spend: Spend) {
  if (author !== agentOf(path)?.id) return;
  const look = lookAt(canvasPath(path));
  if (look.spent[spend] >= PER_LOOK[spend]) throw new Error(`your budget for this look is spent (${PER_LOOK.box} new boxes, ${PER_LOOK.proposal} proposals): stop here and end your turn`);
  look.spent[spend] += 1;
}

function brief(path: string, lines: string[], events: string[], why: string) {
  const said = [...events.map((e) => `* ${e}`), ...lines].join("\n");
  const asked = why === "asked" ? "Isaac asked you to look now (he pressed ⌘S)." : "Isaac has been idle for a while after editing.";
  return `[yarn canvas] ${path} changed since your last look. ${asked}
${said === "" ? "(no box changed)" : said}

\`${CLI} canvas show "${path}"\` prints every box. Budget for this look: ${PER_LOOK.box} new boxes, ${PER_LOOK.proposal} proposals. Doing nothing is a fine answer. End your turn with \`${CLI} wait done\`.`;
}

function spawned(path: string, text: string) {
  const session = createSession(`canvas: ${basename(path, ".canvas")}`, ["claude", "--permission-mode", "bypassPermissions", "--append-system-prompt", readFileSync(BRIEF, "utf8"), text], DOCS_DIR);
  agents[path] = session.id;
  writeStateJson(STATE_FILE, agents);
  log(`started ${session.id} for ${path}`);
}

const lastHour = (look: Look) => look.lookedAt.filter((t) => Date.now() - t < HOUR_MS);

export function didWake(asked: string, why: "idle" | "asked") {
  const path = canvasPath(asked);
  timers.delete(path);
  if (!isOpen(path)) return false;
  const look = lookAt(path);
  const { nodes } = readCanvas(path).canvas;
  const lines = diffOf(look.snapshot, nodes);
  const isNothingNew = lines.length === 0 && look.events.length === 0;
  const recent = lastHour(look);
  if ((isNothingNew && why === "idle") || recent.length >= LOOKS_PER_HOUR) return false;
  const text = brief(path, lines, look.events, why);
  Object.assign(look, { snapshot: snapshotOf(nodes), events: [], spent: { box: 0, proposal: 0 }, lookedAt: [...recent, Date.now()] });
  const agent = agentOf(path);
  if (agent) dispatch({ to: [agent], target: `canvas ${basename(path)}`, text });
  else spawned(path, text);
  return true;
}

function keepOwnChangesOutOfTheDiff(path: string, change: Change) {
  const look = lookAt(path);
  const node = readCanvas(path).canvas.nodes.find((n) => n.id === change.id);
  if (node) look.snapshot[node.id] = { text: node.text, x: node.x, y: node.y };
  else Reflect.deleteProperty(look.snapshot, change.id);
}

function noted(path: string, change: Change) {
  if (change.kind === "accept" || change.kind === "reject") lookAt(path).events.push(`isaac ${change.kind}ed your proposal on ${change.id}: ${short(change.proposal?.text ?? "")}`);
}

onCanvasChange((path, _rev, change) => {
  if (change.author === agentOf(path)?.id) {
    keepOwnChangesOutOfTheDiff(path, change);
    return;
  }
  noted(path, change);
  if (change.author !== ISAAC || !isOpen(path)) return;
  clearTimeout(timers.get(path));
  timers.set(
    path,
    setTimeout(() => didWake(path, "idle"), IDLE_MS),
  );
});

export function markOpen(path: string) {
  openUntil.set(canvasPath(path), Date.now() + OPEN_MS);
}

export function agentStatus(path: string) {
  const s = agentOf(path);
  if (!s) return;
  return { id: s.id, name: s.name, isWorking: s.claude?.state === "working" };
}

function sleepClosed() {
  for (const [path, until] of openUntil) {
    if (until > Date.now()) continue;
    openUntil.delete(path);
    clearTimeout(timers.get(path));
    const s = agentOf(path);
    if (!s || s.archived === true) continue;
    setArchived(s, true);
    log(`${path} closed: ${s.id} sleeps`);
  }
}

setInterval(sleepClosed, CLOSE_CHECK_MS);
