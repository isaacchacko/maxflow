import type { ServerWebSocket, Subprocess } from "bun";

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
};

const sessions = new Map<string, Session>();

function createSession(name: string, cmd: string[], cwd: string, cols = 120, rows = 34): Session {
  const id = crypto.randomUUID().slice(0, 8);
  const session = { id, name, cmd, cwd, createdAt: Date.now(), chunks: [], bytes: 0, clients: new Set(), exitCode: null } as unknown as Session;
  session.proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", MAXFLOW_SESSION: id },
    terminal: {
      cols,
      rows,
      data(_term, data) {
        const chunk = new Uint8Array(data);
        session.chunks.push(chunk);
        session.bytes += chunk.length;
        while (session.bytes > SCROLLBACK_BYTES && session.chunks.length > 1) session.bytes -= session.chunks.shift()!.length;
        for (const ws of session.clients) ws.sendBinary(chunk);
      },
    },
  });
  session.proc.exited.then((code) => {
    session.exitCode = code;
    const note = new TextEncoder().encode(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
    session.chunks.push(note);
    for (const ws of session.clients) ws.sendBinary(note);
  });
  sessions.set(id, session);
  return session;
}

const describe = (s: Session) => ({
  id: s.id,
  name: s.name,
  cmd: s.cmd,
  cwd: s.cwd,
  createdAt: s.createdAt,
  clients: s.clients.size,
  running: s.exitCode === null,
  exitCode: s.exitCode,
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

    const one = path.match(/^\/api\/sessions\/([\w-]+)$/);
    if (one) {
      const s = sessions.get(one[1]);
      if (!s) return new Response("no such session", { status: 404 });
      if (req.method === "DELETE") {
        s.proc.kill();
        for (const ws of s.clients) ws.close();
        sessions.delete(s.id);
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
