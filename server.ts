import type { ServerWebSocket, Subprocess } from "bun";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { latestSeq, publish, query } from "./bus";
import { findChat, listChats } from "./chats";
import { repoOf } from "./sentries/gh";
import app from "./src/index.html";

const PORT = Number(process.env.MAXFLOW_PORT ?? 4747);
const HOST = "127.0.0.1";
const SCROLLBACK_BYTES = 2 * 1024 * 1024;
const PUBLIC = new URL("./public/", import.meta.url);

type Session = {
  id: string;
  name: string;
  cmd: string[];
  cwd: string;
  createdAt: number;
  lastOutputAt: number;
  proc: Subprocess;
  chunks: Uint8Array[];
  bytes: number;
  clients: Set<ServerWebSocket<WsData>>;
  exitCode: number | null;
  chatId?: string;
  lastScreen?: string;
  inbox: string[];
  // Reported by the Claude Code hooks in hooks/claude-state.sh; unset while no claude runs in the session.
  claude?: { state: ClaudeState; at: number };
  transcript?: string;
  links?: { found: Candidate[]; offset: number; at: number; repo?: string };
  archived?: boolean;
};
type ClaudeState = "working" | "waiting" | "idle";

// Each browser tab gets its own tmux client, so tmux hands it the full terminal state (modes, screen) on connect.
type WsData = { id: string; pty?: Subprocess };

const sessions = new Map<string, Session>();

// If maxflow itself was launched from a Claude Code session, its markers would make every child claude think it's a subagent.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(k)));
const termEnv = { LANG: "en_US.UTF-8", ...childEnv, TERM: "xterm-256color", COLORTERM: "truecolor" };

// Commands live in tmux sessions on a private socket so they survive server restarts; maxflow only attaches to them.
const TMUX = ["tmux", "-L", "maxflow", "-f", new URL("./tmux.conf", import.meta.url).pathname];
const tmuxName = (id: string) => `mf-${id}`;

// Sync calls block the event loop, which owns the attach clients' ptys; the timeout keeps a stalled tmux from wedging the server.
function tmux(...args: string[]) {
  const r = Bun.spawnSync([...TMUX, ...args], { env: termEnv, timeout: 5000 });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}
// send-keys can wait on tmux flushing to attached clients, which only drain while the event loop runs, so it must not block.
async function tmuxAsync(...args: string[]) {
  const p = Bun.spawn([...TMUX, ...args], { env: termEnv, stdout: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { ok: code === 0, out };
}

function push(session: Session, chunk: Uint8Array) {
  session.chunks.push(chunk);
  session.bytes += chunk.length;
  session.lastOutputAt = Date.now();
  while (session.bytes > SCROLLBACK_BYTES && session.chunks.length > 1) session.bytes -= session.chunks.shift()!.length;
  for (const ws of session.clients) if (!ws.data.pty) ws.sendBinary(chunk);
}

function attachViewer(session: Session, cols = 120, rows = 34) {
  session.proc = Bun.spawn([...TMUX, "attach-session", "-t", tmuxName(session.id)], {
    env: termEnv,
    terminal: { cols, rows, data: (_term, data) => push(session, new Uint8Array(data)) },
  });
  session.proc.exited.then(() => {
    if (sessions.get(session.id) !== session) return;
    if (tmux("has-session", "-t", tmuxName(session.id)).ok) return void setTimeout(() => attachViewer(session, cols, rows), 500);
    session.exitCode = 0;
    push(session, new TextEncoder().encode(`\r\n\x1b[2m[session ended]\x1b[0m\r\n`));
  });
}

function createSession(name: string, cmd: string[], cwd: string, chatId?: string, cols = 120, rows = 34): Session {
  const id = crypto.randomUUID().slice(0, 8);
  const session = { id, name, cmd, cwd, chatId, createdAt: Date.now(), lastOutputAt: Date.now(), chunks: [], bytes: 0, clients: new Set(), exitCode: null, inbox: [] } as unknown as Session;
  const t = tmuxName(id);
  const created = tmux("new-session", "-d", "-s", t, "-x", String(cols), "-y", String(rows), "-c", cwd, "-e", `MAXFLOW_SESSION=${id}`, "--", ...cmd);
  if (!created.ok) throw new Error(`tmux new-session failed for ${cmd.join(" ")}`);
  const meta = { name, cmd, cwd, chatId, createdAt: session.createdAt };
  tmux("set-option", "-t", t, "@mf", JSON.stringify(meta));
  sessions.set(id, session);
  attachViewer(session, cols, rows);
  return session;
}

// Pick up sessions that outlived a previous server, seeding scrollback from tmux's history.
function adoptSessions() {
  for (const t of tmux("list-sessions", "-F", "#{session_name}").out.split("\n")) {
    if (!t.startsWith("mf-")) continue;
    const id = t.slice(3);
    let meta;
    try {
      meta = JSON.parse(tmux("show-options", "-v", "-t", t, "@mf").out);
    } catch {
      meta = { name: t, cmd: [], cwd: "", createdAt: Date.now() };
    }
    const session = { id, ...meta, chunks: [], bytes: 0, clients: new Set(), exitCode: null, inbox: [] } as unknown as Session;
    const hasHistory = Number(tmux("display-message", "-p", "-t", t, "#{history_size}").out) > 0;
    const history = hasHistory ? tmux("capture-pane", "-p", "-e", "-J", "-t", t, "-S", "-", "-E", "-1").out : "";
    if (history.trim()) push(session, new TextEncoder().encode(history.replace(/\n/g, "\r\n")));
    session.lastOutputAt = session.createdAt;
    try {
      session.claude = JSON.parse(tmux("show-options", "-v", "-t", t, "@mf-claude").out);
    } catch {}
    session.transcript = tmux("show-options", "-v", "-t", t, "@mf-transcript").out.trim() || undefined;
    session.archived = tmux("show-options", "-v", "-t", t, "@mf-archived").out.trim() === "1";
    sessions.set(id, session);
    attachViewer(session);
  }
  if (sessions.size) console.log(`adopted ${sessions.size} tmux session(s)`);
}
adoptSessions();

// Sentries are ordinary sessions, started once and kept by tmux across server restarts.
const SENTRIES: Record<string, string[]> = Object.fromEntries(
  ["gh", "slack", "rename", "health", "graph", "review"].map((n) => [`sentry:${n}`, [process.execPath, new URL(`./sentries/${n}.ts`, import.meta.url).pathname]]),
);
if (process.env.MAXFLOW_SENTRIES !== "0")
  for (const [name, cmd] of Object.entries(SENTRIES))
    if (![...sessions.values()].some((s) => s.name === name && s.exitCode === null)) createSession(name, cmd, new URL(".", import.meta.url).pathname);

// What an agent linked to each sentry in the graph is told about it.
const CLI = new URL("./cli.ts", import.meta.url).pathname;
const SENTRY_USES: Record<string, string> = {
  "sentry:gh": `It polls GitHub every 30s for the PRs tied to a session and notifies that session when CI finishes, a review or comment lands (the user's own comments included), or the PR merges, closes or conflicts. A PR whose branch is checked out in your folder, or that you declared with \`~/.claude/set-pr.sh\`, is tied to you already; tie any other with \`${CLI} gh watch <pr>\` (url, owner/repo#n or n). To block on one event instead: \`${CLI} sub 'gh/<owner>/<repo>/pr/<n>/ci'\`.`,
  "sentry:slack": `It polls Slack every minute for the threads, channels and searches tied to a session and notifies that session of each new message. A thread you posted in through the Slack connector is tied to you already, for 3 days after your last post; tie any other with \`${CLI} slack watch <permalink | channel id | #channel | search query>\`. It also publishes every mention of the user as slack/mention: block on one with \`${CLI} sub 'slack/mention'\`, or on a thread with \`${CLI} sub 'slack/<channel>/<thread ts>/reply'\`.`,
  "sentry:health": `It watches the maxflow server itself and, when it stays unreachable for 2 minutes, starts a "maxflow recovery" claude session to fix and restart it.`,
  "sentry:graph": `It decides which URLs you mention show up as nodes beside you in the maxflow graph: only ones you meant the user to open (a PR, a deploy, a page you published, a dev server you started), not incidental ones in code or docs. Put a URL you want the user to see on its own line in your reply. It also groups sessions by the work they share, and the graph draws a group's sessions close together.`,
  "sentry:review": `It lists the user's open PRs that are ready for a reviewer and have none requested yet, and links itself in the graph to the sessions working on them, so the user can pick a reviewer. The gh sentry watches those PRs for you too, so you hear the user's comments on them. Don't request reviewers yourself; the user does.`,
  "sentry:rename": `It titles your session in the maxflow sidebar by the topic you own. Pick your own title with \`${CLI} rename $MAXFLOW_SESSION <title>\` and it leaves you alone from then on.`,
};

const isSentry = (s: Session) => s.name.startsWith("sentry:");
const isAgent = (s: Session) => !!s.claude || !!s.chatId || s.cmd[0] === "claude";

// Without hooks a session counts as working while it prints; hooked claude says so itself, checked against two blind spots:
// an Esc interrupt fires no hook (the spinner animates nonstop while working, so silence means it stopped),
// and a permission dialog answered "no" fires none either (any redraw after the dialog means it was answered).
const BUSY_MS = 4000, SPINNER_GAP_MS = 10_000, DIALOG_SETTLE_MS = 2000;
function status(s: Session) {
  if (s.exitCode !== null) return "exited";
  if (isSentry(s)) return "idle";
  const quiet = Date.now() - s.lastOutputAt;
  if (!s.claude) return quiet < BUSY_MS ? "working" : "idle";
  if (s.claude.state === "working") return quiet < SPINNER_GAP_MS ? "working" : "idle";
  if (s.claude.state === "waiting") return s.lastOutputAt > s.claude.at + DIALOG_SETTLE_MS ? "idle" : "waiting";
  return "idle";
}

function setClaudeState(s: Session, state: ClaudeState | "gone") {
  s.claude = state === "gone" ? undefined : { state, at: Date.now() };
  tmux("set-option", "-t", tmuxName(s.id), "@mf-claude", s.claude ? JSON.stringify(s.claude) : "");
}

function setTranscript(s: Session, path: string) {
  if (!path.endsWith(".jsonl") || path === s.transcript) return;
  s.transcript = path;
  s.links = undefined;
  tmux("set-option", "-t", tmuxName(s.id), "@mf-transcript", path);
}

// Candidate URLs a session has mentioned, PRs named by number included, oldest first, each with who wrote it and the text around it, for sentry:graph to judge.
// Agents are read from their transcript, since claude hard-wraps long URLs on screen; shells from tmux history, which -J rejoins.
// Only text the user or claude wrote counts, not tool output.
type Candidate = { url: string; role: string; context: string };
const PROJECTS = `${process.env.HOME}/.claude/projects`;
const VERDICTS = `${process.env.HOME}/.maxflow/graph-links.json`;
const URL_RE = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/g;
const MAX_CANDIDATES = 40, SHELL_LINKS_MS = 5000, CONTEXT_CHARS = 200;
// A PR named without its URL: owner/repo#n, PR n, PR #n, or a bare #n of 3+ digits, which resolves against the session's repo.
const PR_REF_RE = /\b([\w.-]+\/[\w.-]+)#(\d+)\b|\bPR\s*#?(\d{2,})\b|(?<![\w/&#])#(\d{3,})\b/gi;
const repos = new Map<string, string>();
const repoFor = (cwd: string) => repos.get(cwd) ?? repos.set(cwd, repoOf(cwd)).get(cwd)!;
// GitHub's owner and repo are case-insensitive; one spelling keeps a PR to one node.
const canonical = (url: string) => url.replace(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//i, (m, r) => m.replace(r, r.toLowerCase()));
function candidatesIn(text: string, role: string, repo: string): Candidate[] {
  const around = (at: number, len: number) => text.slice(Math.max(0, at - CONTEXT_CHARS), at + len + CONTEXT_CHARS).replace(/\s+/g, " ").trim();
  const urls = [...text.matchAll(URL_RE)]
    .map((m) => ({ at: m.index, url: canonical(m[0].replace(/[.,;:!?*_~]+$/, "").replace(/\/$/, "")), len: m[0].length }))
    .filter((c) => URL.canParse(c.url) && /^[\w.-]*\w(:\d+)?$/.test(new URL(c.url).host));
  const prs = [...text.replace(URL_RE, (u) => " ".repeat(u.length)).matchAll(PR_REF_RE)].flatMap((m) => {
    const r = m[1]?.toLowerCase() ?? repo;
    return r ? [{ at: m.index, url: `https://github.com/${r}/pull/${m[2] ?? m[3] ?? m[4]}`, len: m[0].length }] : [];
  });
  return [...urls, ...prs].sort((a, b) => a.at - b.at).map((c) => ({ url: c.url, role, context: around(c.at, c.len) }));
}
// A URL mentioned again moves to the end with its newest context, so the cap drops the stalest ones.
const addCandidates = (list: Candidate[], found: Candidate[]) => {
  for (const c of found) {
    const i = list.findIndex((o) => o.url === c.url);
    if (i >= 0) list.splice(i, 1);
    list.push(c);
  }
  list.splice(0, Math.max(0, list.length - MAX_CANDIDATES));
};
// The repo a session's latest command worked in (gh -R/--repo, cd, git -C), for resolving bare PR numbers when its folder is no checkout.
const REPO_HINT_RE = /(?:--repo[ =]|-R )([\w.-]+\/[\w.-]+)|(?:\bcd |git -C )(~?\/[\w./-]+)/g;
function repoHint(rec: any) {
  const calls = rec.type === "assistant" && Array.isArray(rec.message?.content) ? rec.message.content.filter((b: any) => b?.type === "tool_use") : [];
  const hints = calls.flatMap((b: any) => [...JSON.stringify(b.input ?? {}).matchAll(REPO_HINT_RE)]);
  const m = hints.at(-1);
  return m ? (m[1]?.toLowerCase() ?? repoFor(m[2].replace(/^~/, process.env.HOME!))) : "";
}
function textOf(rec: any) {
  if (rec.isMeta || rec.isSidechain || (rec.type !== "user" && rec.type !== "assistant")) return "";
  const c = rec.message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
}
function candidates(s: Session): Candidate[] {
  if (isSentry(s)) return [];
  const l = (s.links ??= { found: [], offset: 0, at: 0 });
  // A resumed chat's transcript is known from its id before any hook reports it.
  if (!s.transcript && s.chatId && !l.at) (l.at = Date.now()), (s.transcript = [...new Bun.Glob(`*/${s.chatId}.jsonl`).scanSync(PROJECTS)].map((f) => `${PROJECTS}/${f}`)[0]);
  if (s.transcript) {
    let buf: Buffer;
    try {
      buf = readFileSync(s.transcript).subarray(l.offset);
    } catch {
      return l.found;
    }
    // Stop at the last full line; a half-written record is read next time.
    const end = buf.lastIndexOf(10) + 1;
    if (end > 0) {
      l.offset += end;
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes("http") && !line.includes("#") && !/\bPR\b/i.test(line) && !line.includes("tool_use")) continue;
        try {
          const rec = JSON.parse(line);
          l.repo = repoHint(rec) || l.repo;
          addCandidates(l.found, candidatesIn(textOf(rec), rec.type, repoFor(s.cwd) || l.repo || ""));
        } catch {}
      }
    }
  } else if (s.exitCode === null && s.lastOutputAt > l.at && Date.now() - l.at > SHELL_LINKS_MS) {
    l.at = Date.now();
    l.found = [];
    for (const line of tmux("capture-pane", "-p", "-J", "-t", tmuxName(s.id), "-S", "-2000").out.split("\n")) addCandidates(l.found, candidatesIn(line, "screen", repoFor(s.cwd)));
  }
  return l.found;
}

// A JSON file sentry:graph writes, reread whenever it changes.
function sentryFile<T>(path: string, empty: T) {
  let mtime = 0, value = empty;
  return () => {
    try {
      const m = statSync(path).mtimeMs;
      if (m !== mtime) (value = JSON.parse(readFileSync(path, "utf8"))), (mtime = m);
    } catch {}
    return value;
  };
}
// Its verdicts, { session: { url: keep } }; a URL it has not judged yet stays hidden.
const verdicts = sentryFile<Record<string, Record<string, boolean>>>(VERDICTS, {});
const links = (s: Session) => candidates(s).filter((c) => verdicts()[s.id]?.[c.url]).map((c) => c.url);
// Whether each PR shown in the graph is open, closed or merged; one GraphQL request per repo, off the event loop.
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
const prStates = new Map<string, string>();
async function refreshPrStates() {
  const shown = [...new Set([...sessions.values()].flatMap((s) => links(s)))];
  const byRepo = Map.groupBy(shown.map((u) => u.match(PR_URL_RE)).filter((m) => m !== null), (m) => m[1]);
  for (const [repo, prs] of byRepo) {
    const [owner, name] = repo.split("/");
    const q = `query { r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prs.map((m) => `p${m[2]}: pullRequest(number: ${m[2]}) { state }`).join(" ")} } }`;
    const p = Bun.spawn(["gh", "api", "graphql", "-f", `query=${q}`], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    let r: Record<string, { state: string } | null> = {};
    try {
      r = JSON.parse(out).data?.r ?? {};
    } catch {}
    for (const m of prs) if (r[`p${m[2]}`]) prStates.set(m[0], r[`p${m[2]}`]!.state.toLowerCase());
  }
}
setInterval(() => refreshPrStates().catch(() => {}), 30_000);
// Links archived from the graph, by URL across every session; the graph greys them out or hides them with archived sessions.
const ARCHIVED_LINKS = `${process.env.HOME}/.maxflow/archived-links.json`;
const archivedLinks = new Set<string>((() => { try { return JSON.parse(readFileSync(ARCHIVED_LINKS, "utf8")) as string[]; } catch { return []; } })());
// Its grouping of sessions by the work they share, { session: group }.
const groups = sentryFile<Record<string, string>>(`${process.env.HOME}/.maxflow/graph-groups.json`, {});
// sentry:review's edges to the sessions on PRs waiting for a reviewer, [{ session, label }].
const reviewEdges = sentryFile<{ session: string; label: string }[]>(`${process.env.HOME}/.maxflow/review-edges.json`, []);

// An edge drawn in the graph: tell each agent end who is on the other side and how to reach it.
function introduce(to: Session, other: Session, why?: string) {
  if (!isAgent(to) || to.exitCode !== null) return;
  const who = `"${other.name}" (session ${other.id}, in ${other.cwd})`;
  const reason = why ? ` Why, in the user's words: "${why}".` : "";
  const text = isSentry(other)
    ? `[maxflow] The user linked you to the ${other.name.slice(7)} sentry; it might be useful to you.${reason} ${SENTRY_USES[other.name] ?? `Its source is in ${new URL("./sentries/", import.meta.url).pathname}.`}`
    : isAgent(other)
      ? `[maxflow] The user linked you with another agent, ${who}, and wants you two talking; it got this same note about you.${reason} Start now: message it what you're working on and what you could use from it or offer it, then answer what it sends you. Keep it going while it helps; drop it once it doesn't. Message it with \`${CLI} notify ${other.id} '<text>'\` (typed into its prompt once it is idle; say you are session ${to.id} so it can answer), and read its screen with \`${CLI} screen ${other.id} --history 200\`.`
      : `[maxflow] The user linked you with the terminal session ${who}, running \`${other.cmd.join(" ")}\`; it may matter to your work.${reason} Read it with \`${CLI} screen ${other.id} --history 200\`, type into it with \`${CLI} send ${other.id} '<text>'\`.`;
  to.inbox.push(text);
}

// A claude's TUI redraws nonstop, so for an agent its last transcript write is what counts as activity.
function activeAt(s: Session) {
  if (s.transcript) {
    try {
      return statSync(s.transcript).mtimeMs;
    } catch {}
  }
  return isAgent(s) ? (s.claude?.at ?? s.createdAt) : s.lastOutputAt;
}

const describe = (s: Session, shown = links(s)) => ({
  id: s.id,
  name: s.name,
  cmd: s.cmd,
  cwd: s.cwd,
  createdAt: s.createdAt,
  lastOutputAt: s.lastOutputAt,
  activeAt: activeAt(s),
  clients: s.clients.size,
  running: s.exitCode === null,
  exitCode: s.exitCode,
  chatId: s.chatId,
  transcript: s.transcript,
  pending: s.inbox.length,
  status: status(s),
  agent: isAgent(s),
  links: shown,
  archivedLinks: shown.filter((u) => archivedLinks.has(u)),
  prs: Object.fromEntries(shown.flatMap((u) => (prStates.has(u) ? [[u, prStates.get(u)]] : []))),
  group: groups()[s.id] ?? null,
  archived: !!s.archived,
  ties: s.name === "sentry:review" ? reviewEdges() : [],
});

// Plain text of the visible pane plus `history` lines above it, trailing blank lines dropped.
function screen(s: Session, history: number) {
  const live = s.exitCode === null && tmux("capture-pane", "-p", "-J", "-t", tmuxName(s.id), ...(history > 0 ? ["-S", String(-history)] : []));
  if (live && live.ok) return (s.lastScreen = live.out.trimEnd());
  // The pane is gone once the command exits; fall back to the last capture, else a rough strip of the raw stream.
  return s.lastScreen ?? new TextDecoder().decode(Buffer.concat(s.chunks)).replace(/\x1b\[[\d;]*[HfABCDG]/g, "\n").replace(/\x1b(\][^\x07]*\x07|\[[\d;?<>=]*[ -/]*[@-~]|[()][\w]|.)/g, "").replace(/\n\s*\n+/g, "\n").trimEnd();
}

// True when claude sits at an empty input box: the line under the box's top border holds only `❯` and dim placeholder text.
function atEmptyPrompt(s: Session) {
  const lines = tmux("capture-pane", "-p", "-e", "-t", tmuxName(s.id)).out.split("\n");
  const plain = (l: string) => l.replace(/\x1b\[[\d;]*m/g, "");
  const i = lines.findLastIndex((l, i) => i > 0 && plain(l).startsWith("❯") && /^─{10,}$/.test(plain(lines[i - 1]).trim()));
  if (i < 0) return false;
  const rest = lines[i].slice(lines[i].indexOf("❯") + 1).replace(/^[\s\u00a0]+/, "");
  return rest.startsWith("\x1b[2m") || plain(rest).trim() === "";
}

// Notifications wait until the agent is idle at its prompt, so they never land mid-turn or in a permission dialog.
const DELIVER_IDLE_MS = 4000;
setInterval(async () => {
  for (const s of sessions.values()) {
    if (!s.inbox.length || s.exitCode !== null || Date.now() - s.lastOutputAt < DELIVER_IDLE_MS || !atEmptyPrompt(s)) continue;
    const text = s.inbox.splice(0).join("\n");
    await tmuxAsync("send-keys", "-t", tmuxName(s.id), "-l", "--", text);
    await Bun.sleep(150);
    await tmuxAsync("send-keys", "-t", tmuxName(s.id), "Enter");
  }
}, 1000);

// Only pages served from this server may drive it; blocks other sites from reaching localhost.
function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = new URL(origin).host;
  return host === `localhost:${PORT}` || host === `${HOST}:${PORT}`;
}

Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0, // `wait` and event subscriptions long-poll
  development: { hmr: true },
  routes: { "/": app, "/s/*": app },
  async fetch(req, server) {
    if (!sameOrigin(req)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const path = url.pathname;

    const wsMatch = path.match(/^\/ws\/([\w-]+)$/);
    if (wsMatch) {
      if (!sessions.has(wsMatch[1])) return new Response("no such session", { status: 404 });
      return server.upgrade(req, { data: { id: wsMatch[1] } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (path === "/api/sessions" && req.method === "GET") return Response.json([...sessions.values()].map((s) => describe(s)));
    if (path === "/api/sessions" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string; cmd?: string[] | string; cwd?: string };
      const cmd = typeof body.cmd === "string" ? ["zsh", "-lc", body.cmd] : body.cmd?.length ? body.cmd : [process.env.SHELL ?? "zsh", "-l"];
      const s = createSession(body.name || cmd.join(" ").slice(0, 40), cmd, body.cwd?.replace(/^~(?=\/|$)/, process.env.HOME!) || process.env.HOME!);
      return Response.json(describe(s), { status: 201 });
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

    if (path === "/api/events" && req.method === "GET") {
      const p = url.searchParams;
      const after = p.get("after") === "now" ? latestSeq() : Number(p.get("after") ?? 0);
      const events = await query(p.get("topic") ?? "**", after, Math.min(Number(p.get("wait") ?? 0), 3_600_000));
      return Response.json(events, { headers: { "x-maxflow-seq": String(after) } });
    }
    if (path === "/api/events" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { topic?: string; data?: unknown };
      if (!body.topic) return new Response("topic required", { status: 400 });
      return Response.json(publish(body.topic, body.data ?? null), { status: 201 });
    }

    if (path === "/api/links" && req.method === "GET")
      return Response.json([...sessions.values()].filter((s) => !isSentry(s)).map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, running: s.exitCode === null, candidates: candidates(s) })));

    if (path === "/api/links" && req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { urls?: string[]; archived?: boolean };
      if (!body.urls?.length || typeof body.archived !== "boolean") return new Response("urls and archived required", { status: 400 });
      for (const u of body.urls) body.archived ? archivedLinks.add(u) : archivedLinks.delete(u);
      writeFileSync(ARCHIVED_LINKS, JSON.stringify([...archivedLinks]));
      return new Response(null, { status: 204 });
    }

    if (path === "/api/link" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { a?: string; b?: string; why?: string };
      const a = sessions.get(body.a ?? ""), b = sessions.get(body.b ?? "");
      if (!a || !b || a === b) return new Response("two sessions required", { status: 400 });
      const why = body.why?.trim();
      introduce(a, b, why), introduce(b, a, why);
      return Response.json([describe(a), describe(b)]);
    }

    const act = path.match(/^\/api\/sessions\/([\w-]+)\/(input|screen|wait|notify|state)$/);
    if (act) {
      const s = sessions.get(act[1]);
      if (!s) return new Response("no such session", { status: 404 });
      const t = tmuxName(s.id);
      if (act[2] === "input" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { text?: string; keys?: string[]; enter?: boolean };
        if (s.exitCode !== null) return new Response("session ended", { status: 409 });
        if (body.text) await tmuxAsync("send-keys", "-t", t, "-l", "--", body.text);
        if (body.keys?.length) await tmuxAsync("send-keys", "-t", t, ...body.keys);
        // A TUI like claude reads text + Enter in one burst as a paste, so the submit goes separately.
        if (body.enter) await Bun.sleep(body.text ? 150 : 0), await tmuxAsync("send-keys", "-t", t, "Enter");
        return Response.json(describe(s));
      }
      if (act[2] === "notify" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { text?: string };
        if (!body.text?.trim()) return new Response("text required", { status: 400 });
        s.inbox.push(body.text.trim());
        return Response.json(describe(s), { status: 202 });
      }
      if (act[2] === "state" && req.method === "POST") {
        const { state, transcript } = (await req.json().catch(() => ({}))) as { state?: string; transcript?: string };
        if (!["working", "waiting", "idle", "gone"].includes(state ?? "")) return new Response("state must be working, waiting, idle or gone", { status: 400 });
        setClaudeState(s, state as ClaudeState | "gone");
        if (transcript) setTranscript(s, transcript);
        return Response.json(describe(s));
      }
      if (act[2] === "screen" && req.method === "GET") return Response.json({ ...describe(s), screen: screen(s, Number(url.searchParams.get("history") ?? 0)) });
      if (act[2] === "wait" && req.method === "GET") {
        const idle = Number(url.searchParams.get("idle") ?? 1500);
        const timeout = Number(url.searchParams.get("timeout") ?? 120_000);
        const match = url.searchParams.get("match");
        const re = match ? new RegExp(match, "m") : null;
        const start = Date.now();
        for (;;) {
          const text = screen(s, 0);
          const reason = s.exitCode !== null ? "exited" : re ? (re.test(text) ? "match" : null) : Date.now() - Math.max(s.lastOutputAt, start) >= idle ? "idle" : null;
          if (reason || Date.now() - start >= timeout) return Response.json({ ...describe(s), reason: reason ?? "timeout", screen: text });
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
        sessions.delete(s.id);
        tmux("kill-session", "-t", tmuxName(s.id));
        s.proc.kill();
        for (const ws of s.clients) ws.close();
        return new Response(null, { status: 204 });
      }
      if (req.method === "PATCH") {
        const body = (await req.json().catch(() => ({}))) as { name?: string; archived?: boolean };
        if (typeof body.archived === "boolean") {
          s.archived = body.archived;
          tmux("set-option", "-t", tmuxName(s.id), "@mf-archived", body.archived ? "1" : "0");
        }
        if (body.name?.trim()) {
          s.name = body.name.trim().slice(0, 80);
          tmux("set-option", "-t", tmuxName(s.id), "@mf", JSON.stringify({ name: s.name, cmd: s.cmd, cwd: s.cwd, chatId: s.chatId, createdAt: s.createdAt }));
        }
      }
      return Response.json(describe(s));
    }

    const file = Bun.file(new URL(path === "/" || path.startsWith("/s/") ? "index.html" : path.slice(1), PUBLIC));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
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
      const pty = ws.data.pty;
      if (!pty || pty.exitCode !== null) return;
      const msg = JSON.parse(String(raw)) as { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
      if (msg.type === "input") pty.terminal!.write(msg.data);
      else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) pty.terminal!.resize(msg.cols, msg.rows);
    },
    close(ws) {
      ws.data.pty?.kill();
      sessions.get(ws.data.id)?.clients.delete(ws);
    },
  },
});

console.log(`maxflow listening on http://localhost:${PORT}`);
