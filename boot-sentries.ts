import { yarnEnv } from "./shared/legacy-maxflow";
import { publish } from "./bus";
import { DIR } from "./instance";
import { stateDisplayPath } from "./state";
import { setOption } from "./tmux";
import { type Session, sessions } from "./sessions";
import { createSession } from "./lifecycle";
import { patch } from "./patch";
import { SENTRIES } from "./sentry-commands";
import { BARE_AGENT_SENTRIES, FED_AGENT_SENTRIES } from "./sentry-names";

const SENTRY_CHECK_MS = 15_000;
const FIRST_RESPAWN_AFTER_MS = 30_000;
const LONGEST_RESPAWN_BACKOFF_MS = 30 * 60_000;
const UP_THIS_LONG_RESETS_BACKOFF_MS = 10 * 60_000;
const SENTRY_PREFIX_LENGTH = "sentry:".length;

const sentrySource = (file: string) => new URL(`sentries/${file}`, import.meta.url).pathname;
const agentWithBrief = (name: string) => `exec claude --permission-mode bypassPermissions --append-system-prompt "$(cat "${sentrySource(`${name}.md`)}")"`;

function registerAgentSentriesWithFeedsLoggedAside() {
  for (const n of FED_AGENT_SENTRIES)
    SENTRIES[`sentry:${n}`] = ["sh", "-c", `"${process.execPath}" "${sentrySource(`${n}.ts`)}" >"${stateDisplayPath(`${n}-feed.log`)}" 2>&1 & ${agentWithBrief(n)}`];
  for (const n of BARE_AGENT_SENTRIES) SENTRIES[`sentry:${n}`] = ["sh", "-c", agentWithBrief(n)];
}

function markSentry(s: Session) {
  patch(s, { sentry: true });
  setOption(s.id, "@mf-sentry", "1");
}

function markSentriesStartedBeforeTheFlagByNameAndScript() {
  for (const s of sessions.values()) if (s.sentry !== true && Object.hasOwn(SENTRIES, s.name) && s.cmd.join(" ").includes(sentrySource(""))) markSentry(s);
}

function sentriesWantedByYarnSentriesEnv(): [string, string[]][] {
  const noneAllOrCommaList = yarnEnv("SENTRIES") ?? "1";
  if (noneAllOrCommaList === "0") return [];
  return Object.entries(SENTRIES).filter(([n]) => noneAllOrCommaList === "1" || noneAllOrCommaList.split(",").includes(n.slice(SENTRY_PREFIX_LENGTH)));
}

const isSentryUp = (name: string) => sessions.values().some((s) => s.sentry === true && s.name === name && s.exitCode === null);

const respawns = new Map<string, { tries: number; at: number }>();
function respawnWithBackoffIfDown(name: string, cmd: string[]) {
  const r = respawns.get(name) ?? { tries: 0, at: 0 };
  if (isSentryUp(name)) {
    if (r.tries > 0 && Date.now() - r.at > UP_THIS_LONG_RESETS_BACKOFF_MS) respawns.delete(name);
    return;
  }
  if (Date.now() - r.at < Math.min(FIRST_RESPAWN_AFTER_MS * 2 ** r.tries, LONGEST_RESPAWN_BACKOFF_MS)) return;
  const tries = r.tries + 1;
  respawns.set(name, { tries, at: Date.now() });
  console.log(`${name} is down; starting it again (try ${String(tries)})`);
  markSentry(createSession(name, cmd, DIR));
  publish("sentry/start", { name, why: "respawn", tries });
}

export function startSentriesAndKeepThemUp() {
  registerAgentSentriesWithFeedsLoggedAside();
  markSentriesStartedBeforeTheFlagByNameAndScript();
  const wanted = sentriesWantedByYarnSentriesEnv();
  for (const [name, cmd] of wanted) {
    if (isSentryUp(name)) continue;
    markSentry(createSession(name, cmd, DIR));
    publish("sentry/start", { name, why: "boot" });
  }
  setInterval(() => {
    for (const [name, cmd] of wanted) respawnWithBackoffIfDown(name, cmd);
  }, SENTRY_CHECK_MS);
}
