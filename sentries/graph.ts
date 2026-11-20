#!/usr/bin/env bun
import { join } from "node:path";
import { BASE as base } from "../instance";
import { isRecord, stringOr } from "../shared/guards";
import { readStateJson, stateDirectory, writeStateJson } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("graph");

const LINKS_FILE = "graph-links.json";
const INTERVAL_MS = Number(process.env["GRAPH_INTERVAL"] ?? 15_000);
const GROUPS_FILE = "graph-groups.json";
const GROUP_EVERY_MS = Number(process.env["GRAPH_GROUP_EVERY"] ?? 120_000);
const ROLES_FILE = "graph-roles.json";
const ROLES = new Set(["review", "implement", "conflicts"]);
const MODEL = process.env["GRAPH_MODEL"] ?? "haiku";
const SENTRY_GROUP = "yarn sentries";
const YARN_GROUP = "yarn development";
const YARN_DIR = join(import.meta.dir, "..");
const FETCH_MS = 30_000;

const SYSTEM = `You curate a graph of an engineer's terminal and Claude agent sessions. Each URL a session mentions can become a clickable node beside it, and most mentions are noise. Keep a URL only if the engineer would want to click it from the graph:
- something the agent made or changed and is pointing them to: a PR, issue or ticket it opened, a deploy or preview, a page, doc or artifact it published, a dashboard or run it started
- a local dev server or app the session is running for them to open
- a link the engineer gave the agent as the subject of the work (the ticket, PR or page to fix)
Drop URLs that are incidental: inside code, config, shell commands, logs or stack traces; library, CDN, package, API or docs references; example or placeholder URLs; asset or API endpoints; links to yarn itself (localhost:$YARN_PORT); anything mentioned only in passing. Drop when unsure.
Some candidates are GitHub PRs the text named by number (#123, PR 123, owner/repo#123) rather than linked; judge them the same way, keeping a PR that is the subject or product of the work. Each candidate comes with who wrote it (user, assistant, or screen for a plain terminal) and the text around it. Reply with only JSON: {"keep": ["<url>", ...]}, listing URLs exactly as given.`;

const GROUP_SYSTEM = `You group an engineer's running terminal and Claude agent sessions by the work they share, so a graph can draw related sessions close together. Sessions belong together when they work on the same project, feature, bug, ticket or PR; a shared folder alone is weak evidence when the titles point at unrelated work. Title each group the way a sidebar titles a session: 3 to 7 words naming the topic the group owns, e.g. "PRO-6201 safety stock dismissals" or "yarn graph view". Name the ticket, PR, bug or feature when the sessions show one. Write a noun phrase, not a verb phrase. Never describe status, progress or the current step: no "fixing", "waiting on CI", "testing", "done". No quotes, no trailing period. Keep a group's existing title when it still names the right topic, so groups stay stable. Every session working on yarn itself (the terminal and agent dashboard these sessions run in: its graph, sidebar, sentries, server or UI) goes in the one group "${YARN_GROUP}", never split by feature. A session unrelated to all others gets a group of its own. Reply with only JSON: {"<session id>": "<group name>", ...}, covering every session.`;

const ROLE_SYSTEM = `You name the role of each of an engineer's Claude agent sessions from its title, folder and first prompt. Roles:
- "review": reviewing someone's PR or diff, leaving or answering review comments, style passes, approving
- "implement": building a feature or fixing a bug, writing the code and driving its PR
- "conflicts": resolving merge or rebase conflicts on a branch or PR
- null: anything else (orchestrating other agents, research, diagnosing without fixing, ops, questions, chat)
Pick null when unsure. Reply with only JSON: {"<session id>": "<role>" | null, ...}, covering every session.`;

type Session = { id: string; name: string; cmd: string[]; cwd: string; running: boolean; agent: boolean; links: string[]; group: string | null; sentry: boolean };
type Candidate = { url: string; role: string; context: string };
type Entry = { id: string; name: string; cwd: string; running: boolean; candidates: Candidate[] };

const isSession = (value: unknown): value is Session =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && typeof value["cwd"] === "string" && Array.isArray(value["cmd"]) && Array.isArray(value["links"]);
const isEntry = (value: unknown): value is Entry =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && Array.isArray(value["candidates"]);

function recordOf<T>(value: unknown, isItem: (item: unknown) => item is T): Record<string, T> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, T] => isItem(entry[1]))) : {};
}
const isString = (value: unknown): value is string => typeof value === "string";
const isRole = (value: unknown): value is string | null => value === null || typeof value === "string";
const isVerdicts = (value: unknown): value is Record<string, boolean> => isRecord(value) && Object.values(value).every((v) => typeof v === "boolean");

const kept = {
  verdicts: recordOf(readStateJson(LINKS_FILE, isRecord), isVerdicts),
  groups: recordOf(readStateJson(GROUPS_FILE, isRecord), isString),
  roles: recordOf(readStateJson(ROLES_FILE, isRecord), isRole),
};
const rolesJudgedUnderTitle: Record<string, string> = {};
const grouping = { key: "", at: 0 };
const NEUTRAL_CWD = stateDirectory(".");

async function askHaikuForJson(system: string, input: string): Promise<unknown> {
  const proc = Bun.spawn(
    ["claude", "-p", "--model", MODEL, "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", system],
    { cwd: NEUTRAL_CWD, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error(`claude exited ${String(proc.exitCode)}: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
}

async function getJson(path: string): Promise<unknown> {
  return (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(FETCH_MS) })).json();
}
const fetchSessions = async () => {
  const sessions = await getJson("/api/sessions");
  return Array.isArray(sessions) ? sessions.filter(isSession) : [];
};

async function judge(s: Entry, fresh: Candidate[]) {
  const list = fresh.map((c, i) => `${i + 1}. ${c.url}\n   from ${c.role}: "${c.context}"`).join("\n");
  const reply = await askHaikuForJson(SYSTEM, `Session: ${s.name}\nFolder: ${s.cwd}\n\nCandidates:\n${list}`);
  const keep = isRecord(reply) ? reply["keep"] : undefined;
  return new Set<unknown>(Array.isArray(keep) ? keep : []);
}

const describe = (s: Session) =>
  `${s.id}: "${s.name}" in ${s.cwd}, running ${s.agent ? "claude" : s.cmd.join(" ")}${(s.group ?? "") === "" ? "" : `, now in "${String(s.group)}"`}${s.links.length > 0 ? `, links ${s.links.join(" ")}` : ""}`;

function saveGroups(key: string, groups: Record<string, string>) {
  grouping.key = key;
  kept.groups = groups;
  writeStateJson(GROUPS_FILE, groups);
}

async function regroupWhenSessionsOrTitlesChange() {
  const running = (await fetchSessions()).filter((s) => s.running);
  const key = running.map((s) => `${s.id}:${s.name}`).toSorted((a, b) => Number(a > b) - Number(a < b)).join("|");
  if (key === grouping.key || Date.now() - grouping.at < GROUP_EVERY_MS) return;
  grouping.at = Date.now();
  const sentries = running.filter((s) => s.sentry);
  const sessions = running.filter((s) => !sentries.includes(s));
  const fixed = Object.fromEntries(sentries.map((s) => [s.id, SENTRY_GROUP]));
  for (const s of sessions) if (/yarn|maxflow/i.test(s.name) || s.cwd.startsWith(YARN_DIR)) fixed[s.id] = YARN_GROUP;
  if (sessions.length < 2) {
    saveGroups(key, { ...Object.fromEntries(sessions.map((s) => [s.id, s.name])), ...fixed });
    return;
  }
  const reply = await askHaikuForJson(GROUP_SYSTEM, `Sessions:\n${sessions.map((s) => describe(s)).join("\n")}`);
  const named = isRecord(reply) ? sessions.flatMap((s): [string, string][] => (typeof reply[s.id] === "string" ? [[s.id, stringOr(reply[s.id]).trim()]] : [])) : [];
  saveGroups(key, { ...Object.fromEntries(named), ...fixed });
  const byGroup = Map.groupBy(Object.entries(kept.groups), ([, g]) => g);
  console.log(`${new Date().toLocaleTimeString()}  groups: ${[...byGroup].map(([g, m]) => `${g} (${m.length})`).join(", ")}`);
}

async function firstPrompts() {
  const chats = await getJson("/api/chats?limit=1000");
  const withSession = Array.isArray(chats) ? chats.filter(isRecord).filter((c) => stringOr(c["session"]) !== "") : [];
  return new Map(withSession.map((c) => [stringOr(c["session"]), stringOr(c["prompt"])]));
}

async function judgeRoles(stale: Session[]) {
  const prompts = await firstPrompts();
  const firstPrompt = (s: Session) => {
    const prompt = prompts.get(s.id) ?? "";
    return prompt === "" ? "" : `, first prompt: "${prompt}"`;
  };
  const list = stale.map((s) => `${s.id}: "${s.name}" in ${s.cwd}${firstPrompt(s)}`).join("\n");
  const reply = await askHaikuForJson(ROLE_SYSTEM, `Sessions:\n${list}`);
  for (const s of stale) {
    const role = isRecord(reply) ? reply[s.id] : undefined;
    kept.roles[s.id] = typeof role === "string" && ROLES.has(role) ? role : null;
    rolesJudgedUnderTitle[s.id] = s.name;
  }
  console.log(`${new Date().toLocaleTimeString()}  roles: ${stale.map((s) => `${s.name} → ${kept.roles[s.id] ?? "none"}`).join(", ")}`);
}

async function assignRoles() {
  const agents = (await fetchSessions()).filter((s) => s.running && s.agent && !s.sentry);
  const stale = agents.filter((s) => rolesJudgedUnderTitle[s.id] !== s.name);
  const live = new Set(agents.map((s) => s.id));
  const isGone = (id: string) => !live.has(id);
  if (stale.length === 0 && !Object.keys(kept.roles).some(isGone)) return;
  kept.roles = Object.fromEntries(Object.entries(kept.roles).filter(([id]) => !isGone(id)));
  if (stale.length > 0) await judgeRoles(stale);
  writeStateJson(ROLES_FILE, kept.roles);
}

async function didJudgeFreshLinks(s: Entry) {
  const mine = (kept.verdicts[s.id] ??= {});
  const fresh = s.candidates.filter((c) => !Object.hasOwn(mine, c.url));
  if (fresh.length === 0) return false;
  const keep = await judge(s, fresh);
  for (const c of fresh) mine[c.url] = keep.has(c.url);
  const keptUrls = fresh.filter((c) => keep.has(c.url)).map((c) => c.url);
  console.log(`${new Date().toLocaleTimeString()}  ${s.id}  ${s.name}  kept ${keptUrls.length}/${fresh.length}${keptUrls.length > 0 ? `: ${keptUrls.join(" ")}` : ""}`);
  writeStateJson(LINKS_FILE, kept.verdicts);
  return true;
}

async function tick() {
  const links = await getJson("/api/links");
  const entries = Array.isArray(links) ? links.filter(isEntry) : [];
  const ids = new Set(entries.map((s) => s.id));
  const before = Object.keys(kept.verdicts).length;
  kept.verdicts = Object.fromEntries(Object.entries(kept.verdicts).filter(([id]) => ids.has(id)));
  let hasChanged = Object.keys(kept.verdicts).length !== before;
  for (const s of entries) if (await didJudgeFreshLinks(s)) hasChanged = true;
  if (hasChanged) writeStateJson(LINKS_FILE, kept.verdicts);
  await regroupWhenSessionsOrTitlesChange();
  await assignRoles();
}

console.log(`graph sentry: judging session links every ${INTERVAL_MS / 1000}s via ${MODEL}`);
for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, error);
  }
  await Bun.sleep(INTERVAL_MS);
}
