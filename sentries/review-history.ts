import { isRecord } from "../shared/guards";
import { readStateJson, writeStateJson } from "../state";

export const HISTORY_FILE = "pr-history.json";
const DAY_MS = 24 * 3_600_000;
const ENDED_KEPT_MS = 14 * DAY_MS;
const CLOSED_LOOKBACK_MS = 3 * DAY_MS;

type SessionOn = { id: string; name: string | undefined };
type Move = { at: string; stage: string };
type Ended = { state: "merged" | "closed"; at: string };
type PrHistory = { url: string; title: string; created: string; moves: Move[]; sessions: SessionOn[]; ended?: Ended };
type Open = { pr: string; url: string; title: string; stage: string; created: string; sessions: SessionOn[] };
type Closed = { number: number; url: string; title: string; createdAt: string; closedAt: string; mergedAt: string | null; repository: { nameWithOwner: string } };

const isHistory = (value: unknown): value is Record<string, PrHistory> => isRecord(value);
const isClosed = (value: unknown): value is Closed => isRecord(value) && typeof value["number"] === "number" && typeof value["closedAt"] === "string";

function closedLately(): Closed[] {
  const since = new Date(Date.now() - CLOSED_LOOKBACK_MS).toISOString().slice(0, 10);
  const q = `query { search(query: "is:pr is:closed author:@me archived:false closed:>=${since}", type: ISSUE, first: 100) { nodes { ... on PullRequest {
    number url title createdAt closedAt mergedAt repository { nameWithOwner } } } } }`;
  const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${q}`], { stderr: "pipe" });
  if (r.exitCode !== 0) return [];
  const answer: unknown = JSON.parse(r.stdout.toString());
  const data = isRecord(answer) && isRecord(answer["data"]) && isRecord(answer["data"]["search"]) ? answer["data"]["search"]["nodes"] : [];
  return Array.isArray(data) ? data.filter(isClosed) : [];
}

const keyOf = (pr: Closed) => `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase();

function mergeSessions(was: SessionOn[], now: SessionOn[]) {
  const byId = new Map(was.map((s) => [s.id, s]));
  for (const s of now) byId.set(s.id, s);
  return byId.values().toArray();
}

function recordOpen(history: Map<string, PrHistory>, q: Open, at: string) {
  const entry = history.get(q.pr) ?? { url: q.url, title: q.title, created: q.created, moves: [], sessions: [] };
  history.set(q.pr, entry);
  delete entry.ended;
  entry.title = q.title;
  entry.sessions = mergeSessions(entry.sessions, q.sessions);
  if (entry.moves.at(-1)?.stage !== q.stage) entry.moves.push({ at, stage: q.stage });
}

function recordClosed(history: Map<string, PrHistory>, pr: Closed) {
  const key = keyOf(pr);
  const entry = history.get(key) ?? { url: pr.url, title: pr.title, created: pr.createdAt, moves: [], sessions: [] };
  history.set(key, entry);
  if (entry.ended) return;
  const ended: Ended = pr.mergedAt === null ? { state: "closed", at: pr.closedAt } : { state: "merged", at: pr.mergedAt };
  entry.ended = ended;
  entry.moves.push({ at: ended.at, stage: ended.state });
}

const isLongEnded = (entry: PrHistory) => entry.ended !== undefined && Date.now() - Date.parse(entry.ended.at) > ENDED_KEPT_MS;

export function recordHistory(queue: Open[]) {
  const history = new Map(Object.entries(readStateJson(HISTORY_FILE, isHistory) ?? {}));
  const at = new Date().toISOString();
  const open = new Set(queue.map((q) => q.pr));
  for (const q of queue) recordOpen(history, q, at);
  for (const pr of closedLately()) if (!open.has(keyOf(pr))) recordClosed(history, pr);
  for (const [key, entry] of history) if (isLongEnded(entry)) history.delete(key);
  writeStateJson(HISTORY_FILE, Object.fromEntries(history));
}
