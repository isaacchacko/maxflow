import { join } from "node:path";

// Which maxflow this process belongs to. Unset is the live one; a dev instance (dev.sh) names itself, and gets its own
// port, tmux socket and state dir so nothing it does reaches the live sessions.
export const INSTANCE = process.env.MAXFLOW_INSTANCE || "";
export const LIVE = !INSTANCE;
export const PORT = Number(process.env.MAXFLOW_PORT ?? 4747);
export const BASE = `http://localhost:${PORT}`;
export const TMUX_SOCKET = LIVE ? "maxflow" : `maxflow-${INSTANCE}`;
export const STATE_DIR = join(process.env.HOME!, LIVE ? ".maxflow" : `.maxflow-${INSTANCE}`);
