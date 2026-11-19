#!/usr/bin/env bun
// health sentry: the moment the maxflow server stops answering, it takes over the port with its "panic" page, and if the
// server stays down it starts a claude agent to fix it, shown live on that page. A frontend build that stays broken
// while the API still answers gets an agent too, and so does an MCP server that sentries can't reach even after
// refreshing the mcp CLI's registry (health/mcp/<server>, published by mcp.ts).
// It runs in tmux, so it outlives the server it watches, and it starts the agent straight in tmux for the same reason;
// the server adopts that session like any other once it is back.
import type { ServerWebSocket, Subprocess } from "bun";
import { join } from "node:path";
import { BASE as base, CLI, LIVE, PORT, TMUX_SCOPE, TMUX_SOCKET } from "../instance";
import { deployRestartUnderway } from "../deploy-restart";
import { lowBudgets, RATE_LOW, readRateHistory, type RateSample } from "../gh";
import { LABEL, LOG, isLoaded, restartCommand, status as serviceStatus } from "../service";
import { stateDirectory } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("health");

const INTERVAL_MS = Number(process.env.HEALTH_INTERVAL ?? 1000);
const PAGE_AFTER_MS = Number(process.env.HEALTH_PAGE_AFTER_MS ?? 3000);
const HELPER_AFTER_MS = Number(process.env.HEALTH_HELPER_AFTER_MS ?? 10_000);
const BUILD_EVERY_MS = 2000;
const HELPERS_MAX = Number(process.env.HEALTH_HELPERS_MAX ?? 3);
const HELPERS_WINDOW_MS = 10 * 60_000;
const MCP_EVERY_MS = 30_000;
// mcp.ts alerts at most once per registry refresh (10 min); one agent per server covers that many hours of them.
const MCP_AGENT_EVERY_MS = 6 * 3_600_000;
// After handing the port back, give the server this long to bind before covering for it again.
const RELEASE_GRACE_MS = 5000;
const DIR = join(import.meta.dir, "..");
const TMUX = ["tmux", "-L", TMUX_SOCKET, "-f", join(DIR, "tmux.conf")];
const HOST = "127.0.0.1";
const XTERM = join(DIR, "node_modules/@xterm");
// The page wears the app's own type, from the same package the app bundles, since the app can't serve it while it is down.
const INTER = join(DIR, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");

// Only the live server runs as a service, and a dev one is down whenever its developer stops it, so there is nothing to recover.
// HEALTH_DEV=1 watches a dev instance anyway, as if it were a loaded service, to try the panic page against it.
const DEV = !!process.env.HEALTH_DEV;
if (!LIVE && !DEV) console.log("health sentry: not the live maxflow, nothing to watch"), process.exit(0);

const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd);
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};
const stamp = () => new Date().toLocaleTimeString();

// "refused" means nothing holds the port, so the panic page can take it; "hung" means something holds it without answering.
async function probe(): Promise<"up" | "refused" | "hung"> {
  try {
    return (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) })).ok ? "up" : "hung";
  } catch (e) {
    return /ConnectionRefused|ECONNREFUSED/.test(String((e as { code?: string }).code ?? e)) ? "refused" : "hung";
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

const RULES = `Live runs only committed code, and nobody edits its checkout (${DIR}): a fix to the code goes in your own worktree (\`git -C ${DIR} worktree add ~/Worktrees/maxflow-v2-recovery -b fix/recovery-<what> origin/feat/v2\`), is committed, rebased onto origin/feat/v2 and pushed to feat/v2, and ships with \`${CLI} deploy\`, which refuses a dirty live checkout or a commit whose CI check isn't green. If the live checkout is dirty, don't revert or stash it; find whose it is. Don't kill any tmux session on the maxflow socket; they are the user's running work. When it is fixed, say in a few lines what broke and what you changed.`;

function downTask(since: number) {
  const status = serviceStatus().text;
  return `The maxflow server (${DIR}, service ${LABEL}, ${base}) has not answered since ${new Date(since).toLocaleTimeString()}, so the health sentry started you to bring it back. The user is watching you on the health sentry's "down" page, which holds the port until the server asks for it at startup.

The service manager says:
${status}

Last lines of ${LOG}:
${run(["tail", "-n", "80", LOG]).out}

Find the root cause. If the code needs to change, ship the fix with deploy as below; if not, restart with \`${restartCommand}\`. Then confirm \`curl -s ${base}/api/sessions\` answers with the session list. ${RULES}`;
}

function buildTask(since: number) {
  return `The maxflow frontend (${DIR}/src, bundled by Bun's dev server with hot reload) has failed to build since ${new Date(since).toLocaleTimeString()}: ${base}/ answers 500 "Build Failed" while the API still works, so the user's UI is broken. The health sentry started you to fix it.

Last lines of ${LOG} (the build error is in there):
${run(["tail", "-n", "80", LOG]).out}

Look at \`git -C ${DIR} status\` (an edit made in the live checkout despite the rule: find its owner with \`${CLI} ls\` and \`${CLI} screen <id>\`) and \`git -C ${DIR} log -3\` (a deployed commit that doesn't build). Fix it forward and deploy, as below, then confirm \`curl -s -o /dev/null -w '%{http_code}' ${base}/\` gives 200. ${RULES}`;
}

function mcpTask(server: string, error: string) {
  return `Sentries can't reach the MCP server ${server} through the standalone \`mcp\` CLI, even after \`mcp --refresh servers\`: "${error}". The health sentry started you to fix it. Run the /exfilmcp skill (Skill tool, "exfilmcp") to repair the CLI and its connector registry, then confirm with a real read-only \`mcp call ${server} ...\` that it works. If it needs a human reauth in /mcp or on claude.ai, say so exactly, with the steps, and stop. ${RULES}`;
}

function stateTask({ name, problem, kept, isGating }: StateAlert) {
  const now = isGating ? `The sentry that reads it gates an outward action, so it refuses to start until the file is fixed; the file is untouched at ~/.maxflow-v2/${name}.` : `It was kept as ~/.maxflow-v2/${kept}, and its reader started with an empty ${name}, which it will save over.`;
  return `The state file ~/.maxflow-v2/${name} was unreadable (${problem}). ${now} The health sentry started you to recover it. Find what wrote it badly (git log of the code that writes it, the sentry's log), restore the data from the kept copy if it can be repaired, and tell Isaac in one ${CLI} ask what happened and what you did. ${RULES}`;
}

async function startStateRecovery(): Promise<ReturnType<typeof startAgent> | undefined> {
  const alerts = await stateAlerts();
  for (const alert of alerts) console.log(`${stamp()}  state: ${alert.name} unreadable (${alert.problem})${alert.isGating ? ", its sentry refuses to start" : `, kept as ${alert.kept}`}`);
  const due = alerts.find((alert) => Date.now() - (stateAgentAt.get(alert.name) ?? -MCP_AGENT_EVERY_MS) >= MCP_AGENT_EVERY_MS);
  if (due === undefined || isHelperRunning()) return;
  const started = startAgent(stateTask(due));
  stateAgentAt.set(due.name, started.at);
  console.log(`${stamp()}  started recovery agent for ${due.name} in ${started.tmux}`);
  await acceptTrust(started.tmux);
  return started;
}

const INERT = "Reply with the single word ok, and do nothing else.";
function startAgent(prompt: string) {
  const id = crypto.randomUUID().slice(0, 8);
  const meta = { name: "maxflow recovery", cmd: ["claude"], cwd: DIR, createdAt: Date.now() };
  const t = `mf-${id}`;
  const created = run([...TMUX_SCOPE, ...TMUX, "new-session", "-d", "-s", t, "-x", "120", "-y", "34", "-c", DEV ? stateDirectory("helper-cwd") : DIR, "-e", `MAXFLOW_SESSION=${id}`, "--", "claude", "--permission-mode", "bypassPermissions", ...(DEV ? ["--model", "haiku", INERT] : [prompt])]);
  if (!created.ok) throw new Error(`tmux new-session failed: ${created.out}`);
  run([...TMUX, "set-option", "-t", t, "@mf", JSON.stringify(meta)]);
  return { id, tmux: t, at: Date.now(), wasWorking: false, idleTicks: 0 };
}

function ghCallers() {
  return run(["ps", "-Ao", "etime=,args="]).out.split("\n").filter((l) => /(^|\/|\s)gh\s+(run|api|pr)\b/.test(l)).map((l) => l.trim().slice(0, 160)).slice(0, 10);
}

const FENCE = "```";
const pt = (at: number) => new Date(at).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });

async function warnGithubBudget() {
  const last: RateSample | undefined = readRateHistory().at(-1);
  if (last === undefined || Date.now() - last.at > 5 * 60_000) return;
  for (const key of lowBudgets(last)) {
    const b = last[key];
    const id = `${key}@${b.reset}`;
    if (githubWarned.has(id)) continue;
    githubWarned.add(id);
    const name = key === "core" ? "REST" : "GraphQL";
    const callers = ghCallers();
    const text = [
      `GitHub's ${name} budget for Isaac's account is down to ${b.remaining} of ${b.limit} (under ${RATE_LOW * 100}%), and it resets at ${pt(b.reset)} PT. Every agent, sentry and his own Dryft work share it, and at zero every gh call fails until the reset.`,
      callers.length > 0 ? `gh calls running now:\n${FENCE}\n${callers.join("\n")}\n${FENCE}` : "No gh process is running now.",
      `Spend over the last two hours: Stats → Performance, "GitHub API left".`,
    ].join("\n\n");
    const title = `GitHub ${name} budget at ${Math.round((b.remaining / b.limit) * 100)}%`;
    try {
      await fetch(`${base}/api/threads`, { method: "POST", headers: { "x-maxflow-from": process.env["MAXFLOW_SESSION"] ?? "" }, body: JSON.stringify({ title, text }), signal: AbortSignal.timeout(10_000) });
      console.log(`${stamp()}  warned: ${title}`);
    } catch (error) {
      console.error(`${stamp()}  couldn't post the GitHub budget warning:`, error);
    }
  }
}

const IDLE_TICKS = 3;
function isHelperRunning() {
  if (!agent || !run([...TMUX, "has-session", "-t", agent.tmux]).ok) return false;
  const screen = run([...TMUX, "capture-pane", "-p", "-t", agent.tmux]).out;
  const isWorking = /esc to interrupt/i.test(screen);
  agent.wasWorking ||= isWorking || /⏺|Worked for/.test(screen);
  agent.idleTicks = isWorking ? 0 : agent.idleTicks + 1;
  return !(agent.wasWorking && agent.idleTicks >= IDLE_TICKS);
}

const secondsSince = (at: number) => String(Math.round((Date.now() - at) / 1000));
function startHelper(prompt: string, why: string): ReturnType<typeof startAgent> | undefined {
  if (outage.gaveUp !== undefined || isHelperRunning()) return;
  const recent = outage.helperStarts.filter((at) => Date.now() - at < HELPERS_WINDOW_MS);
  if (recent.length >= HELPERS_MAX) {
    outage.gaveUp = `${String(recent.length)} helpers since ${new Date(recent[0]).toLocaleTimeString()} didn't bring yarn back, so no more start on their own until it's up`;
    console.log(`${stamp()}  gave up: ${outage.gaveUp}`);
    return;
  }
  const started = startAgent(prompt);
  outage.helperStarts.push(started.at);
  console.log(`${stamp()}  ${why}, started recovery agent in ${started.tmux}`);
  return started;
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
// The service manager's run count when this outage began: the page counts this outage's restarts, not the service's lifetime runs.
let runsAtDown = 0;
let agent: ReturnType<typeof startAgent> | null = null;
let page: ReturnType<typeof Bun.serve> | null = null;
let releasedAt = 0;
let buildBrokenSince: number | null = null;
let buildCheckedAt = 0;
const outage: { helperStarts: number[]; gaveUp?: string } = { helperStarts: [] };
let mcpSeq: number | null = null;
let mcpCheckedAt = 0;
const mcpAgentAt = new Map<string, number>();
const githubWarned = new Set<string>();
const stateCursor: { seq: number | null } = { seq: null };
const stateAgentAt = new Map<string, number>();
type StateAlert = { name: string; problem: string; kept: string; isGating: boolean };
async function stateAlerts(): Promise<StateAlert[]> {
  const res = await fetch(`${base}/api/events?topic=health/state/**&after=${String(stateCursor.seq ?? "now")}`, { signal: AbortSignal.timeout(5000) });
  const events = (await res.json()) as { seq: number; data: StateAlert }[];
  const isFirst = stateCursor.seq === null;
  stateCursor.seq = events.at(-1)?.seq ?? Number(res.headers.get("x-maxflow-seq"));
  return isFirst ? [] : events.map((e) => e.data);
}
// health/mcp/<server> events since the last check; the first check only notes where the bus is, so old alerts aren't replayed.
async function mcpAlerts(): Promise<{ server: string; error: string }[]> {
  const res = await fetch(`${base}/api/events?topic=health/mcp/**&after=${mcpSeq ?? "now"}`, { signal: AbortSignal.timeout(5000) });
  const events = (await res.json()) as { seq: number; data: { server: string; error: string } }[];
  const first = mcpSeq === null;
  mcpSeq = events.at(-1)?.seq ?? Number(res.headers.get("x-maxflow-seq"));
  return first ? [] : events.map((e) => e.data);
}

function deployCausing(since: number) {
  const restart = deployRestartUnderway();
  return restart !== undefined && restart.at <= since ? restart : undefined;
}
const restartDoneAt = (restart: { at: number; expectedMs: number }) => restart.at + restart.expectedMs;
const helperDueAt = (since: number, firstSign: number) => {
  const restart = deployCausing(since);
  return (restart === undefined ? firstSign : restartDoneAt(restart)) + HELPER_AFTER_MS;
};

function state() {
  const service = serviceStatus();
  const restart = downSince === null ? undefined : deployCausing(downSince);
  return {
    down: true,
    downSince,
    deploy: restart === undefined ? null : { commit: restart.commit.slice(0, 7), at: restart.at, expectedMs: restart.expectedMs },
    helperDueAt: downSince === null ? null : helperDueAt(downSince, downSince + PAGE_AFTER_MS),
    agent: agent && run([...TMUX, "has-session", "-t", agent.tmux]).ok ? { id: agent.id, at: agent.at, attach: `tmux -L ${TMUX_SOCKET} attach -t ${agent.tmux}`, running: !(agent.wasWorking && agent.idleTicks >= IDLE_TICKS) } : null,
    gaveUp: outage.gaveUp === undefined ? null : { why: outage.gaveUp, restart: restartCommand },
    launchd: { attempts: Math.max(0, Number(service.runs ?? 0) - runsAtDown), lastExit: service.lastExit },
    log: run(["tail", "-n", "40", LOG]).out,
  };
}

type WsData = { pty?: Subprocess };
// x-yarn-panic marks every answer as the panic page's; x-maxflow-down is its old name, still sent for tabs open from before.
const PANIC_HEADERS = { "x-yarn-panic": "1", "x-maxflow-down": "1", "cache-control": "no-store" };

function openPage() {
  try {
    page = Bun.serve<WsData>({
      hostname: HOST,
      port: PORT,
      idleTimeout: 0,
      fetch(req, server) {
        // Its own routes live under /__panic/; /__down/ was their old name, kept for a server or page from before the rename.
        const path = new URL(req.url).pathname.replace(/^\/__down\//, "/__panic/");
        if (path === "/__panic/release" && req.method === "POST") {
          setTimeout(closePage, 50);
          return new Response("released");
        }
        if (path === "/__panic/state") return Response.json(state(), { headers: PANIC_HEADERS });
        if (path === "/__panic/ws") return server.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
        const asset = { "/__panic/xterm.js": "xterm/lib/xterm.js", "/__panic/xterm.css": "xterm/css/xterm.css", "/__panic/fit.js": "addon-fit/lib/addon-fit.js" }[path];
        if (asset) return new Response(Bun.file(join(XTERM, asset)));
        if (path === "/__panic/inter.woff2") return new Response(Bun.file(INTER), { headers: { "content-type": "font/woff2" } });
        if (path.startsWith("/api/")) return new Response("maxflow is down", { status: 503, headers: PANIC_HEADERS });
        return new Response(Bun.file(join(import.meta.dir, "panic.html")), { headers: { ...PANIC_HEADERS, "content-type": "text/html" } });
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
    console.log(`${stamp()}  server down, serving the panic page on ${base}`);
  } catch (e) {
    console.error(`${stamp()}  couldn't take ${base} for the panic page:`, e);
  }
}

function closePage() {
  if (!page) return;
  page.stop(true);
  page = null;
  releasedAt = Date.now();
  console.log(`${stamp()}  server starting, handed the port back`);
}

console.log(`health sentry: polls ${base} every ${INTERVAL_MS / 1000}s; panic page after ${PAGE_AFTER_MS / 1000}s, a helper ${HELPER_AFTER_MS / 1000}s after the page, a broken build, or a deploy's restart running late; at most ${HELPERS_MAX} helpers in ${HELPERS_WINDOW_MS / 60_000} min`);
for (;;) {
  try {
    // While the panic page holds the port the server can't be listening, so there's nothing to probe.
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
          delete outage.gaveUp;
          if (Date.now() - mcpCheckedAt >= MCP_EVERY_MS) {
            mcpCheckedAt = Date.now();
            for (const { server, error } of await mcpAlerts()) {
              console.log(`${stamp()}  mcp: ${server} unreachable after a registry refresh: ${error}`);
              if (Date.now() - (mcpAgentAt.get(server) ?? -MCP_AGENT_EVERY_MS) < MCP_AGENT_EVERY_MS || isHelperRunning()) continue;
              agent = startAgent(mcpTask(server, error));
              mcpAgentAt.set(server, agent.at);
              console.log(`${stamp()}  started recovery agent for ${server} in ${agent.tmux}`);
              await acceptTrust(agent.tmux);
            }
            agent = (await startStateRecovery()) ?? agent;
            await warnGithubBudget();
          }
        } else {
          if (!buildBrokenSince) console.log(`${stamp()}  frontend build broken`);
          buildBrokenSince ??= Date.now();
          const started = Date.now() >= helperDueAt(buildBrokenSince, buildBrokenSince) ? startHelper(buildTask(buildBrokenSince), `build broken ${secondsSince(buildBrokenSince)}s`) : undefined;
          agent = started ?? agent;
          if (started !== undefined) await acceptTrust(started.tmux);
        }
      }
    } else if (!DEV && !isLoaded()) {
      // Unloaded on purpose (launchctl bootout, systemctl disable), so it is meant to be down.
      downSince = null;
      closePage();
    } else {
      if (!downSince) (downSince = Date.now()), (runsAtDown = Number(serviceStatus().runs ?? 0));
      if (!page && health === "refused" && Date.now() - downSince >= PAGE_AFTER_MS && Date.now() - releasedAt >= RELEASE_GRACE_MS) openPage();
      const started = Date.now() >= helperDueAt(downSince, downSince + PAGE_AFTER_MS) ? startHelper(downTask(downSince), `down ${secondsSince(downSince)}s`) : undefined;
      agent = started ?? agent;
      if (started !== undefined) await acceptTrust(started.tmux);
    }
  } catch (e) {
    console.error(`${stamp()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
