import { join } from "node:path";

// Which maxflow this process belongs to. Unset is the live one; a dev instance (dev.sh) names itself, and gets its own
// port, tmux socket and state dir so nothing it does reaches the live sessions.
// v2 keeps its own port, socket, state dir and service from the v1 maxflow, so both can run on one machine.
export const INSTANCE = process.env.MAXFLOW_INSTANCE || "";
export const LIVE = !INSTANCE;
export const PORT = Number(process.env.MAXFLOW_PORT ?? 4949);
export const BASE = `http://localhost:${PORT}`;
export const TMUX_SOCKET = LIVE ? "maxflow-v2" : `maxflow-v2-${INSTANCE}`;
export const STATE_DIR = join(process.env.HOME!, LIVE ? ".maxflow-v2" : `.maxflow-v2-${INSTANCE}`);
// A dev instance shares the machine's process table with live, and the 16:16 tmux crash that took ~95 live agents down
// (ca3633f) followed a dev instance that had spawned 60+ sessions, so a dev instance stops at MAXFLOW_MAX_SESSIONS.
export const MAX_SESSIONS = LIVE ? Infinity : Number(process.env.MAXFLOW_MAX_SESSIONS || 10);
// A dev instance's claudes are inert unless MAXFLOW_REAL_AGENTS=1: haiku, in an empty dir of the instance's own, so a
// test agent can't act on a real repo or burn a big model's tokens.
export const INERT_AGENTS = !LIVE && process.env.MAXFLOW_REAL_AGENTS !== "1";
export const INERT_CWD = join(STATE_DIR, "agent-cwd");
export const DIR = import.meta.dir;
export const CLI = join(DIR, "cli.ts");
// tmux on Linux puts each pane in a systemd scope PartOf the unit that started the tmux server, so a tmux server first
// started by the maxflow service would take every session down with it on restart. Under systemd, sessions are created
// from a scope of their own instead.
export const TMUX_SCOPE = process.platform === "linux" && process.env.INVOCATION_ID ? ["systemd-run", "--user", "--scope", "--quiet", "--collect"] : [];
