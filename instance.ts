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
export const DIR = import.meta.dir;
export const CLI = join(DIR, "cli.ts");
// tmux on Linux puts each pane in a systemd scope PartOf the unit that started the tmux server, so a tmux server first
// started by the maxflow service would take every session down with it on restart. Under systemd, sessions are created
// from a scope of their own instead.
export const TMUX_SCOPE = process.platform === "linux" && process.env.INVOCATION_ID ? ["systemd-run", "--user", "--scope", "--quiet", "--collect"] : [];
