#!/usr/bin/env bun
// health sentry: the moment the maxflow server stops answering, it takes over the port with a "down" page, and if the
// server stays down it starts a claude agent to fix it, shown live on that page. A frontend build that stays broken
// while the API still answers gets an agent too.
// It runs in tmux, so it outlives the server it watches, and it starts the agent straight in tmux for the same reason;
// the server adopts that session like any other once it is back.
import type { ServerWebSocket, Subprocess } from "bun";
import { join } from "node:path";

const INTERVAL_MS = Number(process.env.HEALTH_INTERVAL ?? 1000);
const PAGE_AFTER_MS = Number(process.env.HEALTH_PAGE_AFTER_MS ?? 3000);
const DOWN_MS = Number(process.env.HEALTH_DOWN_MS ?? 45_000);
// Hot reload catches agents mid-edit, so a build broken for a few seconds is normal; only one that stays broken counts.
const BUILD_DOWN_MS = Number(process.env.HEALTH_BUILD_DOWN_MS ?? 60_000);
const BUILD_EVERY_MS = 5000;
const COOLDOWN_MS = Number(process.env.HEALTH_COOLDOWN_MS ?? 15 * 60_000);
// After handing the port back, give the server this long to bind before covering for it again.
const RELEASE_GRACE_MS = 15_000;
const LABEL = "com.isaacchacko.maxflow";
const LOG = "/tmp/maxflow.log";
const DIR = join(import.meta.dir, "..");
const TMUX = ["tmux", "-L", "maxflow", "-f", join(DIR, "tmux.conf")];
const HOST = "127.0.0.1";
const PORT = Number(process.env.MAXFLOW_PORT ?? 4747);
const base = `http://localhost:${PORT}`;
const XTERM = join(DIR, "node_modules/@xterm");

const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd);
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};
const launchd = () => run(["launchctl", "print", `gui/${process.getuid!()}/${LABEL}`]);
const stamp = () => new Date().toLocaleTimeString();

// "refused" means nothing holds the port, so the down page can take it; "hung" means something holds it without answering.
async function probe(): Promise<"up" | "refused" | "hung"> {
  try {
    return (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) })).ok ? "up" : "hung";
  } catch (e) {
    return String((e as { code?: string }).code ?? e).includes("ConnectionRefused") ? "refused" : "hung";
  }
}

// Bun's dev server answers the page with a 500 "Build Failed" while any file in the bundle doesn't parse or resolve.
async function buildOk() {
  try {
    return (await fetch(base, { signal: AbortSignal.timeout(10_000) })).status !== 500;
  } catch {
    return true; // unreachable is the down path's business
  }
}

const RULES = `Other agents edit this repo with uncommitted work in the tree: fix the breakage in place rather than reverting or stashing their changes, and don't commit. Don't kill any tmux session on the maxflow socket; they are the user's running work. When it is fixed, say in a few lines what broke and what you changed.`;

function downTask(since: number) {
  const status = launchd().out.split("\n").filter((l) => /state =|runs =|last exit|pid =/.test(l)).join("\n");
  return `The maxflow server (${DIR}, launchd agent ${LABEL}, ${base}) has not answered since ${new Date(since).toLocaleTimeString()}, so the health sentry started you to bring it back. The user is watching you on the health sentry's "down" page, which holds the port until the server asks for it at startup.

launchd says:
${status}

Last lines of ${LOG}:
${run(["tail", "-n", "80", LOG]).out}

Find the root cause and fix it, then restart with \`launchctl kickstart -k gui/$(id -u)/${LABEL}\` and confirm \`curl -s ${base}/api/sessions\` answers with the session list. ${RULES}`;
}

function buildTask(since: number) {
  return `The maxflow frontend (${DIR}/src, bundled by Bun's dev server with hot reload) has failed to build since ${new Date(since).toLocaleTimeString()}: ${base}/ answers 500 "Build Failed" while the API still works, so the user's UI is broken. The health sentry started you to fix it.

Last lines of ${LOG} (the build error is in there):
${run(["tail", "-n", "80", LOG]).out}

The cause is usually another agent's edit caught halfway: a file cut off, or an import of a file not written yet. Check \`git status\`/\`git diff\` and which maxflow session is editing that file (\`./cli.ts ls\`, \`./cli.ts screen <id>\`); if its agent is still working on it, finish the edit the way it was clearly heading. Hot reload picks up the fix, no restart needed: confirm \`curl -s -o /dev/null -w '%{http_code}' ${base}/\` gives 200. ${RULES}`;
}

function startAgent(prompt: string) {
  const id = crypto.randomUUID().slice(0, 8);
  const meta = { name: "maxflow recovery", cmd: ["claude"], cwd: DIR, createdAt: Date.now() };
  const t = `mf-${id}`;
  const created = run([...TMUX, "new-session", "-d", "-s", t, "-x", "120", "-y", "34", "-c", DIR, "-e", `MAXFLOW_SESSION=${id}`, "--", "claude", "--permission-mode", "bypassPermissions", prompt]);
  if (!created.ok) throw new Error(`tmux new-session failed: ${created.out}`);
  run([...TMUX, "set-option", "-t", t, "@mf", JSON.stringify(meta)]);
  return { id, tmux: t, at: Date.now() };
}

// The maxflow folder isn't a trusted claude workspace, so the agent opens on the trust dialog; accept it for this session only.
async function acceptTrust(t: string) {
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    const screen = run([...TMUX, "capture-pane", "-p", "-t", t]).out;
    if (/Yes, I trust this folder/.test(screen)) return void run([...TMUX, "send-keys", "-t", t, "Down", "Enter"]);
    if (/esc to interrupt|bypass permissions/i.test(screen)) return;
  }
}

let downSince: number | null = null;
let agent: { id: string; tmux: string; at: number } | null = null;
let page: ReturnType<typeof Bun.serve> | null = null;
let releasedAt = 0;
let buildBrokenSince: number | null = null;
let buildCheckedAt = 0;
let lastAgentAt = -COOLDOWN_MS;
const canStartAgent = () => !(agent && run([...TMUX, "has-session", "-t", agent.tmux]).ok) && Date.now() - lastAgentAt >= COOLDOWN_MS;
// A server asking for the port back is alive and booting (adopting every tmux session takes ~20s), so the agent's clock restarts.
const agentDueAt = () => downSince && Math.max(downSince, releasedAt) + DOWN_MS;

function state() {
  const status = launchd().out;
  const field = (k: string) => status.match(new RegExp(`^\\s*${k} = (.+)$`, "m"))?.[1];
  return {
    down: true,
    downSince,
    agentDueAt: downSince && Math.max(agentDueAt()!, lastAgentAt + COOLDOWN_MS),
    agent: agent && run([...TMUX, "has-session", "-t", agent.tmux]).ok ? { id: agent.id, at: agent.at } : null,
    launchd: { runs: field("runs"), lastExit: field("last exit code") },
    log: run(["tail", "-n", "40", LOG]).out,
  };
}

type WsData = { pty?: Subprocess };
const DOWN_HEADERS = { "x-maxflow-down": "1", "cache-control": "no-store" };

function openPage() {
  try {
    page = Bun.serve<WsData>({
      hostname: HOST,
      port: PORT,
      idleTimeout: 0,
      fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/__down/release" && req.method === "POST") {
          setTimeout(closePage, 50);
          return new Response("released");
        }
        if (path === "/__down/state") return Response.json(state(), { headers: DOWN_HEADERS });
        if (path === "/__down/ws") return server.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
        const asset = { "/__down/xterm.js": "xterm/lib/xterm.js", "/__down/xterm.css": "xterm/css/xterm.css", "/__down/fit.js": "addon-fit/lib/addon-fit.js" }[path];
        if (asset) return new Response(Bun.file(join(XTERM, asset)));
        if (path.startsWith("/api/")) return new Response("maxflow is down", { status: 503, headers: DOWN_HEADERS });
        return new Response(Bun.file(join(import.meta.dir, "health.html")), { headers: { ...DOWN_HEADERS, "content-type": "text/html" } });
      },
      websocket: {
        open(ws: ServerWebSocket<WsData>) {
          if (!agent) return ws.close();
          ws.data.pty = Bun.spawn([...TMUX, "attach-session", "-t", agent.tmux], {
            env: { ...process.env, TERM: "xterm-256color" },
            terminal: { cols: 120, rows: 34, data: (_t, data) => ws.sendBinary(new Uint8Array(data)) },
          });
          ws.data.pty.exited.then(() => ws.readyState === 1 && ws.close());
        },
        message(ws: ServerWebSocket<WsData>, raw) {
          const pty = ws.data.pty;
          if (!pty || pty.exitCode !== null) return;
          const msg = JSON.parse(String(raw)) as { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
          if (msg.type === "input") pty.terminal!.write(msg.data);
          else if (msg.cols > 0 && msg.rows > 0) pty.terminal!.resize(msg.cols, msg.rows);
        },
        close(ws: ServerWebSocket<WsData>) {
          ws.data.pty?.kill();
        },
      },
    });
    console.log(`${stamp()}  server down, serving the down page on ${base}`);
  } catch (e) {
    console.error(`${stamp()}  couldn't take ${base} for the down page:`, e);
  }
}

function closePage() {
  if (!page) return;
  page.stop(true);
  page = null;
  releasedAt = Date.now();
  console.log(`${stamp()}  server starting, handed the port back`);
}

console.log(`health sentry: polls ${base} every ${INTERVAL_MS / 1000}s; down page after ${PAGE_AFTER_MS / 1000}s, recovery agent after ${DOWN_MS / 1000}s down or ${BUILD_DOWN_MS / 1000}s with a broken build`);
for (;;) {
  try {
    // While the down page holds the port the server can't be listening, so there's nothing to probe.
    const health = page ? "refused" : await probe();
    if (health === "up") {
      if (downSince) console.log(`${stamp()}  up again after ${Math.round((Date.now() - downSince) / 1000)}s`);
      downSince = null;
      if (Date.now() - buildCheckedAt >= BUILD_EVERY_MS) {
        buildCheckedAt = Date.now();
        if (await buildOk()) {
          if (buildBrokenSince) console.log(`${stamp()}  build fixed after ${Math.round((Date.now() - buildBrokenSince) / 1000)}s`);
          buildBrokenSince = null;
          // An agent belongs to the outage it was started for; its session stays open in the sidebar, but the next outage gets its own.
          agent = null;
        } else {
          if (!buildBrokenSince) console.log(`${stamp()}  frontend build broken`);
          buildBrokenSince ??= Date.now();
          if (Date.now() - buildBrokenSince >= BUILD_DOWN_MS && canStartAgent()) {
            agent = startAgent(buildTask(buildBrokenSince));
            lastAgentAt = agent.at;
            console.log(`${stamp()}  build broken ${Math.round((Date.now() - buildBrokenSince) / 1000)}s, started recovery agent in ${agent.tmux}`);
            await acceptTrust(agent.tmux);
          }
        }
      }
    } else if (!launchd().ok) {
      // Unloaded on purpose (launchctl bootout/unload), so it is meant to be down.
      downSince = null;
      closePage();
    } else {
      downSince ??= Date.now();
      if (!page && health === "refused" && Date.now() - downSince >= PAGE_AFTER_MS && Date.now() - releasedAt >= RELEASE_GRACE_MS) openPage();
      if (Date.now() >= agentDueAt()! && canStartAgent()) {
        agent = startAgent(downTask(downSince));
        lastAgentAt = agent.at;
        console.log(`${stamp()}  down ${Math.round((Date.now() - downSince) / 1000)}s, started recovery agent in ${agent.tmux}`);
        await acceptTrust(agent.tmux);
      }
    }
  } catch (e) {
    console.error(`${stamp()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
