import type { ServerWebSocket, Subprocess } from "bun";
import { findChat, listChats } from "./chats";

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
  proc: Subprocess;
  chunks: Uint8Array[];
  bytes: number;
  clients: Set<ServerWebSocket<{ id: string }>>;
  exitCode: number | null;
  chatId?: string;
};

const sessions = new Map<string, Session>();

// If maxflow itself was launched from a Claude Code session, its markers would make every child claude think it's a subagent.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(k)));
const termEnv = { LANG: "en_US.UTF-8", ...childEnv, TERM: "xterm-256color", COLORTERM: "truecolor" };

// Commands live in tmux sessions on a private socket so they survive server restarts; maxflow only attaches to them.
const TMUX = ["tmux", "-L", "maxflow", "-f", new URL("./tmux.conf", import.meta.url).pathname];
const tmuxName = (id: string) => `mf-${id}`;

function tmux(...args: string[]) {
  const r = Bun.spawnSync([...TMUX, ...args], { env: termEnv });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

function push(session: Session, chunk: Uint8Array) {
  session.chunks.push(chunk);
  session.bytes += chunk.length;
  while (session.bytes > SCROLLBACK_BYTES && session.chunks.length > 1) session.bytes -= session.chunks.shift()!.length;
  for (const ws of session.clients) ws.sendBinary(chunk);
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
  const session = { id, name, cmd, cwd, chatId, createdAt: Date.now(), chunks: [], bytes: 0, clients: new Set(), exitCode: null } as unknown as Session;
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
    const session = { id, ...meta, chunks: [], bytes: 0, clients: new Set(), exitCode: null } as unknown as Session;
    const hasHistory = Number(tmux("display-message", "-p", "-t", t, "#{history_size}").out) > 0;
    const history = hasHistory ? tmux("capture-pane", "-p", "-e", "-J", "-t", t, "-S", "-", "-E", "-1").out : "";
    if (history.trim()) push(session, new TextEncoder().encode(history.replace(/\n/g, "\r\n")));
    sessions.set(id, session);
    attachViewer(session);
  }
  if (sessions.size) console.log(`adopted ${sessions.size} tmux session(s)`);
}
adoptSessions();

const describe = (s: Session) => ({
  id: s.id,
  name: s.name,
  cmd: s.cmd,
  cwd: s.cwd,
  createdAt: s.createdAt,
  clients: s.clients.size,
  running: s.exitCode === null,
  exitCode: s.exitCode,
  chatId: s.chatId,
});

// Only pages served from this server may drive it; blocks other sites from reaching localhost.
function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = new URL(origin).host;
  return host === `localhost:${PORT}` || host === `${HOST}:${PORT}`;
}

Bun.serve<{ id: string }>({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    if (!sameOrigin(req)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const path = url.pathname;

    const wsMatch = path.match(/^\/ws\/([\w-]+)$/);
    if (wsMatch) {
      if (!sessions.has(wsMatch[1])) return new Response("no such session", { status: 404 });
      return server.upgrade(req, { data: { id: wsMatch[1] } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (path === "/api/sessions" && req.method === "GET") return Response.json([...sessions.values()].map(describe));
    if (path === "/api/sessions" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string; cmd?: string[] | string; cwd?: string };
      const cmd = typeof body.cmd === "string" ? ["zsh", "-lc", body.cmd] : body.cmd?.length ? body.cmd : [process.env.SHELL ?? "zsh", "-l"];
      const s = createSession(body.name || cmd.join(" ").slice(0, 40), cmd, body.cwd || process.env.HOME!);
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
      return Response.json(describe(s));
    }

    const file = Bun.file(new URL(path === "/" || path.startsWith("/s/") ? "index.html" : path.slice(1), PUBLIC));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const s = sessions.get(ws.data.id)!;
      for (const chunk of s.chunks) ws.sendBinary(chunk);
      ws.sendText("replayed");
      s.clients.add(ws);
    },
    message(ws, raw) {
      const s = sessions.get(ws.data.id);
      if (!s || s.exitCode !== null) return;
      const msg = JSON.parse(String(raw)) as { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
      if (msg.type === "input") s.proc.terminal!.write(msg.data);
      else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) s.proc.terminal!.resize(msg.cols, msg.rows);
    },
    close(ws) {
      sessions.get(ws.data.id)?.clients.delete(ws);
    },
  },
});

console.log(`maxflow listening on http://localhost:${PORT}`);
