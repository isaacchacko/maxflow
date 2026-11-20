#!/usr/bin/env bun
import { BASE as base, IS_LIVE, TMUX_SOCKET } from "../instance";
import { deployRestartUnderway } from "../deploy-restart";
import { LOG, isLoaded, restartCommand, status as serviceStatus } from "../service";
import { isRecord } from "../shared/guards";
import {
  type Agent,
  IS_WATCHING_DEV_AS_IF_LIVE,
  acceptTrustInFolderNotYetTrustedForThisSessionOnly,
  hasFinished,
  hasSession,
  isStillWorking,
  run,
  stamp,
  startAgent,
} from "./health-agent";
import { mcpAlerts, stateAlerts, warnGithubBudget } from "./health-alerts";
import { servePanicPage } from "./health-page";
import { buildTask, downTask, mcpTask, stateTask } from "./health-tasks";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("health");

if (!IS_LIVE && !IS_WATCHING_DEV_AS_IF_LIVE) {
  console.log("health sentry: not the live yarn, nothing to watch");
  process.exit(0);
}

const INTERVAL_MS = Number(process.env["HEALTH_INTERVAL"] ?? 1000);
const PAGE_AFTER_MS = Number(process.env["HEALTH_PAGE_AFTER_MS"] ?? 3000);
const HELPER_AFTER_MS = Number(process.env["HEALTH_HELPER_AFTER_MS"] ?? 10_000);
const BUILD_EVERY_MS = 2000;
const HELPERS_MAX = Number(process.env["HEALTH_HELPERS_MAX"] ?? 3);
const HELPERS_WINDOW_MS = 10 * 60_000;
const MCP_EVERY_MS = 30_000;
const ONE_AGENT_PER_SERVER_OR_STATE_FILE_EVERY_MS = 6 * 3_600_000;
const GRACE_TO_BIND_AFTER_HANDING_PORT_BACK_MS = 5000;
const BUILD_FAILED_STATUS = 500;

type Probe = "up" | "refused-so-port-is-free" | "hung-holding-port";
type PanicPage = NonNullable<ReturnType<typeof servePanicPage>>;
type Watch = {
  downSince: number | null;
  serviceRunsWhenOutageBegan: number;
  agentOfThisOutage: Agent | null;
  page: PanicPage | null;
  releasedAt: number;
  buildBrokenSince: number | null;
  buildCheckedAt: number;
  mcpCheckedAt: number;
};
const watch: Watch = { downSince: null, serviceRunsWhenOutageBegan: 0, agentOfThisOutage: null, page: null, releasedAt: 0, buildBrokenSince: null, buildCheckedAt: 0, mcpCheckedAt: 0 };
const outage: { helperStarts: number[]; gaveUp?: string } = { helperStarts: [] };
const mcpAgentAt = new Map<string, number>();
const stateAgentAt = new Map<string, number>();

const errorCode = (error: unknown) => (isRecord(error) ? (error["code"] ?? error) : error);

async function probe(): Promise<Probe> {
  try {
    return (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) })).ok ? "up" : "hung-holding-port";
  } catch (error) {
    return /ConnectionRefused|ECONNREFUSED/.test(String(errorCode(error))) ? "refused-so-port-is-free" : "hung-holding-port";
  }
}

// constraint: Bun's dev server answers the page with a 500 "Build Failed" while any file in the bundle doesn't parse or resolve
async function isBuildOkOrServerUnreachable() {
  try {
    return (await fetch(base, { signal: AbortSignal.timeout(10_000) })).status !== BUILD_FAILED_STATUS;
  } catch {
    return true;
  }
}

const isDue = (startedAt: Map<string, number>, key: string) => Date.now() - (startedAt.get(key) ?? -ONE_AGENT_PER_SERVER_OR_STATE_FILE_EVERY_MS) >= ONE_AGENT_PER_SERVER_OR_STATE_FILE_EVERY_MS;

async function startStateRecovery(): Promise<Agent | undefined> {
  const alerts = await stateAlerts();
  for (const alert of alerts) console.log(`${stamp()}  state: ${alert.name} unreadable (${alert.problem})${alert.isGating ? ", its sentry refuses to start" : `, kept as ${alert.kept}`}`);
  const due = alerts.find((alert) => isDue(stateAgentAt, alert.name));
  if (due === undefined || isStillWorking(watch.agentOfThisOutage)) return undefined;
  const started = startAgent(stateTask(due));
  stateAgentAt.set(due.name, started.at);
  console.log(`${stamp()}  started recovery agent for ${due.name} in ${started.tmux}`);
  await acceptTrustInFolderNotYetTrustedForThisSessionOnly(started.tmux);
  return started;
}

async function startMcpRecoveries() {
  const alerts = await mcpAlerts();
  for (const { server, error } of alerts) {
    console.log(`${stamp()}  mcp: ${server} unreachable after a registry refresh: ${error}`);
    if (!isDue(mcpAgentAt, server) || isStillWorking(watch.agentOfThisOutage)) continue;
    const started = startAgent(mcpTask(server, error));
    watch.agentOfThisOutage = started;
    mcpAgentAt.set(server, started.at);
    console.log(`${stamp()}  started recovery agent for ${server} in ${started.tmux}`);
    await acceptTrustInFolderNotYetTrustedForThisSessionOnly(started.tmux);
  }
}

const secondsSince = (at: number) => String(Math.round((Date.now() - at) / 1000));
function startHelper(prompt: string, why: string): Agent | undefined {
  if (outage.gaveUp !== undefined || isStillWorking(watch.agentOfThisOutage)) return undefined;
  const recent = outage.helperStarts.filter((at) => Date.now() - at < HELPERS_WINDOW_MS);
  if (recent.length >= HELPERS_MAX) {
    outage.gaveUp = `${String(recent.length)} helpers since ${new Date(recent[0] ?? NaN).toLocaleTimeString()} didn't bring yarn back, so no more start on their own until it's up`;
    console.log(`${stamp()}  gave up: ${outage.gaveUp}`);
    return undefined;
  }
  const started = startAgent(prompt);
  outage.helperStarts.push(started.at);
  console.log(`${stamp()}  ${why}, started recovery agent in ${started.tmux}`);
  return started;
}

async function startHelperWhenDue(dueAt: number, prompt: () => string, why: string) {
  const started = Date.now() >= dueAt ? startHelper(prompt(), why) : undefined;
  watch.agentOfThisOutage = started ?? watch.agentOfThisOutage;
  if (started !== undefined) await acceptTrustInFolderNotYetTrustedForThisSessionOnly(started.tmux);
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

function panicPageAgent(agent: Agent | null) {
  if (agent === null || !hasSession(agent)) return null;
  return { id: agent.id, at: agent.at, attach: `tmux -L ${TMUX_SOCKET} attach -t ${agent.tmux}`, running: !hasFinished(agent) };
}

function panicPageState() {
  const service = serviceStatus();
  const { downSince } = watch;
  const restart = downSince === null ? undefined : deployCausing(downSince);
  return {
    down: true,
    downSince,
    deploy: restart === undefined ? null : { commit: restart.commit.slice(0, 7), at: restart.at, expectedMs: restart.expectedMs },
    helperDueAt: downSince === null ? null : helperDueAt(downSince, downSince + PAGE_AFTER_MS),
    agent: panicPageAgent(watch.agentOfThisOutage),
    gaveUp: outage.gaveUp === undefined ? null : { why: outage.gaveUp, restart: restartCommand },
    launchd: { attempts: Math.max(0, Number(service.runs ?? 0) - watch.serviceRunsWhenOutageBegan), lastExit: service.lastExit },
    log: run(["tail", "-n", "40", LOG]).out,
  };
}

function closePage() {
  if (watch.page === null) return;
  void watch.page.stop(true);
  watch.page = null;
  watch.releasedAt = Date.now();
  console.log(`${stamp()}  server starting, handed the port back`);
}

function openPage() {
  watch.page = servePanicPage({ state: panicPageState, agentTmux: () => watch.agentOfThisOutage?.tmux, release: closePage }) ?? watch.page;
}

function forgetTheAgentOfTheOutageThatEnded() {
  watch.agentOfThisOutage = null;
  delete outage.gaveUp;
}

async function onBuildOk() {
  if (watch.buildBrokenSince !== null) console.log(`${stamp()}  build fixed after ${secondsSince(watch.buildBrokenSince)}s`);
  watch.buildBrokenSince = null;
  forgetTheAgentOfTheOutageThatEnded();
  if (Date.now() - watch.mcpCheckedAt < MCP_EVERY_MS) return;
  watch.mcpCheckedAt = Date.now();
  await startMcpRecoveries();
  watch.agentOfThisOutage = (await startStateRecovery()) ?? watch.agentOfThisOutage;
  await warnGithubBudget();
}

async function onBuildBroken() {
  if (watch.buildBrokenSince === null) console.log(`${stamp()}  frontend build broken`);
  const since = watch.buildBrokenSince ?? Date.now();
  watch.buildBrokenSince = since;
  await startHelperWhenDue(helperDueAt(since, since), () => buildTask(since), `build broken ${secondsSince(since)}s`);
}

async function onUp() {
  if (watch.downSince !== null) console.log(`${stamp()}  up again after ${secondsSince(watch.downSince)}s`);
  watch.downSince = null;
  if (Date.now() - watch.buildCheckedAt < BUILD_EVERY_MS) return;
  watch.buildCheckedAt = Date.now();
  await ((await isBuildOkOrServerUnreachable()) ? onBuildOk() : onBuildBroken());
}

function onUnloadedOnPurpose() {
  watch.downSince = null;
  closePage();
}

async function onDown(health: Probe) {
  if (watch.downSince === null) {
    watch.downSince = Date.now();
    watch.serviceRunsWhenOutageBegan = Number(serviceStatus().runs ?? 0);
  }
  const since = watch.downSince;
  const isPageDue = Date.now() - since >= PAGE_AFTER_MS && Date.now() - watch.releasedAt >= GRACE_TO_BIND_AFTER_HANDING_PORT_BACK_MS;
  if (health === "refused-so-port-is-free" && isPageDue && watch.page === null) openPage();
  await startHelperWhenDue(helperDueAt(since, since + PAGE_AFTER_MS), () => downTask(since), `down ${secondsSince(since)}s`);
}

async function tick() {
  const health = watch.page === null ? await probe() : "refused-so-port-is-free";
  if (health === "up") await onUp();
  else if (IS_WATCHING_DEV_AS_IF_LIVE || isLoaded()) await onDown(health);
  else onUnloadedOnPurpose();
}

console.log(`health sentry: polls ${base} every ${String(INTERVAL_MS / 1000)}s; panic page after ${String(PAGE_AFTER_MS / 1000)}s, a helper ${String(HELPER_AFTER_MS / 1000)}s after the page, a broken build, or a deploy's restart running late; at most ${String(HELPERS_MAX)} helpers in ${String(HELPERS_WINDOW_MS / 60_000)} min`);
for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error(`${stamp()}  tick failed:`, error);
  }
  await Bun.sleep(INTERVAL_MS);
}
