#!/usr/bin/env bun
// graph sentry: keeps the graph readable. The server finds every URL a session mentions; this judges each new one once and writes
// the verdicts to graph-links.json, which the server reads to decide which URLs become nodes. It also groups running sessions by
// the work they share into graph-groups.json, and the graph pulls each group's nodes together. It names each agent's role into
// graph-roles.json, and the graph draws the role's icon on the agent's node.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const STATE_FILE = join(STATE_DIR, "graph-links.json");
const INTERVAL_MS = Number(process.env.GRAPH_INTERVAL ?? 15_000);
const GROUPS_FILE = join(STATE_DIR, "graph-groups.json");
const GROUP_EVERY_MS = Number(process.env.GRAPH_GROUP_EVERY ?? 120_000);
const ROLES_FILE = join(STATE_DIR, "graph-roles.json");
const ROLES = ["review", "implement", "conflicts"];
const MODEL = process.env.GRAPH_MODEL ?? "haiku";
const SENTRY_GROUP = "maxflow sentries";
const MAXFLOW_GROUP = "maxflow development";
const MAXFLOW_DIR = join(import.meta.dir, "..");
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

const SYSTEM = `You curate a graph of an engineer's terminal and Claude agent sessions. Each URL a session mentions can become a clickable node beside it, and most mentions are noise. Keep a URL only if the engineer would want to click it from the graph:
- something the agent made or changed and is pointing them to: a PR, issue or ticket it opened, a deploy or preview, a page, doc or artifact it published, a dashboard or run it started
- a local dev server or app the session is running for them to open
- a link the engineer gave the agent as the subject of the work (the ticket, PR or page to fix)
Drop URLs that are incidental: inside code, config, shell commands, logs or stack traces; library, CDN, package, API or docs references; example or placeholder URLs; asset or API endpoints; links to maxflow itself (localhost:4747); anything mentioned only in passing. Drop when unsure.
Some candidates are GitHub PRs the text named by number (#123, PR 123, owner/repo#123) rather than linked; judge them the same way, keeping a PR that is the subject or product of the work. Each candidate comes with who wrote it (user, assistant, or screen for a plain terminal) and the text around it. Reply with only JSON: {"keep": ["<url>", ...]}, listing URLs exactly as given.`;

const GROUP_SYSTEM = `You group an engineer's running terminal and Claude agent sessions by the work they share, so a graph can draw related sessions close together. Sessions belong together when they work on the same project, feature, bug, ticket or PR; a shared folder alone is weak evidence when the titles point at unrelated work. Title each group the way a sidebar titles a session: 3 to 7 words naming the topic the group owns, e.g. "PRO-6201 safety stock dismissals" or "maxflow graph view". Name the ticket, PR, bug or feature when the sessions show one. Write a noun phrase, not a verb phrase. Never describe status, progress or the current step: no "fixing", "waiting on CI", "testing", "done". No quotes, no trailing period. Keep a group's existing title when it still names the right topic, so groups stay stable. Every session working on maxflow itself (the terminal and agent dashboard these sessions run in: its graph, sidebar, sentries, server or UI) goes in the one group "${MAXFLOW_GROUP}", never split by feature. A session unrelated to all others gets a group of its own. Reply with only JSON: {"<session id>": "<group name>", ...}, covering every session.`;

const ROLE_SYSTEM = `You name the role of each of an engineer's Claude agent sessions from its title, folder and first prompt. Roles:
- "review": reviewing someone's PR or diff, leaving or answering review comments, style passes, approving
- "implement": building a feature or fixing a bug, writing the code and driving its PR
- "conflicts": resolving merge or rebase conflicts on a branch or PR
- null: anything else (orchestrating other agents, research, diagnosing without fixing, ops, questions, chat)
Pick null when unsure. Reply with only JSON: {"<session id>": "<role>" | null, ...}, covering every session.`;

type Chat = { prompt: string; session: string | null };
type Session = { id: string; name: string; cmd: string[]; cwd: string; running: boolean; agent: boolean; links: string[]; group: string | null; sentry: boolean };
type Candidate = { url: string; role: string; context: string };
type Entry = { id: string; name: string; cwd: string; running: boolean; candidates: Candidate[] };

const load = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
const verdicts: Record<string, Record<string, boolean>> = load(STATE_FILE);
let groups: Record<string, string> = load(GROUPS_FILE);
let groupedKey = "", groupedAt = 0;
let roles: Record<string, string | null> = load(ROLES_FILE);
// The title each role was judged under; an agent is judged again when its title changes.
const rolesJudged: Record<string, string> = {};

// One tool-less haiku call; returns the JSON object in its reply.
async function ask(system: string, input: string) {
  const proc = Bun.spawn(
    ["claude", "-p", "--model", MODEL, "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", system],
    { cwd: STATE_DIR, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error(`claude exited ${proc.exitCode}: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
}

async function judge(s: Entry, fresh: Candidate[]) {
  const list = fresh.map((c, i) => `${i + 1}. ${c.url}\n   from ${c.role}: "${c.context}"`).join("\n");
  const { keep } = await ask(SYSTEM, `Session: ${s.name}\nFolder: ${s.cwd}\n\nCandidates:\n${list}`);
  return new Set(Array.isArray(keep) ? keep : []);
}

// Written whole and renamed into place, so the server never reads half a file.
function save(path = STATE_FILE, value: unknown = verdicts) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

// Regroups when the set of running sessions or their titles change, at most every GROUP_EVERY_MS.
async function regroup() {
  const running = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running);
  const key = running.map((s) => `${s.id}:${s.name}`).sort().join("|");
  if (key === groupedKey || Date.now() - groupedAt < GROUP_EVERY_MS) return;
  groupedAt = Date.now();
  // Sentries always form one group of their own; only the rest need judging.
  const sentries = running.filter((s) => s.sentry), sessions = running.filter((s) => !sentries.includes(s));
  const fixed = Object.fromEntries(sentries.map((s) => [s.id, SENTRY_GROUP]));
  for (const s of sessions) if (/maxflow/i.test(s.name) || s.cwd.startsWith(MAXFLOW_DIR)) fixed[s.id] = MAXFLOW_GROUP;
  if (sessions.length < 2) return void ((groupedKey = key), save(GROUPS_FILE, (groups = { ...Object.fromEntries(sessions.map((s) => [s.id, s.name])), ...fixed })));
  const list = sessions
    .map((s) => `${s.id}: "${s.name}" in ${s.cwd}, running ${s.agent ? "claude" : s.cmd.join(" ")}${s.group ? `, now in "${s.group}"` : ""}${s.links.length ? `, links ${s.links.join(" ")}` : ""}`)
    .join("\n");
  const reply = await ask(GROUP_SYSTEM, `Sessions:\n${list}`);
  groups = { ...Object.fromEntries(sessions.filter((s) => typeof reply[s.id] === "string").map((s) => [s.id, reply[s.id].trim()])), ...fixed };
  groupedKey = key;
  save(GROUPS_FILE, groups);
  const byGroup = Map.groupBy(Object.entries(groups), ([, g]) => g);
  console.log(`${new Date().toLocaleTimeString()}  groups: ${[...byGroup].map(([g, m]) => `${g} (${m.length})`).join(", ")}`);
}

async function assignRoles() {
  const agents = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && s.agent && !s.sentry);
  const stale = agents.filter((s) => rolesJudged[s.id] !== s.name);
  const gone = Object.keys(roles).filter((id) => !agents.some((s) => s.id === id));
  if (!stale.length && !gone.length) return;
  for (const id of gone) delete roles[id];
  if (stale.length) {
    const prompts = new Map(((await (await fetch(`${base}/api/chats?limit=1000`)).json()) as Chat[]).filter((c) => c.session).map((c) => [c.session!, c.prompt]));
    const list = stale.map((s) => `${s.id}: "${s.name}" in ${s.cwd}${prompts.get(s.id) ? `, first prompt: "${prompts.get(s.id)}"` : ""}`).join("\n");
    const reply = await ask(ROLE_SYSTEM, `Sessions:\n${list}`);
    for (const s of stale) (roles[s.id] = ROLES.includes(reply[s.id]) ? reply[s.id] : null), (rolesJudged[s.id] = s.name);
    console.log(`${new Date().toLocaleTimeString()}  roles: ${stale.map((s) => `${s.name} → ${roles[s.id] ?? "none"}`).join(", ")}`);
  }
  save(ROLES_FILE, roles);
}

async function tick() {
  const entries = (await (await fetch(`${base}/api/links`)).json()) as Entry[];
  let changed = false;
  for (const id of Object.keys(verdicts)) if (!entries.some((s) => s.id === id)) (delete verdicts[id]), (changed = true);
  for (const s of entries) {
    const mine = (verdicts[s.id] ??= {});
    const fresh = s.candidates.filter((c) => !(c.url in mine));
    if (!fresh.length) continue;
    const keep = await judge(s, fresh);
    for (const c of fresh) mine[c.url] = keep.has(c.url);
    changed = true;
    const kept = fresh.filter((c) => keep.has(c.url)).map((c) => c.url);
    console.log(`${new Date().toLocaleTimeString()}  ${s.id}  ${s.name}  kept ${kept.length}/${fresh.length}${kept.length ? `: ${kept.join(" ")}` : ""}`);
    save();
  }
  if (changed) save();
  await regroup();
  await assignRoles();
}

console.log(`graph sentry: judging session links every ${INTERVAL_MS / 1000}s via ${MODEL}`);
for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
