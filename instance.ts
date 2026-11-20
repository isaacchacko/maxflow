import { yarnEnv } from "./shared/legacy-maxflow";
import { homedir } from "node:os";
import { join } from "node:path";

const nonEmptyEnv = (name: string) => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

export const INSTANCE = yarnEnv("INSTANCE") ?? "";
export const IS_LIVE = INSTANCE === "";
export const PORT = Number(yarnEnv("PORT") ?? 4949);
export const BASE = `http://localhost:${PORT}`;
export const TMUX_SOCKET = IS_LIVE ? "maxflow-v2" : `maxflow-v2-${INSTANCE}`;
export const STATE_DIR = join(homedir(), IS_LIVE ? ".maxflow-v2" : `.maxflow-v2-${INSTANCE}`);
const DEV_INSTANCE_SESSION_CAP = 10;
export const MAX_SESSIONS = IS_LIVE ? Infinity : Number(yarnEnv("MAX_SESSIONS") ?? DEV_INSTANCE_SESSION_CAP);
export const ARE_AGENTS_INERT = !IS_LIVE && yarnEnv("REAL_AGENTS") !== "1";
export const INERT_CWD = join(STATE_DIR, "agent-cwd");
export const DIR = import.meta.dir;
export const CLI = join(DIR, "cli.ts");
// constraint: systemd puts each tmux pane in a scope PartOf the unit that started tmux, so a service restart would kill every session
export const TMUX_SCOPE = process.platform === "linux" && nonEmptyEnv("INVOCATION_ID") !== undefined ? ["systemd-run", "--user", "--scope", "--quiet", "--collect"] : [];
