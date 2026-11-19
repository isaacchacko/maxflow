import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { inboxesTable, slackMessagesTable, writeStateJson } from "./state";
import { publish } from "./bus";
import { BASE, CLI, DIR, INSTANCE, LIVE, PORT, STATE_DIR } from "./instance";
import app from "./src/index.html";
import { TMUX, flushOptions, setOption, termEnv, tmux, tmuxAsync, tmuxName } from "./tmux";
import { type Session, type Wait, type WsData, isAgent, isSentry, sessions } from "./sessions";
import type { Message, Thread } from "./model";
import { live, saveThreads, tasks, threads, threadsDirty, writeThreads } from "./stores";
import { DEFAULT_AFTER_H, DEFAULT_AFTER_MS } from "./intro";
import { SessionCap, attachViewer, createSession, derive, dispatch, push, setClaudeState, setWait, settleTasks, stopAgent, wake } from "./lifecycle";
import { checkShells } from "./waits";
import { answered, headline, message, pauseTimers, resurface, schedulePause } from "./threads";
import { DRAFTS, deliver } from "./delivery";
import { RESYNC_MS, resync } from "./turns";
import { docsRoute } from "./docs-api";
import { sizingRoute } from "./sizing";
import { built, judged, openWorld, prStates, worldClients } from "./world";
import { EXTERNAL_SEEN, externalSeen, externalSignal, known } from "./routing";
import { recordUserComment, seedUserComments } from "./events";
import { restrictionsRoute } from "./routes-restrictions";
import { statsTodosRoute } from "./routes-stats";
import { tasksLinksRoute } from "./routes-tasks";
import { browserRoute } from "./routes-browser";
import { keepReapingBrowsers } from "./browsers";
import { closeViewer, openViewer, viewerAsked } from "./browser-screencast";
import { SENTRIES } from "./sentry-commands";
import { BARE_AGENT_SENTRIES, FED_AGENT_SENTRIES } from "./sentry-names";
import { miscRoute } from "./routes-misc";
import { objectivesRoute } from "./routes-objectives";
import { sessionRoute } from "./routes-session";
import { signalsRoute } from "./routes-signals";
import { threadsRoute } from "./routes-threads";
import { sessionsWorldRoute } from "./routes-sessions";
import { filesRoute } from "./routes-files";

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
// The agent sentries are claude agents; a fed one runs its feed beside it, logging out of the way of its screen.
const reviewSource = (f: string) => new URL(`./sentries/${f}`, import.meta.url).pathname;
for (const n of FED_AGENT_SENTRIES)
  SENTRIES[`sentry:${n}`] = ["sh", "-c",
    `"${process.execPath}" "${reviewSource(`${n}.ts`)}" >"${STATE_DIR}/${n}-feed.log" 2>&1 & exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${reviewSource(`${n}.md`)}")"`];
for (const n of BARE_AGENT_SENTRIES)
  SENTRIES[`sentry:${n}`] = ["sh", "-c", `exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${reviewSource(`${n}.md`)}")"`];
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
for (const s of sessions.values()) if (existsSync(`${DRAFTS}/${s.id}.txt`)) s.savedDraft = readFileSync(`${DRAFTS}/${s.id}.txt`, "utf8");
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
keepReapingBrowsers((id) => sessions.get(id)?.exitCode === null);
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

    const castMatch = /^\/ws\/browser\/([\w-]+)$/.exec(path);
    if (castMatch) return server.upgrade(req, { data: { id: castMatch[1] ?? "", browser: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
    const wsMatch = path.match(/^\/ws\/([\w-]+)$/);
    if (wsMatch) {
      if (!sessions.has(wsMatch[1])) return new Response("no such session", { status: 404 });
      return server.upgrade(req, { data: { id: wsMatch[1] } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (path === "/api/instance") return Response.json({ instance: INSTANCE || "live", port: PORT, pid: process.pid });
    const docs = await docsRoute(req, url);
    if (docs) return docs;
    const sized = await sizingRoute(req, url);
    if (sized) return sized;
    const sessionsWorldRouteAnswer = await sessionsWorldRoute(req, url, path, server);
    if (sessionsWorldRouteAnswer) return sessionsWorldRouteAnswer;
    const signalsRouteAnswer = await signalsRoute(req, url, path);
    if (signalsRouteAnswer) return signalsRouteAnswer;
    const objectivesRouteAnswer = await objectivesRoute(req, url, path);
    if (objectivesRouteAnswer) return objectivesRouteAnswer;
    const threadsRouteAnswer = await threadsRoute(req, url, path);
    if (threadsRouteAnswer) return threadsRouteAnswer;
    const browserAnswer = await browserRoute(req, path);
    if (browserAnswer) return browserAnswer;
    const miscRouteAnswer = await miscRoute(req, url, path);
    if (miscRouteAnswer) return miscRouteAnswer;
    const statsTodosRouteAnswer = await statsTodosRoute(req, url, path);
    if (statsTodosRouteAnswer) return statsTodosRouteAnswer;
    const restrictionsRouteAnswer = await restrictionsRoute(req, url, path);
    if (restrictionsRouteAnswer) return restrictionsRouteAnswer;
    const tasksLinksRouteAnswer = await tasksLinksRoute(req, url, path);
    if (tasksLinksRouteAnswer) return tasksLinksRouteAnswer;
    const filesRouteAnswer = await filesRoute(req, url, path);
    if (filesRouteAnswer) return filesRouteAnswer;
    const sessionRouteAnswer = await sessionRoute(req, url, path);
    if (sessionRouteAnswer) return sessionRouteAnswer;

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
      if (ws.data.browser) {
        void openViewer(ws);
        return;
      }
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
      if (ws.data.browser) {
        void viewerAsked(ws, String(raw));
        return;
      }
      if (ws.data.world) return void (String(raw) === "full" && built && ws.sendText(JSON.stringify({ type: "world", v: built.v, world: built.w })));
      const pty = ws.data.pty;
      if (!pty || pty.exitCode !== null) return;
      const msg = JSON.parse(String(raw)) as { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
      if (msg.type === "input") pty.terminal!.write(msg.data);
      else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) pty.terminal!.resize(msg.cols, msg.rows);
    },
    close(ws) {
      if (ws.data.world) return void worldClients.delete(ws);
      if (ws.data.browser) {
        closeViewer(ws);
        return;
      }
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

