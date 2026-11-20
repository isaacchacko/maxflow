import type { ServerWebSocket, Subprocess } from "bun";
import { join } from "node:path";
import { BASE as base, PORT } from "../instance";
import { isRecord } from "../shared/guards";
import { DIR, TMUX, stamp } from "./health-agent";

type PanicPage = ReturnType<typeof Bun.serve>;
type WsData = Record<string, never>;
type PanicSocket = ServerWebSocket<WsData>;
type PageHooks = { state: () => unknown; agentTmux: () => string | undefined; release: () => void };
type PtyMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

const HOST = "127.0.0.1";
const XTERM = join(DIR, "node_modules/@xterm");
const APP_FONT_FROM_THE_PACKAGE_THE_APP_BUNDLES = join(DIR, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
const PANIC_HEADERS = { "x-yarn-panic": "1", "x-maxflow-down": "1", "cache-control": "no-store" };
const ROUTES_PREFIX_BEFORE_THE_RENAME = /^\/__down\//;
const XTERM_ASSETS = new Map([
  ["/__panic/xterm.js", "xterm/lib/xterm.js"],
  ["/__panic/xterm.css", "xterm/css/xterm.css"],
  ["/__panic/fit.js", "addon-fit/lib/addon-fit.js"],
]);
const WS_OPEN = 1;
const ptyOf = new WeakMap<PanicSocket, Subprocess>();

const isPtyMessage = (value: unknown): value is PtyMessage =>
  isRecord(value) &&
  ((value["type"] === "input" && typeof value["data"] === "string") || (value["type"] === "resize" && typeof value["cols"] === "number" && typeof value["rows"] === "number"));

function pageResponse(req: Request, didUpgrade: () => boolean, hooks: PageHooks): Response | undefined {
  const path = new URL(req.url).pathname.replace(ROUTES_PREFIX_BEFORE_THE_RENAME, "/__panic/");
  if (path === "/__panic/release" && req.method === "POST") {
    setTimeout(hooks.release, 50);
    return new Response("released");
  }
  if (path === "/__panic/state") return Response.json(hooks.state(), { headers: PANIC_HEADERS });
  if (path === "/__panic/ws") return didUpgrade() ? undefined : new Response("upgrade failed", { status: 400 });
  const asset = XTERM_ASSETS.get(path);
  if (asset !== undefined) return new Response(Bun.file(join(XTERM, asset)));
  if (path === "/__panic/inter.woff2") return new Response(Bun.file(APP_FONT_FROM_THE_PACKAGE_THE_APP_BUNDLES), { headers: { "content-type": "font/woff2" } });
  if (path.startsWith("/api/")) return new Response("yarn is down", { status: 503, headers: PANIC_HEADERS });
  return new Response(Bun.file(join(import.meta.dir, "panic.html")), { headers: { ...PANIC_HEADERS, "content-type": "text/html" } });
}

async function closeWhenPtyExits(ws: PanicSocket, pty: Subprocess) {
  await pty.exited;
  if (ws.readyState === WS_OPEN) ws.close();
}

function attachAgent(ws: PanicSocket, tmux: string | undefined) {
  if (tmux === undefined) {
    ws.close();
    return;
  }
  const pty = Bun.spawn([...TMUX, "attach-session", "-t", tmux], {
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: { cols: 120, rows: 34, data: (_t, data) => ws.sendBinary(new Uint8Array(data)) },
  });
  ptyOf.set(ws, pty);
  void closeWhenPtyExits(ws, pty);
}

function typeIntoAgent(ws: PanicSocket, raw: string | Buffer) {
  const pty = ptyOf.get(ws);
  if (pty?.exitCode !== null) return;
  const msg: unknown = JSON.parse(String(raw));
  if (!isPtyMessage(msg)) return;
  if (msg.type === "input") pty.terminal?.write(msg.data);
  else if (msg.cols > 0 && msg.rows > 0) pty.terminal?.resize(msg.cols, msg.rows);
}

export function servePanicPage(hooks: PageHooks): PanicPage | undefined {
  try {
    const page = Bun.serve<WsData>({
      hostname: HOST,
      port: PORT,
      idleTimeout: 0,
      fetch: (req, server) => pageResponse(req, () => server.upgrade(req, { data: {} }), hooks),
      websocket: {
        open: (ws) => {
          attachAgent(ws, hooks.agentTmux());
        },
        message: typeIntoAgent,
        close: (ws) => {
          ptyOf.get(ws)?.kill();
        },
      },
    });
    console.log(`${stamp()}  server down, serving the panic page on ${base}`);
    return page;
  } catch (error) {
    console.error(`${stamp()}  couldn't take ${base} for the panic page:`, error);
    return undefined;
  }
}
