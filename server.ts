import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { slackAvatar, slackNames } from "./slack-meta";
import { agents, calendar, health, stats } from "./stats";
import { inboxesTable, slackMessagesTable, watchedStateFile, writeStateJson } from "./state";
import { latestSeq, publish, query } from "./bus";
import { jev } from "./stats-jev";
import { findChat, listChats } from "./chats";
import { BASE, CLI, DIR, INSTANCE, LIVE, PORT, STATE_DIR } from "./instance";
import { enforce } from "./restrictions-enforce";
import { invalid, resolve, saveRestrictions, type Person, type Restriction } from "./restrictions";
import { backfill, link, people as restrictionPeople } from "./restrictions-identities";
import { preview } from "./restrictions-recent";
import app from "./src/index.html";
import { TMUX, flushOptions, paneEnv, paste, pressEnter, respawn, setOption, termEnv, tmux, tmuxAsync, tmuxName } from "./tmux";
import { type ClaudeState, type Role, type Session, type Wait, type WsData, chatOf, isAgent, isSentry, sessions } from "./sessions";
import { candidates } from "./mentions";
import { type Block, type Feed, type FeedPost, type Message, TODO_STATES, type Task, type TaskEdit, type Thread, type Todo } from "./model";
import { live, names, objectives, saveObjectives, saveTasks, saveThreads, saveTodos, tasks, threads, threadsDirty, todos, writeThreads } from "./stores";
import { DEFAULT_AFTER_H, DEFAULT_AFTER_MS, VERIFIED, intro } from "./intro";
import { SessionCap, attachViewer, createSession, derive, dispatch, editTask, endWait, funnel, live_thread, push, routersOf, screen, setArchived, setClaudeState, setWait, settleTasks, stopAgent, taskPrs, waitsOn, wake } from "./lifecycle";
import { checkShells, declareWait, untilShell } from "./waits";
import { ISAAC_IN_THREAD, ancestors, answered, ask, enforcing, headline, mentionsIn, message, pathTitle, pauseTimers, postIn, restrictions, resurface, schedulePause, squash, tellMembers, unforge, unpause } from "./threads";
import { DRAFTS, deliver } from "./delivery";
import { RESYNC_MS, claudeStateChanged, resync } from "./turns";
import { docsRoute } from "./docs-api";
import { ARCHIVED_LINKS, SENTRY_USES, archivedLinks, built, describe, freshWorld, judged, openWorld, prStates, worldClients } from "./world";
import { EXTERNAL_SEEN, ROUTER_BRIEF, acceptTrust, externalSeen, externalSignal, feedMore, feedPosts, feedToFunnel, known, requested, reroute, slackChannels, startRouter } from "./routing";
import { handOff, mergeThread, newObjective, pointsAtItself, relayRefusal, setRole, subthread, titleOf } from "./objectives";
import { onEvent, openUserComments, recordUserComment, seedUserComments } from "./events";

const HOST = "127.0.0.1";
function loadInbox(id: string): Pick<Session, "inbox" | "sending"> {
  const { inbox, sending } = inboxesTable.get(id) ?? { inbox: [] };
  return { inbox, ...(sending && { sending: { ...sending, text: inbox.slice(0, sending.count).join("\n") } }) };
}

// Pick up sessions that outlived a previous server, seeding scrollback from tmux's history.
// One display-message reads every option a session keeps, so adopting costs two tmux calls per session instead of ten.
const ADOPT_FIELDS = ["history_size", "@mf", "@mf-claude", "@mf-transcript", "@mf-archived", "@mf-asleep", "@mf-sentry", "@mf-wait", "@mf-role"];
function adoptSessions() {
  for (const t of tmux("list-sessions", "-F", "#{session_name}").out.split("\n")) {
    if (!t.startsWith("mf-")) continue;
    const id = t.slice(3);
    const f = Object.fromEntries(tmux("display-message", "-p", "-t", t, ADOPT_FIELDS.map((k) => `#{${k}}`).join("\x1f")).out.replace(/\n$/, "").split("\x1f").map((v, i) => [ADOPT_FIELDS[i], v]));
    const json = (v: string | undefined) => {
      try {
        return JSON.parse(v ?? "") || undefined;
      } catch {}
    };
    const meta = json(f["@mf"]) ?? { name: t, cmd: [], cwd: "", createdAt: Date.now() };
    const session = { id, ...meta, chunks: [], bytes: 0, clients: new Set(), exitCode: null, ...loadInbox(id) } as unknown as Session;
    const history = Number(f.history_size) > 0 ? tmux("capture-pane", "-p", "-e", "-J", "-t", t, "-S", "-", "-E", "-1").out : "";
    if (history.trim()) push(session, new TextEncoder().encode(history.replace(/\n/g, "\r\n")));
    session.lastOutputAt = session.createdAt;
    session.claude = json(f["@mf-claude"]);
    session.transcript = f["@mf-transcript"]?.trim() || undefined;
    session.archived = f["@mf-archived"]?.trim() === "1";
    session.asleep = f["@mf-asleep"]?.trim() || undefined;
    session.sentry = f["@mf-sentry"]?.trim() === "1";
    session.wait = json(f["@mf-wait"]);
    session.role = json(f["@mf-role"]);
    sessions.set(id, session);
    attachViewer(session);
  }
  if (sessions.size) console.log(`adopted ${sessions.size} tmux session(s)`);
}
// Panes in the live maxflow carry its port, so a plain `bun server.ts` run from one would otherwise adopt and respawn the live sessions.
// The health sentry's panic page answers 503, so a server started while live is down still takes over.
if (LIVE && (await fetch(`${BASE}/api/sessions`).then((r) => r.ok, () => false)))
  console.error(`the live maxflow is already running on ${BASE}; run ./dev.sh for a dev instance`), process.exit(1);
adoptSessions();

// Sentries are ordinary sessions, started once and kept by tmux across server restarts.
const SENTRIES: Record<string, string[]> = Object.fromEntries(
  ["gh", "slack", "rename", ...(LIVE ? ["health"] : []), "graph", "ram", "inbox", "approval", "docs", "jev"].map((n) => [`sentry:${n}`, [process.execPath, new URL(`./sentries/${n}.ts`, import.meta.url).pathname]]),
);
// The review sentry is a claude agent; its feed runs beside it, logging out of the way of its screen.
const reviewSource = (f: string) => new URL(`./sentries/${f}`, import.meta.url).pathname;
SENTRIES["sentry:review"] = ["sh", "-c",
  `"${process.execPath}" "${reviewSource("review.ts")}" >"${STATE_DIR}/review-feed.log" 2>&1 & exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${reviewSource("review.md")}")"`];
// The meta sentry is a claude agent that watches the other agents; its feed times their transcripts beside it.
SENTRIES["sentry:meta"] = ["sh", "-c",
  `"${process.execPath}" "${reviewSource("meta.ts")}" >"${STATE_DIR}/meta-feed.log" 2>&1 & exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${reviewSource("meta.md")}")"`];
// The assistant sentry is a claude agent that keeps the user's task board; its feed brings it his prompts and the fleet's events.
SENTRIES["sentry:assistant"] = ["sh", "-c",
  `"${process.execPath}" "${reviewSource("assistant.ts")}" >"${STATE_DIR}/assistant-feed.log" 2>&1 & exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${reviewSource("assistant.md")}")"`];
// The context sentry is a claude agent that keeps notes on his Slack (people, asks, artifacts, topics); its feed brings it each message.
SENTRIES["sentry:context"] = ["sh", "-c",
  `"${process.execPath}" "${reviewSource("context.ts")}" >"${STATE_DIR}/context-feed.log" 2>&1 & exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${reviewSource("context.md")}")"`];
// The todo sentry is a claude agent that tags threads onto his todos; its feed brings it the threads that changed, in batches.
SENTRIES["sentry:todo"] = ["sh", "-c",
  `"${process.execPath}" "${reviewSource("todo.ts")}" >"${STATE_DIR}/todo-feed.log" 2>&1 & exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${reviewSource("todo.md")}")"`];
// The funnel sentry is a claude agent that takes the user's requests and routes each to an agent.
SENTRIES["sentry:funnel"] = ["sh", "-c", `exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${reviewSource("funnel.md")}")"`];
// A session is a sentry because the server started it as one, never because of its name.
function markSentry(s: Session) {
  s.sentry = true;
  setOption(s.id, "@mf-sentry", "1");
}
// Sentries started before the flag existed: exactly a sentry's name, running a script from sentries/.
for (const s of sessions.values())
  if (!s.sentry && s.name in SENTRIES && s.cmd.join(" ").includes(reviewSource(""))) markSentry(s);
// MAXFLOW_SENTRIES: 0 for none, a comma list (gh,health) for those alone, 1 or unset for all.
const sentryList = process.env.MAXFLOW_SENTRIES ?? "1";
const wanted = Object.entries(SENTRIES).filter(([n]) => sentryList !== "0" && (sentryList === "1" || sentryList.split(",").includes(n.slice(7))));
// A deploy restarts a sentry whose code changed in its own pane, so it keeps its session. A claude sentry resumes its chat, unless
// its brief changed: then it starts a fresh chat, handed the last things its old one said.
function restartSentry(s: Session, fresh: boolean) {
  let cmd = SENTRIES[s.name];
  // claude writes a chat's transcript at its first turn, and resuming one that never had a turn exits at once.
  const chat = s.transcript && existsSync(s.transcript) ? chatOf(s) : undefined;
  const claude = cmd[0] === "sh" && cmd[2].includes("exec claude ");
  if (claude && chat && !fresh) cmd = ["sh", "-c", cmd[2].replace("exec claude ", `exec claude --resume ${chat} `)];
  if (claude && chat && fresh && s.transcript) {
    const said = readFileSync(s.transcript, "utf8").split("\n").flatMap((line) => {
      try {
        const m = JSON.parse(line);
        return m.type === "assistant" ? m.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text.trim().slice(0, 300)) : [];
      } catch {
        return [];
      }
    });
    const digest = `${STATE_DIR}/${s.name.slice(7)}-restart-digest.txt`;
    writeFileSync(digest, `[maxflow] Your brief (sentries/${s.name.slice(7)}.md) changed, so a deploy restarted you in a fresh chat. Your previous chat was ${chat} (transcript ${s.transcript}, if you need more of it). The last things you said there:\n${said.slice(-6).map((t) => `- ${t}`).join("\n")}`);
    cmd = ["sh", "-c", `${cmd[2]} "$(cat '${digest}')"`];
  }
  return { ok: respawn(s.id, "-c", DIR, ...paneEnv(s.id), "--", ...cmd), resumed: claude && chat && !fresh ? chat : undefined, fresh: claude && (fresh || !chat) };
}
const sentryUp = (name: string) => [...sessions.values()].some((s) => s.sentry && s.name === name && s.exitCode === null);
// Each start goes on the bus, so the Stats page can count a sentry's restarts.
for (const [name, cmd] of wanted) if (!sentryUp(name)) markSentry(createSession(name, cmd, DIR)), publish("sentry/start", { name, why: "boot" });
// A sentry that dies after boot comes back too, 30s after it died and doubling while it keeps dying, up to half an hour;
// one that has stayed up ten minutes starts over at 30s.
const respawns = new Map<string, { tries: number; at: number }>();
setInterval(() => {
  for (const [name, cmd] of wanted) {
    const r = respawns.get(name) ?? { tries: 0, at: 0 };
    if (sentryUp(name)) {
      if (r.tries && Date.now() - r.at > 10 * 60_000) respawns.delete(name);
      continue;
    }
    if (Date.now() - r.at < Math.min(30_000 * 2 ** r.tries, 30 * 60_000)) continue;
    respawns.set(name, { tries: r.tries + 1, at: Date.now() });
    console.log(`${name} is down; starting it again (try ${r.tries + 1})`);
    markSentry(createSession(name, cmd, DIR));
    publish("sentry/start", { name, why: "respawn", tries: r.tries + 1 });
  }
}, 15_000);
// Lets the graph show one session reading or writing another; held is true while a wait is still watching.
function touchFrom(req: Request, s: Session, kind: "read" | "write", held = false) {
  const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
  if (from && from !== s) publish(`touch/${from.id}/${s.id}`, { from: from.id, to: s.id, kind, held });
}
const UPLOADS = `${STATE_DIR}/uploads`;
for (const s of sessions.values()) if (existsSync(`${DRAFTS}/${s.id}.txt`)) s.savedDraft = readFileSync(`${DRAFTS}/${s.id}.txt`, "utf8");

function setTranscript(s: Session, path: string) {
  if (!path.endsWith(".jsonl") || path === s.transcript) return;
  s.transcript = path;
  s.links = undefined;
  setOption(s.id, "@mf-transcript", path);
}
// Whether each PR shown in the graph is open, closed, merged or missing; one GraphQL request per repo, off the event loop.
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
async function refreshPrStates() {
  const shown = [...new Set([...sessions.values()].flatMap((s) => judged(s)))];
  const byRepo = Map.groupBy(shown.map((u) => u.match(PR_URL_RE)).filter((m) => m !== null), (m) => m[1]);
  for (const [repo, prs] of byRepo) {
    const [owner, name] = repo.split("/");
    const q = `query { r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prs.map((m) => `p${m[2]}: pullRequest(number: ${m[2]}) { state }`).join(" ")} } }`;
    const p = Bun.spawn(["gh", "api", "graphql", "-f", `query=${q}`], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    let res: { data?: { r?: Record<string, { state: string } | null> | null }; errors?: { type?: string; path?: string[] }[] } = {};
    try {
      res = JSON.parse(out);
    } catch {}
    // Only GitHub's NOT_FOUND makes a PR missing, on the repo or on that PR; a gh or network failure changes nothing.
    const notFound = new Set((res.errors ?? []).filter((e) => e.type === "NOT_FOUND").map((e) => e.path?.join(".")));
    for (const m of prs) {
      const pr = res.data?.r?.[`p${m[2]}`];
      if (pr) prStates.set(m[0], pr.state.toLowerCase());
      else if (notFound.has("r") || notFound.has(`r.p${m[2]}`)) prStates.set(m[0], "missing");
    }
  }
}
setInterval(() => refreshPrStates().catch(() => {}), 30_000);
// Its board of the PRs that need the user, { updated, next, sections: [{ title, items: [{ pr, url, note }] }] }, and the queue of every open PR it reads.
const reviewBoard = watchedStateFile<unknown>("review-board.json", null);
const reviewQueue = watchedStateFile<unknown[]>("review-queue.json", []);
// What Isaac himself typed into the funnel: its transcript's prompts, minus every part the server stamped as from a session.
function isaacPrompts(funnel: Session) {
  let raw = "";
  try { raw = readFileSync(funnel.transcript ?? "", "utf8").slice(-4_000_000); } catch { return []; }
  return raw.split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line);
      if (e.type !== "user" || e.isMeta) return [];
      const c = e.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
      return text.split(/\n(?=\[maxflow)/).filter((p) => p.trim() && !p.startsWith("[maxflow") && !p.startsWith("<")).map(squash);
    } catch { return []; }
  }).slice(-30);
}
// Text one session types into another carries its true sender; a funnel relay of Isaac's own words carries the verified stamp.
// request: the words Isaac typed into the funnel that the relay starts with.
function stamp(req: Request, text: string, isaac?: boolean): { text: string; request?: string } | { error: string } {
  const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
  if (!isaac) return { text: from ? `[maxflow · from "${from.name}" (${from.id})] ${unforge(text)}` : unforge(text) };
  if (!from || from.name !== "sentry:funnel" || !isSentry(from)) return { error: "only the funnel sentry relays Isaac's requests" };
  const said = squash(text);
  const request = isaacPrompts(from).findLast((p) => p && said.startsWith(p));
  if (!request) return { error: "the message doesn't start with a request Isaac typed into the funnel, verbatim; relay it without --isaac, saying who it came from" };
  return { text: `${VERIFIED}\n${unforge(text)}`, request };
}
setTimeout(() => {
  const since = Date.now() - 86_400_000;
  try {
    for (const line of readFileSync(`${STATE_DIR}/events.jsonl`, "utf8").split("\n")) {
      if (!line.includes('"topic":"slack/') && !line.includes('"topic":"gh/')) continue;
      const e = JSON.parse(line);
      if (e.at >= since) externalSignal(e, false);
    }
    writeStateJson(EXTERNAL_SEEN, [...externalSeen].slice(-5000));
  } catch (err) { console.error(`external backfill failed: ${err}`); }
}, 3_000);
const STUBS_SINCE_HIS_MIDNIGHT = Date.parse("2026-11-18T08:00:00Z");
for (const t of threads) {
  const lastAt = Math.max(...t.messages.map((m) => m.at));
  if (t.mergedInto !== undefined && t.moved === undefined && t.messages.some((m) => m.from === "isaac") && lastAt >= STUBS_SINCE_HIS_MIDNIGHT) t.moved = { at: lastAt };
}
// Commands are retired: every thread is a plain thread, and a router's result on his message is an ordinary reply.
for (const t of threads as (Thread & { kind?: string; kindBy?: string; done?: number })[]) {
  delete t.kind, delete t.kindBy, delete t.done;
  for (const m of t.messages as (Message & { re?: unknown })[]) delete m.re;
}
// Feed threads from before the feed posted each message as its author hold one text per hand-off ("<who> in <where>:", the context
// quoted under "Before it…", then the new lines under "New:" and the links); each becomes its messages, with the text kept for agents.
{
  const uids: Record<string, string> = {};
  // The hand-off text squashed each message's whitespace; the slack sentry's store has it as written, by its ts.
  const raw: Record<string, string> = {};
  try {
    for (const { msgs } of Object.values(slackMessagesTable.all()))
      for (const m of msgs) (uids[m.who] ??= m.uid), (raw[m.ts.replace(".", "")] ??= m.text.replace(/\s*No thread mess+ages\s*$/, ""));
  } catch {}
  for (const t of threads) {
    // A hand-off can sit outside a feed thread too: moved by a merge, or posted by the inbox sentry into a thread the feed was merged
    // into, which took it as a plain post before the server did either as the feed.
    const blob = (m: Message) => !m.ext && m.from !== "isaac" && /^.+? in .+?:\n(Before it, in the same conversation|> )/.test(m.text) && /^https:\/\/(\S+\.slack\.com|github\.com)\//m.test(m.text);
    if (!t.messages.some(blob)) continue;
    const blobs = t.messages.filter(blob).map((m) => m.text);
    if (t.feed) t.feedSaid = [...(t.feedSaid ?? []), ...blobs.filter((b) => !t.feedSaid?.includes(b))];
    t.messages = t.messages.flatMap((m) => {
      const head = blob(m) && m.text.match(/^(.+?) in (.+?):\n([\s\S]*)$/);
      if (!head) return [m];
      const source = (t.feed ? t.feed.source === "slack" : /\.slack\.com\//.test(m.text)) ? "slack" : "github";
      const [, who, where, rest] = head;
      const links = rest.match(/^https?:\/\/\S+$/gm) ?? [t.feed?.link ?? ""];
      const body = rest.replace(/^https?:\/\/\S+$/gm, "").trim();
      const [before, now] = body.includes("\n\nNew:\n") ? body.split("\n\nNew:\n") : ["", body];
      const unquote = (x: string) => x.replace(/^> ?/gm, "").trim();
      // `message` is defined further down, so these are built by hand.
      const said = (text: string, id = `m-${crypto.randomUUID().slice(0, 6)}`) => ({ id, from: "feed", at: m.at, text });
      const out: Message[] = [];
      for (const c of before.replace(/^Before it[^\n]*\n/, "").split(/\n(?=> \*\*)/).filter((x) => x.trim())) {
        const n = c.match(/^> \*\*(.+?):\*\* ?([\s\S]*)$/);
        if (!n || !unquote(n[2])) continue;
        const own = n[1].startsWith("Isaac (him");
        const name = own ? "Isaac" : n[1];
        out.push({ ...said(unquote(n[2])), ext: { source, name, ...(uids[name] && source === "slack" && { user: uids[name] }), ...(source === "github" && !own && { user: name }), link: links[0], where, context: true, ...(own && { own: true }) } });
      }
      // Each new message was quoted with its continuation lines quoted too, so they split apart only when there is a link for each.
      const split = now.split(/\n(?=> )/).map(unquote).filter(Boolean);
      const lines = split.length === links.length ? split : [unquote(now)];
      lines.forEach((text, i) => out.push({ ...said((lines.length === links.length && raw[links[i].match(/\/p(\d+)/)?.[1] ?? ""]) || text, i ? `${m.id}-${i}` : m.id), ext: { source, name: who, ...(source === "slack" ? uids[who] && { user: uids[who] } : { user: who }), link: links[Math.min(i, links.length - 1)], where } }));
      return out.length ? out : [m];
    });
  }
  // Threads split before the store's text was used get it now: a Slack message's own text, by its link.
  for (const t of threads)
    for (const m of t.messages) {
      const ts = m.ext?.source === "slack" && !m.ext.context && m.ext.link.match(/\/p(\d+)/)?.[1];
      if (ts && raw[ts] && !m.text.includes("\n") && raw[ts].includes("\n")) m.text = raw[ts];
    }
}
process.on("exit", () => threadsDirty && writeThreads());
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => {
    flushOptions();
    process.exit(0);
  });
// Messages from before subthreads get their ids once.
if (threads.some((t) => t.messages.some((m) => !m.id))) {
  for (const t of threads) for (const m of t.messages) m.id ??= `m-${crypto.randomUUID().slice(0, 6)}`;
  saveThreads();
}
for (const t of threads) if (t.paused) schedulePause(t);
setInterval(() => {
  for (const t of threads) if (t.paused && !pauseTimers.has(t.id)) t.paused.until <= Date.now() ? resurface(t) : schedulePause(t);
}, 60_000);

// A page (an objective's or a task's) is a grid of cards its agents keep current.
function pageOf(ref: string): { page: Block[]; save: () => void } | null {
  const [type, id] = ref.split("/");
  if (type === "objective") {
    const o = objectives.find((x) => x.id === id);
    return o ? { page: o.page, save: saveObjectives } : null;
  }
  const t = type === "task" ? tasks.find((x) => x.id === Number(id.replace(/^t/, ""))) : undefined;
  return t ? { page: (t.page ??= []), save: saveTasks } : null;
}
// Whether claude itself runs in each agent's pane, read from the process table rather than the screen: a stop, a crash or a kill
// can leave the pane at the asleep prompt or a shell while the session still reads as claude's. A claude found gone takes its
// hook state with it, so the session can't stay "working"; an archived one kept up by a draft is stopped once the box is empty.
const CLAUDE_CHECK_MS = 5000;
async function checkClaude() {
  // By command line, so a claude run through node counts too; a false match only spares a pane a resume.
  const kids = new Map<number, number[]>(), args = new Map<number, string>();
  for (const line of Bun.spawnSync(["ps", "-Ao", "pid=,ppid=,args="]).stdout.toString().split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) args.set(+m[1], m[3].trim()), kids.set(+m[2], [...(kids.get(+m[2]) ?? []), +m[1]]);
  }
  for (const line of (await tmuxAsync("list-panes", "-a", "-F", "#{session_name} #{pane_pid}")).out.split("\n")) {
    const [name, pid] = line.split(" ");
    const s = sessions.get(name?.replace(/^mf-/, "") ?? "");
    if (!s || !pid || isSentry(s) || !isAgent(s) || s.exitCode !== null) continue;
    const tree = [+pid];
    for (let i = 0; i < tree.length && tree.length < 500; i++) tree.push(...(kids.get(tree[i]) ?? []));
    s.claudeUp = tree.some((p) => /^(\S*\/)?claude(\s|$)|claude-code|@anthropic-ai\/claude/.test(args.get(p) ?? ""));
    if (!s.claudeUp && s.claude) setClaudeState(s, "gone");
    if (s.claudeUp && s.archived && !s.asleep && s.claude?.state === "idle") void stopAgent(s);
  }
}
setInterval(() => void checkClaude().catch((e) => console.error("checkClaude", e)), CLAUDE_CHECK_MS);
// The bus holds only its tail in memory, so the first boot reads the whole log once for his earlier comments.
if (seedUserComments)
  try {
    for (const line of readFileSync(`${STATE_DIR}/events.jsonl`, "utf8").split("\n"))
      if (line.includes('"who":"the user')) {
        const e = JSON.parse(line);
        recordUserComment(e.topic.split("/").at(-1), e.data, e.at);
      }
  } catch {}
setInterval(checkShells, 2000);
// How far a task's PRs got, counting only those whose state is known.
function prProgress(t: Task) {
  const states = t.links.flatMap((url) => taskPrs()[url] ?? []);
  return { merged: states.filter((s) => s === "MERGED").length, closed: states.filter((s) => s === "CLOSED").length, total: states.length };
}

// An edge drawn in the graph: tell each agent end who is on the other side and how to reach it.
function introduce(to: Session, other: Session, why?: string) {
  if (!isAgent(to) || to.exitCode !== null) return;
  const who = `"${other.name}" (session ${other.id}, in ${other.cwd})`;
  const reason = why ? ` Why, in the user's words: "${why}".` : "";
  const text = isSentry(other)
    ? `[maxflow] The user linked you to the ${other.name.slice(7)} sentry; it might be useful to you.${reason} ${SENTRY_USES[other.name] ?? `Its source is in ${new URL("./sentries/", import.meta.url).pathname}.`}`
    : isAgent(other)
      ? `[maxflow] The user linked you with another agent, ${who}, and wants you two talking; it got this same note about you.${reason} Start now: message it what you're working on and what you could use from it or offer it, then answer what it sends you. Keep it going while it helps; drop it once it doesn't. Message it with \`${CLI} notify ${other.id} '<text>'\`, which goes through maxflow's event log and resumes it if it is asleep. Read its screen with \`${CLI} screen ${other.id} --history 200\`.`
      : `[maxflow] The user linked you with the terminal session ${who}, running \`${other.cmd.join(" ")}\`; it may matter to your work.${reason} Read it with \`${CLI} screen ${other.id} --history 200\`, type into it with \`${CLI} send ${other.id} '<text>'\`.`;
  dispatch({ to: [to], target: other.name, text });
}
// Questions from before threads: each open one moves into a thread of its own, once, and its asker hears where.
function migrateQuestions() {
  type Question = { id: number; session: string; name: string; status: string; at: number; thread: { from: string; text: string; at: number }[]; default?: string };
  let qs: Question[];
  try { qs = JSON.parse(readFileSync(`${STATE_DIR}/questions.json`, "utf8")); } catch { return; }
  for (const q of qs) {
    if ((q.status !== "pending" && q.status !== "gating") || threads.some((t) => t.q === q.id)) continue;
    const s = sessions.get(q.session);
    const said = q.thread.filter((m) => m.from !== "sentry");
    const t: Thread = {
      id: `th-${crypto.randomUUID().slice(0, 6)}`, title: headline(said[0]?.text ?? q.name).slice(0, 80), objective: s?.role?.objective ?? "", routers: [q.session],
      messages: [...said.map((m) => ({ ...message(m.from === "user" ? "isaac" : q.session, m.text), at: m.at })), ...(q.default ? [message(q.session, `If you haven't answered in ${DEFAULT_AFTER_H}h, I go ahead with: ${q.default}`)] : [])], q: q.id,
      asks: { session: q.session, since: Date.now(), ...(q.default && { default: q.default }) },
    };
    threads.push(t);
    saveThreads();
    publish(`thread/${t.id}`, { thread: t.id, from: q.session, asks: true });
    if (s?.wait?.kind === ("q" as Wait["kind"]) && s.wait.ref.replace(/^q/, "") === String(q.id)) setWait(s, { ...s.wait, kind: "thread", ref: t.id });
    if (s && live(s)) dispatch({ to: [s], target: t.id, text: `[maxflow] Questions are threads now. Your question q${q.id} moved into thread ${t.id} in the user's inbox, flagged as waiting on him; his reply there is typed into your prompt and ends your wait. ${s.wait?.kind === "thread" && s.wait.ref === t.id ? `Your wait is now thread:${t.id}.` : `Wait on it with \`${CLI} wait thread:${t.id}\`.`} Answer him with \`${CLI} thread post ${t.id} '<text>'\`, and ask him anything new with \`${CLI} ask\`, which opens a thread.` });
  }
}
setTimeout(migrateQuestions, 5_000);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const gitRoots = new Map<string, string | null>();
function restrictionRepos() {
  const roots = new Set<string>();
  for (const s of sessions.values()) {
    if (!gitRoots.has(s.cwd)) gitRoots.set(s.cwd, Bun.spawnSync(["git", "-C", s.cwd, "rev-parse", "--show-toplevel"], { stderr: "ignore" }).stdout.toString().trim() || null);
    const root = gitRoots.get(s.cwd);
    if (root) roots.add(root);
  }
  return [...roots].sort().map((path) => ({ path: path.replace(process.env.HOME!, "~"), name: path.split("/").at(-1)! }));
}
// Tasks from before the server settled columns start from what their agents settle now, so only later changes move them.
for (const t of tasks) if (!("derived" in t)) t.derived = derive(t)?.to;
setInterval(settleTasks, 15_000);
// After the tasks store loads, since waking settles tasks: an archived agent with messages queued wakes to take them; the rest stay stopped.
for (const s of sessions.values()) {
  if (s.inbox.length && (s.archived || s.asleep) && !isSentry(s)) wake(s);
  else if (s.archived) stopAgent(s);
}

// An unanswered ask with a default for a reversible step stops holding its agent after DEFAULT_AFTER_MS.
setInterval(() => {
  for (const t of threads) {
    const a = t.asks;
    // Paused, he isn't looking at it: the clock waits for the thread to come back.
    if (!a?.default || !a.shown || t.paused || Date.now() - a.shown < DEFAULT_AFTER_MS) continue;
    t.messages.push(message(a.session, `No answer in ${DEFAULT_AFTER_H}h, so I went ahead with: ${a.default}`));
    answered(t);
    saveThreads();
    publish(`thread/${t.id}`, { thread: t.id, from: a.session });
    const s = sessions.get(a.session);
    if (s && live(s)) dispatch({ to: [s], target: t.id, text: `[maxflow] Thread ${t.id} went ${DEFAULT_AFTER_H}h without his answer, so go ahead with your recommendation, which you marked reversible: "${a.default}". The thread now says you did, so he can overrule it there.` });
  }
}, 60_000);
setTimeout(() => void resync().catch((e) => console.error("resync", e)), 10_000);
setInterval(() => void resync().catch((e) => console.error("resync", e)), RESYNC_MS);
let delivering = false;
setInterval(async () => {
  if (delivering) return;
  delivering = true;
  try {
    for (const s of sessions.values()) await deliver(s);
  } finally {
    delivering = false;
  }
}, 1000);

// Only pages served from this server may drive it; blocks other sites from reaching localhost.
// Favicons are served from this origin so the graph can read their pixels and plate the dark ones.
const favicons = new Map<string, Promise<Response | null>>();
async function fetchFavicon(host: string) {
  const custom = Bun.file(new URL(`favicons/${host}.svg`, PUBLIC));
  if (await custom.exists()) return new Response(custom, { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
  const own = `${/^localhost(:|$)/.test(host) ? "http" : "https"}://${host}/favicon.ico`;
  for (const src of [own, `https://www.google.com/s2/favicons?domain=${host}&sz=64`]) {
    const res = await fetch(src, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (res?.ok && res.headers.get("content-type")?.startsWith("image/")) return new Response(await res.arrayBuffer(), { headers: { "content-type": res.headers.get("content-type")!, "cache-control": "max-age=86400" } });
  }
  return null;
}

function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = new URL(origin).host;
  return host === `localhost:${PORT}` || host === `${HOST}:${PORT}`;
}

// While we're down the health sentry serves its panic page on our port; ask it to hand the port back.
for (let i = 0; i < 20; i++) {
  if (!(await fetch(`http://${HOST}:${PORT}/__panic/release`, { method: "POST" }).then((r) => r.ok, () => false))) break;
  await Bun.sleep(250);
}

Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0, // `wait` and event subscriptions long-poll
  development: { hmr: true },
  routes: { "/": app },
  error: (err) => (err instanceof SessionCap ? new Response(err.message, { status: 429 }) : undefined),
  async fetch(req, server) {
    if (!sameOrigin(req)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const path = url.pathname;

    const wsMatch = path.match(/^\/ws\/([\w-]+)$/);
    if (wsMatch) {
      if (!sessions.has(wsMatch[1])) return new Response("no such session", { status: 404 });
      return server.upgrade(req, { data: { id: wsMatch[1] } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (path === "/api/instance") return Response.json({ instance: INSTANCE || "live", port: PORT, pid: process.pid });
    const docs = await docsRoute(req, url);
    if (docs) return docs;
    if (path === "/api/sessions" && req.method === "GET") return Response.json([...sessions.values()].map((s) => describe(s)));
    if (path === "/api/sessions" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string; cmd?: string[] | string; cwd?: string; role?: "router" | "worker"; parent?: string; objective?: string; scope?: string };
      // An agent a router starts is its worker; one started from a worker joins the same router.
      const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      const parent = sessions.get(body.parent ?? "") ?? (from?.role?.role === "router" ? from : from?.role?.parent ? sessions.get(from.role.parent) : undefined);
      const objective = body.objective ?? parent?.role?.objective;
      const handingRole = body.role === "router" && from?.role?.role === "router" && from.role.objective === objective && (body.scope ?? from.role.scope) === from.role.scope ? from.role : undefined;
      const role: Role | undefined = body.role === "router" && objective ? { role: "router", objective, scope: handingRole?.scope ?? (body.scope || "Whole objective") } : parent && objective ? { role: "worker", objective, parent: parent.id } : undefined;
      // With no command, a router or worker is a claude (a router with its brief, as startRouter starts one), never the bare shell
      // that 662ba653 and b83e405d were: a shell holding a role takes his thread replies where nothing reads them.
      const agent = ["claude", "--permission-mode", "bypassPermissions", ...(role?.role === "router" ? ["--append-system-prompt", readFileSync(ROUTER_BRIEF, "utf8")] : [])];
      const cmd = typeof body.cmd === "string" ? ["zsh", "-lc", body.cmd] : body.cmd?.length ? body.cmd : role ? agent : [process.env.SHELL ?? "zsh", "-l"];
      const s = createSession(body.name || cmd.join(" ").slice(0, 40), cmd, body.cwd?.replace(/^~(?=\/|$)/, process.env.HOME!) || parent?.cwd || process.env.HOME!, undefined, role);
      if (cmd[0] === "claude") acceptTrust(s);
      if (handingRole && from) handOff(from, handingRole, s);
      // Spawned from the browser under a router: the router hears it has a new worker to brief.
      if (parent && !from) dispatch({ to: [parent], target: s.id, text: `[maxflow] The user started a worker for you, "${s.name}" (${s.id}). Brief it with \`${CLI} notify ${s.id} '<brief>'\`.` });
      return Response.json(describe(s), { status: 201 });
    }

    if (path === "/api/world" && req.method === "GET") {
      const b = await freshWorld();
      const etag = `"w${b.v}"`;
      const headers = { etag, "x-world-v": String(b.v), "cache-control": "no-cache" };
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response((b.json ??= JSON.stringify(b.w)), { headers: { ...headers, "content-type": "application/json" } });
    }
    if (path === "/api/world/ws") return server.upgrade(req, { data: { id: "", world: true } }) ? undefined : new Response("upgrade failed", { status: 400 });

    // Isaac's chat from the event log: to the objective he names, else to the funnel to route.
    if (path === "/api/signals" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { text?: string; objective?: string };
      const text = body.text?.trim();
      if (!text) return new Response("text required", { status: 400 });
      if (body.objective && !objectives.some((o) => o.id === body.objective)) return new Response("no such objective", { status: 404 });
      const routers = body.objective ? routersOf(body.objective) : [];
      const stamped = `${ISAAC_IN_THREAD.replace(", in thread", ", from the event log")}] ${unforge(text)}`;
      // An objective with no router yet gets one, with his words as its first prompt.
      const fresh = body.objective && !routers.length ? startRouter(objectives.find((o) => o.id === body.objective)!, "Whole objective", stamped) : undefined;
      const ev = body.objective
        ? dispatch({ source: "isaac", to: fresh ? [fresh] : routers, objective: body.objective, text, deliver: stamped, typed: !!fresh })
        : dispatch({ source: "isaac", text, deliver: (seq) => `${text}\n[maxflow] signal ${seq}: route it with \`${CLI} route ${seq} <objective id | --new '<title>' --cwd <dir>>\`.` });
      return Response.json(ev, { status: 201 });
    }
    const routeSig = path.match(/^\/api\/signals\/(\d+)\/route$/);
    if (routeSig && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { objective?: string; title?: string; cwd?: string };
      let o = objectives.find((x) => x.id === body.objective);
      if (!o && body.title?.trim()) o = newObjective(body.title.trim(), body.cwd?.replace(/^~(?=\/|$)/, process.env.HOME!) || process.env.HOME!);
      if (!o) return new Response("objective or title required", { status: 400 });
      const to = await reroute(Number(routeSig[1]), o);
      return to ? Response.json({ objective: o.id, routedTo: to.map((s) => s.id) }) : new Response("no such signal", { status: 404 });
    }

    if (path === "/api/objectives" && req.method === "GET") return Response.json(objectives);
    if (path === "/api/objectives" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { title?: string; cwd?: string; scope?: string };
      if (!body.title?.trim()) return new Response("title required", { status: 400 });
      const o = newObjective(body.title.trim(), body.cwd?.replace(/^~(?=\/|$)/, process.env.HOME!) || process.env.HOME!);
      const r = startRouter(o, body.scope?.trim() || "Whole objective");
      return Response.json({ ...o, router: r.id }, { status: 201 });
    }
    const objAct = path.match(/^\/api\/objectives\/([\w-]+)(?:\/(routers|merge))?$/);
    if (objAct) {
      const o = objectives.find((x) => x.id === objAct[1]);
      if (!o) return new Response("no such objective", { status: 404 });
      // Splitting a router: the new one takes the scope, the ones before it keep the rest.
      if (objAct[2] === "routers" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { scope?: string };
        const scope = body.scope?.trim();
        if (!scope) return new Response("scope required", { status: 400 });
        for (const r of routersOf(o.id)) {
          if (r.role!.scope === "Whole objective") setRole(r, { ...r.role!, scope: "Rest of the objective" });
          dispatch({ to: [r], target: o.id, text: `[maxflow] The user split the objective "${o.title}": a new router now owns "${scope}". Your scope is now: ${r.role!.scope}. Hand it anything of yours that falls in that scope.` });
        }
        return Response.json(describe(startRouter(o, scope)), { status: 201 });
      }
      // Merging: the target takes the source's agents, threads, tasks and signals; its routers keep the source's title as their scope.
      if (objAct[2] === "merge" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { into?: string };
        const into = objectives.find((x) => x.id === body.into);
        if (!into || into.id === o.id || into.closed) return new Response("into: an open objective other than this one", { status: 400 });
        const moved = [...sessions.values()].filter((s) => s.role?.objective === o.id);
        for (const s of moved) setRole(s, { ...s.role!, objective: into.id, ...(s.role!.role === "router" && { scope: o.title, merged: true }) });
        for (const t of threads) if (t.objective === o.id) t.objective = into.id;
        for (const t of tasks) if (t.objective === o.id) t.objective = into.id;
        Object.assign(o, { closed: true, mergedInto: into.id, page: [] });
        saveObjectives(), saveThreads(), saveTasks();
        publish(`objective/${o.id}`, { id: o.id, mergedInto: into.id });
        return Response.json({ from: o.id, into: into.id, sessions: moved.map((s) => s.id) });
      }
      if (req.method === "PATCH") {
        const body = (await req.json().catch(() => ({}))) as { title?: string; closed?: boolean };
        if (body.title?.trim()) o.title = body.title.trim();
        if (typeof body.closed === "boolean") o.closed = body.closed;
        saveObjectives();
        return Response.json(o);
      }
    }

    if (path === "/api/threads" && req.method === "GET") return Response.json(threads);
    if (path === "/api/slack/names" && req.method === "GET") return Response.json(slackNames(slackChannels));
    const avatar = path.match(/^\/api\/avatar\/slack\/(\w+)$/);
    if (avatar && req.method === "GET") {
      const file = await slackAvatar(avatar[1], url.searchParams.get("name") ?? "");
      return file ? new Response(Bun.file(file), { headers: { "cache-control": "max-age=86400" } }) : new Response("no picture", { status: 404 });
    }
    if (path === "/api/threads" && req.method === "POST") {
      const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      const body = (await req.json().catch(() => ({}))) as { title?: string; objective?: string; text?: string; parent?: { thread?: string; message?: string } };
      // A subthread: got or made under a message, and the first reply in it posted like any other.
      if (body.parent) {
        const parent = threads.find((x) => x.id === body.parent!.thread);
        const t = parent && subthread(parent, body.parent.message ?? "");
        if (!t) return new Response("parent: {thread, message} naming a message in that thread", { status: 404 });
        if (body.text?.trim()) postIn(t, from, body.text.trim());
        return Response.json(t, { status: 201 });
      }
      // An item from his event feed that no agent owns: a thread in his inbox flagged as from the feed, routed by the funnel like
      // his own messages, so he sees what maxflow started on and can stop it there.
      const feed = (body as { feed?: Feed }).feed;
      if (from && isSentry(from) && feed?.link && body.text?.trim()) {
        const text = body.text.trim();
        const t: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: body.title?.trim().slice(0, 80) || titleOf(`${feed.who}: ${text}`), objective: "", routers: [], messages: feedPosts(text, (body as { posts?: FeedPost[] }).posts), feedSaid: [text], feed, ...(feed.task && { task: feed.task }) };
        threads.push(t);
        await feedToFunnel(t, from, text);
        return Response.json(t, { status: 201 });
      }
      // Isaac's inbox: each message starts a thread, and the funnel picks the router that owns it.
      if (!from && body.text?.trim()) {
        const text = body.text.trim();
        const t: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: titleOf(text), objective: "", routers: [], messages: [message("isaac", text)] };
        const ev = dispatch({ source: "isaac", target: t.title, text, deliver: (seq) => `${text}\n[maxflow] signal ${seq}, his inbox thread ${t.id}: route it with \`${CLI} route ${seq} <objective id | --new '<title>' --cwd <dir>>\`. Always route an inbox thread, small talk included: its router answers him there.` });
        t.signal = ev.seq;
        threads.push(t);
        tellMembers(t, t.messages[0]!, [funnel()].filter(live));
        saveThreads();
        return Response.json(t, { status: 201 });
      }
      const objective = body.objective ?? from?.role?.objective;
      if (!body.title?.trim() || !objective) return new Response("title required, and an objective (a router's own by default)", { status: 400 });
      const t: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: body.title.trim(), objective, routers: from?.role?.role === "router" ? [from.id] : routersOf(objective).map((r) => r.id), messages: [] };
      threads.push(t);
      saveThreads();
      return Response.json(t, { status: 201 });
    }
    // His inbox drew this ask flagged; the 3h default counts from the first time.
    const askShown = path.match(/^\/api\/threads\/([\w-]+)\/shown$/);
    if (askShown && req.method === "POST") {
      const t = threads.find((x) => x.id === askShown[1]);
      if (t?.asks && !t.asks.shown) (t.asks.shown = Date.now()), saveThreads();
      return new Response(null, { status: 204 });
    }
    // The other way: messages on another topic taken out of a thread into one of their own (a DM's second subject that was appended to
    // the first's thread), with a line left where they were. From the feed, the new thread goes to the funnel to route.
    const threadSplit = path.match(/^\/api\/threads\/([\w-]+)\/split$/);
    if (threadSplit && req.method === "POST") {
      const t = live_thread(threads.find((x) => x.id === threadSplit[1]));
      const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      const body = (await req.json().catch(() => ({}))) as { messages?: string[]; title?: string };
      if (!t || !from) return new Response("a thread, split by a session", { status: 404 });
      const moved = t.messages.filter((m) => body.messages?.includes(m.id));
      if (!moved.length || !body.title?.trim()) return new Response("messages: ids in the thread, and a title", { status: 400 });
      t.messages = t.messages.filter((m) => !moved.includes(m));
      const ext = moved.find((m) => m.ext && !m.ext.context)?.ext ?? moved.find((m) => m.ext)?.ext;
      const nt: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: body.title.trim().slice(0, 80), objective: "", routers: [], messages: moved, ...(ext && { feed: { source: ext.source, who: ext.name, link: ext.link }, feedSaid: [] }) };
      threads.push(nt);
      postIn(t, from, `Moved ${moved.length} message${moved.length > 1 ? "s" : ""} about ${nt.title} to [[thread:${nt.id}]].`);
      const said = moved.map((m) => `> **${m.ext ? (m.ext.own ? "Isaac (him, on Slack/GitHub)" : m.ext.name) : m.from === "isaac" ? "Isaac" : m.from}:** ${m.text.replace(/\n/g, "\n> ")}`).join("\n");
      if (nt.feed) (nt.feedSaid = [said]), await feedToFunnel(nt, from, `${nt.feed.who}, moved out of thread ${t.id} as its own topic:\n${said}\n${ext!.link}`);
      saveThreads();
      for (const x of [t, nt]) publish(`thread/${x.id}`, { thread: x.id, split: nt.id });
      return Response.json(nt, { status: 201 });
    }
    // Folding a duplicate thread into another; resolving stays his, so this is the way agents tidy his inbox.
    const threadMerge = path.match(/^\/api\/threads\/([\w-]+)\/merge$/);
    if (threadMerge && req.method === "POST") {
      const from = threads.find((x) => x.id === threadMerge[1]);
      const { into: id } = (await req.json().catch(() => ({}))) as { into?: string };
      const into = live_thread(threads.find((x) => x.id === id));
      if (!from || from.mergedInto) return new Response("no such thread, or it is merged already", { status: 404 });
      if (!into || into === from) return new Response("into: another thread's id", { status: 400 });
      // His messages moved into a resolved or paused thread would be hidden under Resolved or Paused, where he can't find them: the
      // thread comes back, as his own post there would bring it. With none of his, a resolved thread isn't the place for them.
      const his = from.messages.some((m) => m.from === "isaac");
      if (into.resolved && !his) return new Response(`${into.id} is resolved; merge into an open thread instead`, { status: 409 });
      if (his && (into.resolved || into.paused)) {
        const was = into.resolved ? "resolved" : "paused";
        into.resolved = undefined;
        if (into.paused) unpause(into);
        console.log(`merge ${from.id} → ${into.id}: reopened it (${was}), since his messages moved in`);
        publish(`thread/${into.id}`, { thread: into.id, reopened: `merge of ${from.id}, which holds his messages; it was ${was}` });
      }
      mergeThread(from, into);
      return Response.json(into);
    }
    // A router says what it is doing on the answer he waits for; the line goes with the pending state.
    const threadStatus = path.match(/^\/api\/threads\/([\w-]+)\/status$/);
    if (threadStatus && req.method === "POST") {
      const t = threads.find((x) => x.id === threadStatus[1]);
      if (!t) return new Response("no such thread", { status: 404 });
      const text = ((await req.json().catch(() => ({}))) as { text?: string }).text?.trim();
      if (!t.pending) return new Response("nothing pending in this thread: he isn't waiting on an answer", { status: 409 });
      // Kept whole: the pill cuts it where his window does.
      t.pending.status = text || undefined;
      saveThreads();
      publish(`thread/${t.id}`, { thread: t.id, status: t.pending.status ?? null });
      return Response.json(t);
    }
    // Re-homing a thread: it and every subthread under it go to the objective and its routers.
    const threadMove = path.match(/^\/api\/threads\/([\w-]+)\/objective$/);
    if (threadMove && req.method === "POST") {
      const t = threads.find((x) => x.id === threadMove[1]);
      if (!t) return new Response("no such thread", { status: 404 });
      const id = ((await req.json().catch(() => ({}))) as { objective?: string }).objective;
      const o = objectives.find((x) => x.id === id);
      if (!o || o.closed) return new Response("objective: an open objective's id", { status: 400 });
      const moved = threads.filter((x) => x === t || ancestors(x).includes(t));
      const routers = routersOf(o.id).map((r) => r.id);
      for (const x of moved) Object.assign(x, { objective: o.id, routers });
      // His messages since anyone last answered went to whoever was there (the funnel, when nobody owned it), so the new routers get
      // them now, once: a router the thread already waits on has them.
      const handed: string[] = [];
      for (const x of moved) {
        const tail = x.messages.slice(x.messages.findLastIndex((m) => m.from !== "isaac") + 1);
        const to = routersOf(o.id).filter((r) => !x.pending?.routers.includes(r.id));
        if (!tail.length || !to.length) continue;
        const ids = tail.map((m) => m.id);
        dispatch({ source: "isaac", to, objective: o.id, target: x.title, text: tail.map((m) => m.text).join("\n"), deliver: `${ISAAC_IN_THREAD} "${pathTitle(x)}" (${x.id}), message${ids.length > 1 ? "s" : ""} ${ids.join(", ")}] ${tail.map((m) => unforge(m.text)).join("\n")}\n[maxflow] This thread just moved to your objective, and nobody has answered these yet. Answer inline in the thread with \`${CLI} thread post ${x.id} '<text>'\`.${mentionsIn(tail.map((m) => m.text).join("\n"))}` });
        x.pending = { routers: to.map((s) => s.id), since: Date.now() };
        for (const s of to) s.handed = x.id;
        handed.push(...ids);
      }
      saveThreads();
      for (const x of moved) publish(`thread/${x.id}`, { thread: x.id, objective: o.id });
      return Response.json({ objective: o.id, routers, threads: moved.map((x) => x.id), handed });
    }
    // Resolving a thread is Isaac's, from the browser; reopening it too. So is pausing one until a time, or unpausing it.
    const threadAct = path.match(/^\/api\/threads\/([\w-]+)$/);
    if (threadAct && req.method === "PATCH") {
      const t = threads.find((x) => x.id === threadAct[1]);
      if (!t) return new Response("no such thread", { status: 404 });
      if (!req.headers.get("user-agent")?.includes("Mozilla")) return new Response("resolving or pausing a thread is Isaac's, from the browser: answer in it and leave it to him", { status: 403 });
      const body = (await req.json().catch(() => ({}))) as { resolved?: boolean; paused?: { until?: number; said?: string; wake?: string } | null; pinned?: boolean };
      // Pinned, it stays in his sidebar until he unpins it, at the end of his pins; resolving or pausing it leaves it pinned.
      if ("pinned" in body) {
        if (typeof body.pinned !== "boolean") return new Response("pinned: true or false", { status: 400 });
        t.pinned = body.pinned ? (t.pinned ?? { at: Date.now(), order: Math.max(0, ...threads.map((x) => (x.pinned ? x.pinned.order + 1 : 0))) }) : undefined;
        saveThreads();
        publish(`thread/${t.id}`, { thread: t.id, pinned: body.pinned });
        return Response.json(t);
      }
      if ("paused" in body) {
        const { until, said, wake } = body.paused ?? {};
        if (body.paused && (typeof until !== "number" || until <= Date.now())) return new Response("paused: { until: a time to come, in ms, said } or null", { status: 400 });
        if (t.parent) return new Response("only a top thread pauses", { status: 400 });
        if (body.paused) Object.assign(t, { paused: { until, at: Date.now(), said: String(said ?? "").slice(0, 200), count: t.messages.length, ...(typeof wake === "string" && wake.trim() && { wake: wake.trim() }) }, resolved: undefined });
        else unpause(t);
        schedulePause(t);
        saveThreads();
        publish(`thread/${t.id}`, { thread: t.id, paused: !!t.paused });
        return Response.json(t);
      }
      const { resolved } = body;
      if (typeof resolved !== "boolean") return new Response("resolved: true or false", { status: 400 });
      t.resolved = resolved ? { at: Date.now() } : undefined;
      saveThreads();
      publish(`thread/${t.id}`, { thread: t.id, resolved });
      return Response.json(t);
    }
    // The order of his pinned threads, as he dragged them in the sidebar: the ids, first to last.
    if (path === "/api/pins" && req.method === "PATCH") {
      if (!req.headers.get("user-agent")?.includes("Mozilla")) return new Response("pins are Isaac's, from the browser", { status: 403 });
      const { order } = (await req.json().catch(() => ({}))) as { order?: string[] };
      if (!Array.isArray(order)) return new Response("order: the pinned thread ids, first to last", { status: 400 });
      order.forEach((id, i) => {
        const t = threads.find((x) => x.id === id);
        if (t?.pinned) t.pinned.order = i;
      });
      saveThreads();
      publish("pins", { order });
      return new Response(null, { status: 204 });
    }
    const threadPost = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
    if (threadPost && req.method === "POST") {
      const t = live_thread(threads.find((x) => x.id === threadPost[1]));
      if (!t) return new Response("no such thread", { status: 404 });
      // done: from `thread done`, which commands used; it is a plain post now.
      const body = (await req.json().catch(() => ({}))) as { text?: string; nudge?: string; feed?: boolean; posts?: FeedPost[] };
      const text = body.text?.trim();
      if (!text) return new Response("text required", { status: 400 });
      const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      if (body.feed && from && isSentry(from)) return await feedMore(t, from, text, body.posts), Response.json(t, { status: 201 });
      if (from && pointsAtItself(text, t))
        return new Response(`${threadPost[1] !== t.id ? `${threadPost[1]} was merged into ${t.id}, so this would land in ${t.id}` : `This is ${t.id}`}, and a pointer to it there points at itself. Post only what is new for him, or nothing.`, { status: 409 });
      const relay = from === undefined ? undefined : relayRefusal(t, from, text);
      if (relay !== undefined) return new Response(relay, { status: 409 });
      postIn(t, from, text, body.nudge === "subthread" ? "subthread" : undefined);
      return Response.json(t, { status: 201 });
    }

    // An agent edits a card on an objective's or a task's page.
    if (path === "/api/pages" && (req.method === "POST" || req.method === "DELETE")) {
      const body = (await req.json().catch(() => ({}))) as { ref?: string; block?: Block; id?: string };
      const p = pageOf(body.ref ?? "");
      if (!p) return new Response("ref must be objective/<id> or task/<id>", { status: 404 });
      if (req.method === "DELETE") p.page.splice(0, p.page.length, ...p.page.filter((b) => b.id !== body.id));
      else {
        const b = body.block;
        if (!b?.id || !b.kind || !b.w || !b.h) return new Response("block needs id, kind, w and h", { status: 400 });
        const i = p.page.findIndex((x) => x.id === b.id);
        if (i >= 0) p.page[i] = b;
        else p.page.push(b);
      }
      p.save();
      publish(`page/${body.ref}`, { ref: body.ref, block: body.block?.id ?? body.id });
      return Response.json(p.page);
    }

    if (path === "/api/chats" && req.method === "GET") {
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const open = new Map([...sessions.values()].filter((s) => s.chatId && s.exitCode === null).map((s) => [s.chatId!, s.id]));
      const chats = (await listChats())
        .filter((c) => !q || `${c.title} ${c.prompt} ${c.cwd} ${c.id}`.toLowerCase().includes(q))
        .slice(0, limit)
        .map((c) => ({ ...c, session: open.get(c.id) ?? null }));
      return Response.json(chats);
    }

    const resume = path.match(/^\/api\/chats\/([0-9a-f-]{36})\/resume$/);
    if (resume && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { bypass?: boolean; force?: boolean };
      const open = [...sessions.values()].find((s) => s.chatId === resume[1] && s.exitCode === null);
      if (open) return Response.json(describe(open));
      const chat = await findChat(resume[1]);
      if (!chat) return new Response("no such chat", { status: 404 });
      if (chat.live && !body.force) return Response.json({ error: "live", chat }, { status: 409 });
      const cmd = ["claude", "--resume", chat.id, ...(body.bypass ? ["--permission-mode", "bypassPermissions"] : [])];
      return Response.json(describe(createSession(chat.title.slice(0, 40), cmd, chat.cwd, chat.id)), { status: 201 });
    }

    if (path === "/api/sentries/restart" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string; fresh?: boolean };
      const s = [...sessions.values()].find((o) => o.sentry && o.name === body.name && o.exitCode === null);
      if (!s || !(s.name in SENTRIES)) return new Response(`no running sentry ${body.name}`, { status: 404 });
      const r = restartSentry(s, !!body.fresh);
      return r.ok ? Response.json(r) : new Response(`respawning ${s.name} failed; see the log`, { status: 500 });
    }
    if (path === "/api/events" && req.method === "GET") {
      const p = url.searchParams;
      const after = p.get("after") === "now" ? latestSeq() : Number(p.get("after") ?? 0);
      const events = await query(p.get("topic") ?? "**", after, Math.min(Number(p.get("wait") ?? 0), 3_600_000));
      return Response.json(events, { headers: { "x-maxflow-seq": String(after) } });
    }
    if (path === "/api/events" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { topic?: string; data?: unknown };
      if (!body.topic) return new Response("topic required", { status: 400 });
      const ev = publish(body.topic, body.data ?? null);
      onEvent(body.topic, body.data, sessions.get(req.headers.get("x-maxflow-from") ?? ""));
      externalSignal(ev);
      return Response.json(ev, { status: 201 });
    }

    if (path === "/api/favicon" && req.method === "GET") {
      const host = url.searchParams.get("host") ?? "";
      if (!/^[\w.-]+(:\d+)?$/.test(host)) return new Response("bad host", { status: 400 });
      if (!favicons.has(host)) favicons.set(host, fetchFavicon(host));
      return (await favicons.get(host))?.clone() ?? new Response("no favicon", { status: 404 });
    }

    if (path === "/api/review" && req.method === "GET") return Response.json({ board: reviewBoard(), queue: reviewQueue() });

    // An agent using a sentry through the CLI (gh status, slack read, ...), drawn in the graph as it touching that sentry.
    if (path === "/api/touch" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { sentry?: string; kind?: "read" | "write" };
      const to = [...sessions.values()].find((o) => isSentry(o) && o.name === `sentry:${body.sentry}` && o.exitCode === null);
      if (to) touchFrom(req, to, body.kind === "write" ? "write" : "read");
      return new Response(null, { status: 204 });
    }
    // The restrictions hook, on a call a restriction that asks or blocks matches: the verdict, with the session's objective.
    if (path === "/api/restrictions/enforce" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { tool?: string; input?: Record<string, unknown>; cwd?: string; people?: Person[] };
      const s = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      if (!s || !body.tool) return Response.json({ decision: "allow" });
      return Response.json(enforce({ session: s.id, tool: body.tool, input: body.input, cwd: body.cwd, people: body.people, objective: s.role?.objective }, enforcing));
    }
    // `maxflow ask`: an agent's question to the user opens a thread from it, flagged as waiting on him.
    if (path === "/api/asks" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { text?: string; re?: string; default?: string; new?: boolean };
      const s = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      if (!s) return new Response("ask from inside a maxflow session ($MAXFLOW_SESSION)", { status: 400 });
      if (!body.text?.trim()) return new Response("text required", { status: 400 });
      const t = ask(s, body.text.trim(), body.re?.trim() || undefined, body.default?.trim() || undefined, body.new);
      if (t && "same" in t) {
        const by = t.same.asks!.session;
        return new Response(`${t.same.id} already asks him something close, from ${sessions.get(by)?.name ?? names[by] ?? by}: "${t.same.title}". If it's the same ask, add to it with \`${CLI} ask --re ${t.same.id} '<text>'\` and wait on thread:${t.same.id}; if it really is different, ask again with --new.`, { status: 409 });
      }
      return t ? Response.json(t, { status: 201 }) : new Response(`no thread ${body.re}`, { status: 404 });
    }

    if (path === "/api/todos" && req.method === "GET") return Response.json(todos);
    if (path === "/api/stats" && req.method === "GET") return Response.json(await stats(url.searchParams.get("week") ?? undefined, url.searchParams.get("repo") ?? undefined));
    if (path === "/api/stats/calendar" && req.method === "GET") return Response.json(await calendar());
    if (path === "/api/stats/health" && req.method === "GET") return Response.json(health([...sessions.values()].map((s) => describe(s))));
    if (path === "/api/stats/jev" && req.method === "GET") return Response.json(jev(url.searchParams.get("days")));
    if (path === "/api/stats/agents" && req.method === "GET")
      return Response.json(agents(Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7)), [...sessions.values()].map((s) => describe(s)), objectives));
    if (path === "/api/todos" && req.method === "POST") {
      const { text, day } = (await req.json().catch(() => ({}))) as { text?: string; day?: string };
      if (!text?.trim() || !day || !DAY.test(day)) return new Response("text, and day as YYYY-MM-DD", { status: 400 });
      const todo: Todo = { id: crypto.randomUUID().slice(0, 8), text: text.trim(), day, state: "todo", at: new Date().toISOString(), threadIds: [] };
      todos.push(todo), saveTodos();
      return Response.json(todo, { status: 201 });
    }
    // Tagging a thread on a todo, or untagging it; each is idempotent, and answers with the todo.
    const todoThread = path.match(/^\/api\/todos\/([\w-]+)\/threads\/([\w-]+)$/);
    if (todoThread && (req.method === "POST" || req.method === "DELETE")) {
      const [, todoId, threadId] = todoThread;
      const todo = todos.find((t) => t.id === todoId);
      if (!todo) return new Response(`no todo ${todoId}`, { status: 404 });
      if (req.method === "POST") {
        if (!threads.some((t) => t.id === threadId)) return new Response(`no thread ${threadId}`, { status: 404 });
        if (!todo.threadIds.includes(threadId!)) todo.threadIds.push(threadId!);
      } else todo.threadIds = todo.threadIds.filter((id) => id !== threadId);
      saveTodos();
      return Response.json(todo);
    }
    const todoPath = path.match(/^\/api\/todos\/([\w-]+)$/);
    const todo = todoPath && todos.find((t) => t.id === todoPath[1]);
    if (todoPath && !todo) return new Response("no such todo", { status: 404 });
    if (todo && req.method === "PATCH") {
      const edit = (await req.json().catch(() => ({}))) as Partial<Pick<Todo, "text" | "day" | "state">>;
      if (edit.text !== undefined && !edit.text.trim()) return new Response("text can't be empty", { status: 400 });
      if (edit.day !== undefined && !DAY.test(edit.day)) return new Response("day as YYYY-MM-DD", { status: 400 });
      if (edit.state !== undefined && !TODO_STATES.includes(edit.state)) return new Response(`state: one of ${TODO_STATES.join(", ")}`, { status: 400 });
      if (edit.text !== undefined) todo.text = edit.text.trim();
      if (edit.day !== undefined) todo.day = edit.day;
      if (edit.state !== undefined) todo.state = edit.state;
      saveTodos();
      return Response.json(todo);
    }
    if (todo && req.method === "DELETE") return todos.splice(todos.indexOf(todo), 1), saveTodos(), new Response(null, { status: 204 });

    if (path === "/api/restrictions" && req.method === "GET") return Response.json(restrictions);
    if (path === "/api/restrictions" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Partial<Restriction>;
      // An override is named after what it overrides unless he names it.
      const parent = body.parent ? restrictions.find((r) => r.id === body.parent) : undefined;
      const draft = { ...body, label: body.label?.trim() || parent?.label, action: body.action?.trim() || parent?.action, match: body.match ?? {} };
      const bad = invalid(draft, restrictions);
      if (bad) return new Response(bad, { status: 400 });
      const r: Restriction = { id: crypto.randomUUID().slice(0, 8), action: draft.action!, label: draft.label!.trim(), mode: draft.mode!, match: parent ? {} : draft.match, scope: draft.scope, parent: parent?.id, note: draft.note, ...(!parent && draft.reaches && { reaches: draft.reaches }), ...(!parent && draft.about && { about: draft.about }) };
      restrictions.push(r), saveRestrictions(restrictions);
      return Response.json(r, { status: 201 });
    }
    // The mode that applies to a tool call, for `maxflow restrictions check`.
    if (path === "/api/restrictions/check" && req.method === "POST") return Response.json(resolve(restrictions, await req.json().catch(() => ({ tool: "" }))));
    // The people the page offers for a restriction's scope, one a human (restrictions-identities.ts): everyone the slack sentry
    // has heard from, joined to their GitHub login from the PRs the gh sentry polls. Email addresses he types. A listing also
    // gives restrictions naming one account of a linked person the other.
    if (path === "/api/restrictions/people" && req.method === "GET") {
      if (backfill(restrictions)) saveRestrictions(restrictions);
      return Response.json(restrictionPeople());
    }
    // What a custom rule's matchers would have caught among the tool calls agents made lately (restrictions-recent.ts).
    if (path === "/api/restrictions/preview" && req.method === "POST") {
      const { match } = (await req.json().catch(() => ({}))) as { match?: Restriction["match"] };
      const bad = invalid({ label: "x", action: "x", mode: "ask", match: match ?? {} });
      return bad ? new Response(bad, { status: 400 }) : Response.json(preview(match!));
    }
    // The repositories his agents work in, for an exception that holds inside one: each live session's folder, as its git root.
    if (path === "/api/restrictions/repos" && req.method === "GET") return Response.json(restrictionRepos());
    // He links a Slack user to a GitHub login, or unlinks a pair yarn matched or he linked.
    if (path === "/api/restrictions/people/link" && (req.method === "POST" || req.method === "DELETE")) {
      const pair = (await req.json().catch(() => ({}))) as { slack?: string; github?: string };
      if (!pair.slack || !pair.github) return new Response("slack and github required", { status: 400 });
      link({ slack: pair.slack, github: pair.github }, req.method === "POST");
      if (backfill(restrictions, req.method === "DELETE" ? { slack: pair.slack, github: pair.github } : undefined)) saveRestrictions(restrictions);
      return Response.json(restrictionPeople());
    }
    const restrictionPath = path.match(/^\/api\/restrictions\/([\w-]+)$/);
    const restriction = restrictionPath && restrictions.find((r) => r.id === restrictionPath[1]);
    if (restrictionPath && !restriction && (req.method === "PATCH" || req.method === "DELETE")) return new Response("no such restriction", { status: 404 });
    if (restriction && req.method === "PATCH") {
      const edit = (await req.json().catch(() => ({}))) as Partial<Restriction>;
      const next = { ...restriction, ...edit, id: restriction.id, builtin: restriction.builtin, parent: restriction.parent };
      const bad = invalid(next, restrictions);
      if (bad) return new Response(bad, { status: 400 });
      Object.assign(restriction, next), saveRestrictions(restrictions);
      return Response.json(restriction);
    }
    // Its overrides go with it.
    if (restriction && req.method === "DELETE") {
      restrictions.splice(0, restrictions.length, ...restrictions.filter((r) => r.id !== restriction.id && r.parent !== restriction.id));
      return saveRestrictions(restrictions), new Response(null, { status: 204 });
    }

    if (path === "/api/tasks" && req.method === "GET") return Response.json(tasks.map((t) => ({ ...t, prs: prProgress(t) })));
    if (path === "/api/comments" && req.method === "GET") return Response.json(openUserComments());
    const task = path.match(/^\/api\/tasks(?:\/(\d+))?$/);
    if (task && req.method === "POST") {
      const t = task[1] ? tasks.find((o) => o.id === Number(task[1])) : undefined;
      if (task[1] && !t) return new Response("no such task", { status: 404 });
      const done = editTask(t, (await req.json().catch(() => ({}))) as TaskEdit);
      return typeof done === "string" ? new Response(done, { status: 400 }) : Response.json(done, { status: t ? 200 : 201 });
    }
    if (path === "/api/links" && req.method === "GET")
      return Response.json([...sessions.values()].filter((s) => !isSentry(s)).map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, running: s.exitCode === null, candidates: candidates(s) })));

    if (path === "/api/links" && req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { urls?: string[]; archived?: boolean };
      if (!body.urls?.length || typeof body.archived !== "boolean") return new Response("urls and archived required", { status: 400 });
      for (const u of body.urls) body.archived ? archivedLinks.add(u) : archivedLinks.delete(u);
      writeStateJson(ARCHIVED_LINKS, [...archivedLinks]);
      return new Response(null, { status: 204 });
    }

    // yarn as an installed app: its manifest, the service worker that makes it installable (at the root, so its scope is the whole
    // app) and the app icons. Never cached, so a change shows up on the next load.
    const pwa = path === "/manifest.webmanifest" ? ["manifest.webmanifest", "application/manifest+json"] : path === "/sw.js" ? ["sw.js", "text/javascript"] : path.match(/^\/pwa\/([\w-]+\.(?:png|svg))$/) ? [path.slice(5), path.endsWith(".svg") ? "image/svg+xml" : "image/png"] : null;
    if (pwa && req.method === "GET") {
      const file = Bun.file(pwa[0] === "favicon.svg" ? new URL("src/favicon.svg", import.meta.url) : new URL(`src/pwa/${pwa[0]}`, import.meta.url));
      return (await file.exists()) ? new Response(file, { headers: { "content-type": pwa[1], "cache-control": "no-cache" } }) : new Response("not found", { status: 404 });
    }
    // A pasted image is kept as a file, so the text it's pasted into carries a path the receiving agent can read.
    if (path === "/api/uploads" && req.method === "POST") {
      const ext = req.headers.get("content-type")?.match(/^image\/(png|jpeg|gif|webp)$/)?.[1];
      if (!ext) return new Response("png, jpeg, gif or webp image required", { status: 415 });
      mkdirSync(UPLOADS, { recursive: true });
      const file = `${UPLOADS}/${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.${ext === "jpeg" ? "jpg" : ext}`;
      await Bun.write(file, await req.arrayBuffer());
      return Response.json({ path: file });
    }
    const upload = path.match(/^\/api\/uploads\/(\w[\w.-]*)$/);
    if (upload && req.method === "GET") {
      const file = Bun.file(`${UPLOADS}/${upload[1]}`);
      return (await file.exists()) ? new Response(file, { headers: { "cache-control": "max-age=31536000, immutable" } }) : new Response("no such upload", { status: 404 });
    }
    if (path === "/api/link" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { a?: string; b?: string; why?: string };
      const a = sessions.get(body.a ?? ""), b = sessions.get(body.b ?? "");
      if (!a || !b || a === b) return new Response("two sessions required", { status: 400 });
      const why = body.why?.trim();
      introduce(a, b, why), introduce(b, a, why);
      return Response.json([describe(a), describe(b)]);
    }

    const act = path.match(/^\/api\/sessions\/([\w-]+)\/(input|screen|wait|notify|state|intro|await|wake|peer)$/);
    if (act) {
      const s = sessions.get(act[1]);
      if (!s) return new Response("no such session", { status: 404 });
      if (act[2] === "intro" && req.method === "GET") return new Response(intro(s, SENTRY_USES));
      const t = tmuxName(s.id);
      const touch = (kind: "read" | "write", held = false) => touchFrom(req, s, kind, held);
      if (act[2] === "input" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { text?: string; keys?: string[]; enter?: boolean; isaac?: boolean };
        if (s.exitCode !== null) return new Response("session ended", { status: 409 });
        // A shell gets its text as is; an agent is told who typed it.
        const typed: ReturnType<typeof stamp> | { text?: string; request?: undefined } = body.text && isAgent(s) ? stamp(req, body.text, body.isaac) : { text: body.text };
        if ("error" in typed) return new Response(typed.error, { status: 409 });
        if (typed.request) requested(s, typed.request);
        // A session or sentry sending an agent text to submit goes through its inbox like notify: typed only at an idle prompt, and
        // delivered only once claude has it as a prompt. Typed from a plain shell, or left unsubmitted, it goes straight in.
        const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
        const queued = !!typed.text && isAgent(s) && !!body.enter && (!!from || !!body.isaac);
        if (typed.text && isAgent(s)) dispatch({ from, source: body.isaac ? "isaac" : undefined, to: [s], text: body.text!, ...(queued ? { deliver: typed.text } : { typed: true }) });
        touch("write");
        if (typed.text && !queued) await paste(t, typed.text);
        if (body.keys?.length) await tmuxAsync("send-keys", "-t", t, ...body.keys);
        // A TUI like claude reads text + Enter in one burst as a paste, so the submit goes separately.
        if (body.enter && !queued) await Bun.sleep(body.text ? 150 : 0), await pressEnter(t);
        return Response.json(describe(s));
      }
      // Typed by the user into an asleep agent's pane: his own words, delivered once its claude is back.
      if (act[2] === "wake" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { text?: string };
        if (!body.text?.trim()) return new Response("text required", { status: 400 });
        if (s.exitCode !== null) return new Response("session ended", { status: 409 });
        dispatch({ source: "isaac", to: [s], text: body.text.trim() });
        return Response.json(describe(s));
      }
      // An agent's native SendMessage, reported by its PreToolUse hook: logged like any message. Awake, the native send goes
      // through; asleep, it has no claude to land in, so it is queued here instead, which wakes it.
      if (act[2] === "peer" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { text?: string };
        const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
        if (!body.text?.trim() || !from) return new Response("text and a calling session required", { status: 400 });
        const asleep = !!(s.archived || s.asleep) && s.exitCode === null;
        const stamped = stamp(req, body.text.trim());
        dispatch({ from, to: [s], text: body.text.trim(), deliver: "error" in stamped ? body.text.trim() : stamped.text, typed: !asleep });
        if (waitsOn(s, from.id)) endWait(s);
        touch("write");
        return Response.json({ queued: asleep });
      }
      if (act[2] === "notify" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { text?: string; isaac?: boolean };
        if (!body.text?.trim()) return new Response("text required", { status: 400 });
        const stamped = stamp(req, body.text.trim(), body.isaac);
        if ("error" in stamped) return new Response(stamped.error, { status: 409 });
        if (stamped.request) requested(s, stamped.request);
        const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
        dispatch({ from, source: body.isaac ? "isaac" : undefined, to: [s], text: body.text.trim(), deliver: stamped.text });
        // The awaited agent's message ends the wait on it.
        if (waitsOn(s, req.headers.get("x-maxflow-from"))) endWait(s);
        touch("write");
        return Response.json(describe(s), { status: 202 });
      }
      if (act[2] === "state" && req.method === "POST") {
        const { state, transcript } = (await req.json().catch(() => ({}))) as { state?: string; transcript?: string };
        if (!["working", "waiting", "idle", "gone"].includes(state ?? "")) return new Response("state must be working, waiting, idle or gone", { status: 400 });
        if (transcript) setTranscript(s, transcript);
        claudeStateChanged(s, state as ClaudeState | "gone");
        return Response.json(describe(s));
      }
      if (act[2] === "await" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { kind?: string; ref?: string } & Parameters<typeof untilShell>[1];
        // until starts (or finds) the shell first, and waits on it by its id.
        const shell = body.kind === "until" && !body.ref ? untilShell(s, body) : undefined;
        if (typeof shell === "string") return new Response(shell, { status: 409 });
        const err = declareWait(s, body.kind ?? "", shell?.id ?? body.ref?.trim() ?? "", body.desc?.trim());
        return err ? new Response(err, { status: 409 }) : Response.json(describe(s));
      }
      if (act[2] === "screen" && req.method === "GET") return touch("read"), Response.json({ ...describe(s), screen: screen(s, Number(url.searchParams.get("history") ?? 0)) });
      if (act[2] === "wait" && req.method === "GET") {
        const idle = Number(url.searchParams.get("idle") ?? 1500);
        const timeout = Number(url.searchParams.get("timeout") ?? 120_000);
        const match = url.searchParams.get("match");
        const re = match ? new RegExp(match, "m") : null;
        const start = Date.now();
        touch("read", true);
        for (;;) {
          const text = screen(s, 0);
          const reason = s.exitCode !== null ? "exited" : re ? (re.test(text) ? "match" : null) : Date.now() - Math.max(s.lastOutputAt, start) >= idle ? "idle" : null;
          if (reason || Date.now() - start >= timeout) return touch("read"), Response.json({ ...describe(s), reason: reason ?? "timeout", screen: text });
          await Bun.sleep(200);
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    const one = path.match(/^\/api\/sessions\/([\w-]+)$/);
    if (one) {
      const s = sessions.get(one[1]);
      if (!s) return new Response("no such session", { status: 404 });
      if (req.method === "DELETE") {
        publish(`session/${s.id}/killed`, { session: s.id, name: s.name });
        sessions.delete(s.id);
        inboxesTable.delete(s.id);
        tmux("kill-session", "-t", tmuxName(s.id));
        s.proc.kill();
        for (const ws of s.clients) ws.close();
        return new Response(null, { status: 204 });
      }
      if (req.method === "PATCH") {
        const body = (await req.json().catch(() => ({}))) as { name?: string; archived?: boolean };
        // Archiving is the user's, from the browser; an agent that finishes runs `wait done` and stays awake.
        if (body.archived === true && !req.headers.get("user-agent")?.includes("Mozilla"))
          return new Response(`agents don't archive themselves: run \`${CLI} wait done\` (or wait <kind>:<ref>) and end your turn`, { status: 403 });
        if (typeof body.archived === "boolean") {
          setArchived(s, body.archived);
          // Unarchived by hand, a sleeping agent is awake until its next turn ends; only the awaited event ends its wait.
          if (!body.archived) wake(s);
        }
        if (body.name?.trim()) {
          touchFrom(req, s, "write");
          s.name = body.name.trim().slice(0, 80);
          setOption(s.id, "@mf", JSON.stringify({ name: s.name, cmd: s.cmd, cwd: s.cwd, chatId: s.chatId, createdAt: s.createdAt }));
        }
      }
      return Response.json(describe(s));
    }

    // The built-in mock, or real work kept out of the public repo, for showing the UI without a fleet.
    if (path === "/mock.local.json") {
      const file = Bun.file(`${DIR}/mock.local.json`);
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.world) return void openWorld(ws);
      const s = sessions.get(ws.data.id)!;
      s.clients.add(ws);
      ws.sendText("replayed");
      if (s.exitCode !== null) return void s.chunks.forEach((chunk) => ws.sendBinary(chunk));
      ws.data.pty = Bun.spawn([...TMUX, "attach-session", "-t", tmuxName(s.id)], {
        env: termEnv,
        terminal: { cols: 120, rows: 34, data: (_term, data) => ws.sendBinary(new Uint8Array(data)) },
      });
      ws.data.pty.exited.then(() => {
        if (ws.readyState !== 1) return;
        ws.sendBinary(new TextEncoder().encode(`\r\n\x1b[2m[session ended]\x1b[0m\r\n`));
      });
    },
    message(ws, raw) {
      // A tab that missed a patch asks for the whole world again.
      if (ws.data.world) return void (String(raw) === "full" && built && ws.sendText(JSON.stringify({ type: "world", v: built.v, world: built.w })));
      const pty = ws.data.pty;
      if (!pty || pty.exitCode !== null) return;
      const msg = JSON.parse(String(raw)) as { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
      if (msg.type === "input") pty.terminal!.write(msg.data);
      else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) pty.terminal!.resize(msg.cols, msg.rows);
    },
    close(ws) {
      if (ws.data.world) return void worldClients.delete(ws);
      ws.data.pty?.kill();
      sessions.get(ws.data.id)?.clients.delete(ws);
    },
  },
});

console.log(`maxflow listening on http://localhost:${PORT}`);
publish("server/start", { pid: process.pid, commit: Bun.spawnSync(["git", "-C", DIR, "rev-parse", "--short", "HEAD"]).stdout.toString().trim() });
// Who to stop: `./dev.sh stop` kills this pid and nothing else.
writeFileSync(`${STATE_DIR}/server.pid`, String(process.pid));
watch(`${DIR}/src`, { recursive: true }, (_, file) => {
  if (!file || !/\.(tsx?|css)$/.test(file)) return;
  const path = `${DIR}/src/${file}`;
  if (known.has(path) || !existsSync(path)) return;
  known.add(path);
  console.log(`new source file ${file}, restarting so the bundler sees it`);
  setTimeout(() => process.exit(0), 500);
});
for (const f of new Bun.Glob("**/*.{ts,tsx,css}").scanSync(`${DIR}/src`)) known.add(`${DIR}/src/${f}`);
