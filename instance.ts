import { LEGACY_STATE_DIR, yarnEnv } from "./shared/legacy-maxflow";
import { existsSync } from "node:fs";
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
// constraint: every running session lives on this tmux socket, and renaming it would restart them all
export const TMUX_SOCKET = IS_LIVE ? "maxflow-v2" : `maxflow-v2-${INSTANCE}`;
const stateDirNamed = (name: string) => join(homedir(), IS_LIVE ? name : `${name}-${INSTANCE}`);
export const STATE_DIR = [stateDirNamed(".yarn-v2"), stateDirNamed(LEGACY_STATE_DIR)].find((dir) => existsSync(dir)) ?? stateDirNamed(".yarn-v2");
const DEV_INSTANCE_SESSION_CAP = 10;
export const MAX_SESSIONS = IS_LIVE ? Infinity : Number(yarnEnv("MAX_SESSIONS") ?? DEV_INSTANCE_SESSION_CAP);
export const ARE_AGENTS_INERT = !IS_LIVE && yarnEnv("REAL_AGENTS") !== "1";
export const INERT_CWD = join(STATE_DIR, "agent-cwd");
export const DIR = import.meta.dir;
export const CLI = join(DIR, "cli.ts");
// constraint: systemd puts each tmux pane in a scope PartOf the unit that started tmux, so a service restart would kill every session
export const TMUX_SCOPE = process.platform === "linux" && nonEmptyEnv("INVOCATION_ID") !== undefined ? ["systemd-run", "--user", "--scope", "--quiet", "--collect"] : [];
