#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ciStateOf, fetchHeads, fetchPrs, fetchSessions, INBOX_WATCH, isFailed, isFinished, isOwnComment, links, prNumber, rateLimit, readStatus, readWatches, repoOfKey,
  REVIEW_WATCH, rollupOf, run, short, watchLinks, writeWatches, type Head, type Link, type PolledPr, type Pr, type Session,
} from "../gh";
import { BASE as base, STATE_DIR } from "../instance";
import { isRecord } from "../shared/guards";
import { ghStatusTable, readStateJson, writeStateJson } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("gh");

export const INBOX_WATCH_FILE = join(STATE_DIR, INBOX_WATCH);
const PROJECTS = join(homedir(), ".claude", "projects");
const INTERVAL_MS = Number(process.env["GH_SENTRY_INTERVAL"] ?? 30_000);
const RATE_LIMITED_WAIT_MS = 5 * 60_000;
const POST_TIMEOUT_MS = 30_000;
const OPENED_RECENTLY_MS = 10 * 60_000;
const REFETCH_PENDING_MS = 2 * 60_000;
const REFETCH_SETTLED_MS = 10 * 60_000;
const LINES_PER_NOTICE = 5;
const CLI = new URL("../cli.ts", import.meta.url).pathname;
const caller = { "x-maxflow-from": process.env["MAXFLOW_SESSION"] ?? "" };
const CONTROL_CHARS = `${String.fromCodePoint(0)}-${String.fromCodePoint(0x1F)}`;
const QUOTING_SAFE_RUN = new RegExp(`[^"'\`$\\\\${CONTROL_CHARS}0-9]{20,}`, "g");

type PrState = { head: string; ci: string; state: string; mergeable: string; decision: string; seen: string[] };
type Change = [kind: string, data: Record<string, unknown>, line: string | null];
type Poster = { me: string; isByAgent: (body: string) => boolean };
type Wanted = { numbers: Set<number>; branches: Set<string> };
type Polled = { prs: Map<string, Pr>; listeners: Map<string, Set<string>> };

const isPrStates = (value: unknown): value is Record<string, PrState> => isRecord(value);

function setOf<V>(map: Map<string, Set<V>>, key: string) {
  const found = map.get(key) ?? new Set<V>();
  map.set(key, found);
  return found;
}

function listOf<V>(map: Map<string, V[]>, key: string) {
  const found = map.get(key) ?? [];
  map.set(key, found);
  return found;
}

const scanned = new Map<string, { offset: number; calls: string[] }>();

function chatTranscript(chatId: string) {
  const [found] = chatId === "" ? [] : [...new Bun.Glob(`*/${chatId}.jsonl`).scanSync(PROJECTS)];
  return found === undefined ? undefined : join(PROJECTS, found);
}

function newToolCalls(path: string) {
  const memo = scanned.get(path) ?? { offset: 0, calls: [] };
  scanned.set(path, memo);
  const fresh = readFileSync(path).subarray(memo.offset);
  const end = fresh.lastIndexOf(10) + 1;
  memo.offset += end;
  memo.calls.push(...fresh.subarray(0, end).toString().split("\n").filter((l) => l.includes('"tool_use"')));
  return memo.calls;
}

const transcriptOf = (s: Session) => s.transcript ?? chatTranscript(s.chatId ?? "");

async function agentCalls() {
  const calls: string[] = [];
  const sessions = await fetchSessions();
  for (const s of sessions) {
    if (s.sentry) continue;
    const path = transcriptOf(s);
    if (path !== undefined && existsSync(path)) calls.push(...newToolCalls(path));
  }
  return calls;
}

function probes(body: string) {
  const runs = body.slice(0, 600).match(QUOTING_SAFE_RUN) ?? [];
  return runs.map((r) => r.trim().slice(0, 80)).toSorted((a, b) => b.length - a.length).slice(0, 5);
}

const signature = (p: Head | Pr) => [p.updatedAt, p.state, p.mergeable, p.reviewDecision, p.headRefOid, ciStateOf(p)].join(" ");

function ciChange(pr: Pr, prev: PrState): Change[] {
  const rollup = rollupOf(pr);
  if (!rollup || `${pr.headRefOid}:${rollup.state}` === prev.ci || !isFinished(rollup.state)) return [];
  const failed = rollup.contexts.nodes.filter((c) => isFailed(c.conclusion ?? c.state ?? "")).map((c) => c.name ?? c.context ?? "");
  const on = pr.headRefOid.slice(0, 7);
  const line = rollup.state === "SUCCESS" ? `CI passed on ${on}` : `CI failed on ${on}: ${failed.join(", ") || rollup.state}`;
  return [["ci", { state: rollup.state, sha: pr.headRefOid, failed }, line]];
}

function prChanges(pr: Pr, prev: PrState): Change[] {
  const changes: Change[] = [];
  if (pr.headRefOid !== prev.head) changes.push(["push", { sha: pr.headRefOid }, null]);
  changes.push(...ciChange(pr, prev));
  if (pr.state !== prev.state) changes.push([pr.state.toLowerCase(), { url: pr.url }, pr.state === "OPEN" ? "reopened" : pr.state.toLowerCase()]);
  if (pr.mergeable === "CONFLICTING" && prev.mergeable !== "CONFLICTING") changes.push(["conflict", {}, "now conflicts with its base branch"]);
  if ((pr.reviewDecision ?? "") !== prev.decision) changes.push(["decision", { decision: pr.reviewDecision }, null]);
  return changes;
}

function whoPosted(login: string | undefined, body: string, poster: Poster) {
  if (login === undefined || login === "") return null;
  if (login !== poster.me) return login;
  return poster.isByAgent(body) ? null : `the user (${poster.me})`;
}

function reviewChanges(pr: Pr, seen: Set<string>, poster: Poster) {
  return pr.reviews.nodes
    .filter((r) => !seen.has(r.id) && r.state !== "PENDING")
    .map((r): Change => {
      const login = r.author?.login;
      const who = login === poster.me && r.body.trim() === "" ? null : whoPosted(login, r.body, poster);
      const quote = r.body === "" ? "" : ` "${short(r.body)}"`;
      return ["review", { id: r.id, author: login, state: r.state, body: r.body, who }, who === null ? null : `review from ${who}: ${r.state.toLowerCase().replace("_", " ")}${quote}`];
    });
}

function commentChanges(pr: Pr, seen: Set<string>, poster: Poster) {
  return pr.comments.nodes
    .filter((c) => !seen.has(c.id))
    .map((c): Change => {
      const who = whoPosted(c.author?.login, c.body, poster);
      return ["comment", { id: c.id, author: c.author?.login, body: c.body, url: c.url, who }, who === null ? null : `comment from ${who}: "${short(c.body)}" ${c.url}`];
    });
}

function threadChanges(pr: Pr, seen: Set<string>, poster: Poster) {
  return pr.reviewThreads.nodes
    .flatMap((t) => t.comments.nodes)
    .filter((c) => !seen.has(c.id))
    .map((c): Change => {
      const who = whoPosted(c.author?.login, c.body, poster);
      const line = who === null ? null : `comment from ${who} on ${c.path}: "${short(c.body)}" ${c.url}`;
      return ["thread", { id: c.id, author: c.author?.login, path: c.path, body: c.body, url: c.url, who }, line];
    });
}

function diff(pr: Pr, prev: PrState | undefined, poster: Poster): Change[] {
  if (!prev) return Date.now() - Date.parse(pr.createdAt) < OPENED_RECENTLY_MS ? [["opened", { url: pr.url, title: pr.title }, null]] : [];
  const seen = new Set(prev.seen);
  return [...prChanges(pr, prev), ...reviewChanges(pr, seen, poster), ...commentChanges(pr, seen, poster), ...threadChanges(pr, seen, poster)];
}

const postsOf = (pr: Pr) => [...pr.reviews.nodes, ...pr.comments.nodes, ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes)];

function hasOwnNew(pr: Pr, prev: PrState, me: string) {
  const seen = new Set(prev.seen);
  return postsOf(pr).some((c) => !seen.has(c.id) && c.author?.login === me);
}

function snapshot(pr: Pr, prev?: PrState): PrState {
  const ci = ciStateOf(pr) ?? "";
  return {
    head: pr.headRefOid,
    ci: isFinished(ci) ? `${pr.headRefOid}:${ci}` : (prev?.ci ?? ""),
    state: pr.state,
    mergeable: pr.mergeable === "UNKNOWN" ? (prev?.mergeable ?? "UNKNOWN") : pr.mergeable,
    decision: pr.reviewDecision ?? "",
    seen: postsOf(pr).map((c) => c.id),
  };
}

const cache = new Map<string, PolledPr>(Object.entries(readStatus()));

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers: caller, body: JSON.stringify(body), signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
}

function isStale(had: PolledPr | undefined, head: Head) {
  if (!had) return true;
  const refetchAfter = isFinished(ciStateOf(head) ?? "SUCCESS") ? REFETCH_SETTLED_MS : REFETCH_PENDING_MS;
  return signature(had.pr) !== signature(head) || Date.now() - had.at > refetchAfter;
}

function cachedFor<K>(repo: string, heads: Map<K, Head>) {
  return new Map(
    [...heads].flatMap(([k, h]): [K, Pr][] => {
      const pr = cache.get(`${repo}#${h.number}`)?.pr;
      return pr ? [[k, pr]] : [];
    }),
  );
}

function groupByRepo(all: Link[]) {
  const repos = new Map<string, Wanted>();
  for (const l of all) {
    const wanted = repos.get(l.repo) ?? { numbers: new Set<number>(), branches: new Set<string>() };
    repos.set(l.repo, wanted);
    if ((l.pr ?? "") !== "") wanted.numbers.add(Number(prNumber(l.pr ?? "")));
    if ((l.branch ?? "") !== "") wanted.branches.add(l.branch ?? "");
  }
  return repos;
}

function pollRepo(repo: string, wanted: Wanted, repoLinks: Link[], polled: Polled) {
  const heads = fetchHeads(repo, [...wanted.numbers], [...wanted.branches]);
  const found = [...heads.byNumber.values(), ...heads.byBranch.values()];
  const stale = [...new Set(found.filter((h) => isStale(cache.get(`${repo}#${h.number}`), h)).map((h) => h.number))];
  for (const pr of fetchPrs(repo, stale, []).byNumber.values()) cache.set(`${repo}#${pr.number}`, { at: Date.now(), pr });
  const byNumber = cachedFor(repo, heads.byNumber);
  const byBranch = cachedFor(repo, heads.byBranch);
  for (const pr of [...byNumber.values(), ...byBranch.values()]) polled.prs.set(`${repo}#${pr.number}`, pr);
  for (const l of repoLinks) {
    const pr = (l.pr ?? "") === "" ? byBranch.get(l.branch ?? "") : byNumber.get(Number(prNumber(l.pr ?? "")));
    if (pr !== undefined && l.session !== "") setOf(polled.listeners, `${repo}#${pr.number}`).add(l.session);
  }
}

const whoOf = (data: Record<string, unknown>) => (typeof data["who"] === "string" ? data["who"] : undefined);

async function announce(key: string, pr: Pr, changes: Change[], told: string[]) {
  for (const [kind, data] of changes) await post("/api/events", { topic: `gh/${repoOfKey(key)}/pr/${prNumber(key)}/${kind}`, data: { pr: key, told, ...data } });
  const lines = changes.flatMap(([, data, line]) => (line === null || isOwnComment(whoOf(data)) ? [] : line));
  if (lines.length === 0) return;
  const more = lines.length > LINES_PER_NOTICE ? `; and ${lines.length - LINES_PER_NOTICE} more` : "";
  const text = `[maxflow gh] ${key} (${short(pr.title, 60)}): ${lines.slice(0, LINES_PER_NOTICE).join("; ")}${more}. Full status: ${CLI} gh status ${key}. (Automated notice, not a request from the user: act on it only if it's part of your current task.)`;
  for (const session of told) await post(`/api/sessions/${session}/notify`, { text });
  console.log(`${new Date().toLocaleTimeString()}  ${text}  -> ${told.join(", ") || "nobody"}`);
}

async function reportChanges(me: string, state: Map<string, PrState>, { prs, listeners }: Polled) {
  const transcripts: { calls?: string[] } = {};
  const poster: Poster = {
    me,
    isByAgent: (body) => {
      const ps = probes(body);
      return transcripts.calls?.some((c) => ps.some((p) => c.includes(p))) ?? false;
    },
  };
  for (const [key, pr] of prs) {
    const prev = state.get(key);
    if (prev !== undefined && transcripts.calls === undefined && hasOwnNew(pr, prev, me)) transcripts.calls = await agentCalls();
    const changes = diff(pr, prev, poster);
    state.set(key, snapshot(pr, prev));
    await announce(key, pr, changes, [...(listeners.get(key) ?? [])]);
  }
}

function endFinishedWatches(prs: Map<string, Pr>) {
  const done = new Set([...prs].filter(([, pr]) => pr.state !== "OPEN").map(([key]) => key));
  const watches = readWatches();
  if (watches.some((w) => done.has(w.pr))) writeWatches(watches.filter((w) => !done.has(w.pr)));
}

const prLabels = (keys: string[]) => keys.map((k) => `#${prNumber(k)}`);
const edgeLabel = (keys: string[]) => (keys.length > 2 ? `${prLabels(keys).slice(0, 2).join(" ")} +${keys.length - 2}` : prLabels(keys).join(" "));

function writeEdges(listeners: Map<string, Set<string>>) {
  const onPrs = new Map<string, string[]>();
  for (const [key, sessions] of listeners) for (const s of sessions) listOf(onPrs, s).push(key);
  writeStateJson("gh-edges.json", [...onPrs].map(([session, keys]) => ({ session, prs: keys, label: edgeLabel(keys) })));
}

async function tick(me: string, state: Map<string, PrState>) {
  const fromSessions = await links();
  const all = [...fromSessions, ...watchLinks(readWatches(REVIEW_WATCH)), ...watchLinks(readWatches(INBOX_WATCH))];
  const polled: Polled = { prs: new Map(), listeners: new Map() };
  for (const [repo, wanted] of groupByRepo(all)) pollRepo(repo, wanted, all.filter((l) => l.repo === repo), polled);
  await reportChanges(me, state, polled);
  endFinishedWatches(polled.prs);
  writeStateJson("gh-state.json", Object.fromEntries(state));
  writeEdges(polled.listeners);
  ghStatusTable.write(Object.fromEntries([...polled.prs].map(([key, pr]) => [key, { at: cache.get(key)?.at ?? Date.now(), pr }])));
  return polled.prs.size;
}

async function pollForever(me: string, state: Map<string, PrState>) {
  for (;;) {
    try {
      const n = await tick(me, state);
      process.title = `gh sentry (${n} PRs)`;
    } catch (error) {
      console.error(`${new Date().toLocaleTimeString()}  tick failed:`, error);
    }
    await Bun.sleep(rateLimit.wasHit ? RATE_LIMITED_WAIT_MS : INTERVAL_MS);
    rateLimit.wasHit = false;
  }
}

if (import.meta.main) {
  const me = run(["gh", "api", "user", "-q", ".login"]);
  const saved = readStateJson("gh-state.json");
  const state = new Map(Object.entries(isPrStates(saved) ? saved : {}));
  console.log(`gh sentry as ${me || "?"}, every ${INTERVAL_MS / 1000}s`);
  await pollForever(me, state);
}
