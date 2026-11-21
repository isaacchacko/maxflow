import type { Server } from "bun";
import { existsSync, watch } from "node:fs";
import { writeStateText } from "./state";
import { publish } from "./bus";
import { BASE, DIR, INSTANCE, IS_LIVE, PORT } from "./instance";
import app from "./src/index.html";
import { flushOptions } from "./tmux";
import { type WsData, isSentry, sessions } from "./sessions";
import { flushPendingThreads } from "./stores";
import { SessionCap, settleTasks, stopAgent, wake } from "./lifecycle";
import { checkShells } from "./waits";
import { deliver } from "./delivery";
import { RESYNC_MS, resync } from "./turns";
import { canvasRoute } from "./canvas-api";
import { docsRoute } from "./docs-api";
import { sizingRoute } from "./sizing";
import { withCursors } from "./cursors";
import { known } from "./routing";
import { restrictionsRoute } from "./routes-restrictions";
import { statsTodosRoute } from "./routes-stats";
import { tasksLinksRoute } from "./routes-tasks";
import { browserRoute } from "./routes-browser";
import { keepReapingBrowsers } from "./browsers";
import { keepSamplingResources } from "./stats-resources";
import { miscRoute } from "./routes-misc";
import { prsRoute } from "./routes-prs";
import { timelinesRoute } from "./routes-timelines";
import { keepPrFeedback } from "./pr-feedback";
import { objectivesRoute } from "./routes-objectives";
import { sessionRoute } from "./routes-session";
import { boardRoute } from "./routes-board";
import { signalsRoute } from "./routes-signals";
import { threadsRoute } from "./routes-threads";
import { sessionsWorldRoute } from "./routes-sessions";
import { filesRoute } from "./routes-files";
import { adoptSessionsThatOutlivedTheLastServer, loadSavedDrafts } from "./adopt-sessions";
import { startSentriesAndKeepThemUp } from "./boot-sentries";
import { keepPrStatesFresh } from "./pr-states";
import { backfillExternalSignals, seedHisCommentsOnFirstBoot } from "./boot-backfills";
import {
  giveMessagesFromBeforeSubthreadsIds,
  markMovedStubsSinceHisMidnight,
  migrateOpenQuestionsIntoThreads,
  retireCommandFields,
  setBoardRelaysAside,
  settleColumnsOfTasksFromBeforeSettling,
} from "./boot-thread-migrations";
import { splitFeedHandoffsIntoTheirMessages } from "./feed-handoff-split";
import { keepResurfacingPausedThreads } from "./thread-pauses";
import { keepCheckingClaudeRunsInEachAgentPane } from "./claude-check";
import { keepGoingAheadOnUnansweredDefaults } from "./ask-defaults";
import { websocketHandlers } from "./ws-handlers";
import { keepSweepingPreviews, previewsRoute } from "./routes-previews";

const HOST = "127.0.0.1";
const PEER_ANSWERS_WITHIN_MS = 5000;
const EXTERNAL_BACKFILL_AFTER_MS = 3000;
const QUESTION_MIGRATION_AFTER_MS = 5000;
const FIRST_RESYNC_AFTER_MS = 10_000;
const SHELL_CHECK_MS = 2000;
const TASK_SETTLE_MS = 15_000;
const DELIVERY_MS = 1000;
const PANIC_RELEASE_TRIES = 20;
const PANIC_RELEASE_RETRY_MS = 250;
const RESTART_FOR_NEW_SOURCE_AFTER_MS = 500;

type Route = (req: Request, url: URL, path: string, server: Server<WsData>) => Promise<Response | undefined>;
type Upgrade = { response: Response | undefined };

async function isAnsweringOk(url: string, init?: RequestInit) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(PEER_ANSWERS_WITHIN_MS) });
    return r.ok;
  } catch {
    return false;
  }
}

// constraint: panes in the live yarn carry its port, so a plain `bun server.ts` run from one would adopt and respawn the live sessions
async function refuseToRunBesideTheLiveYarn() {
  if (!IS_LIVE || !(await isAnsweringOk(`${BASE}/api/sessions`))) return;
  console.error(`the live yarn is already running on ${BASE}; run ./dev.sh for a dev instance`);
  process.exit(1);
}

await refuseToRunBesideTheLiveYarn();
adoptSessionsThatOutlivedTheLastServer();
startSentriesAndKeepThemUp();
loadSavedDrafts();
keepPrStatesFresh();
setTimeout(backfillExternalSignals, EXTERNAL_BACKFILL_AFTER_MS);
markMovedStubsSinceHisMidnight();
retireCommandFields();
setBoardRelaysAside();
splitFeedHandoffsIntoTheirMessages();
process.on("exit", flushPendingThreads);
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    flushOptions();
    process.exit(0);
  });
giveMessagesFromBeforeSubthreadsIds();
keepResurfacingPausedThreads();
keepCheckingClaudeRunsInEachAgentPane();
seedHisCommentsOnFirstBoot();
setInterval(checkShells, SHELL_CHECK_MS);
keepReapingBrowsers((id) => sessions.get(id)?.exitCode === null);
keepSamplingResources();
keepPrFeedback();
setTimeout(migrateOpenQuestionsIntoThreads, QUESTION_MIGRATION_AFTER_MS);
settleColumnsOfTasksFromBeforeSettling();
setInterval(settleTasks, TASK_SETTLE_MS);
for (const s of sessions.values()) {
  const isStopped = s.archived === true || (s.asleep !== undefined && s.asleep !== "");
  if (s.inbox.length > 0 && isStopped && !isSentry(s)) wake(s);
  else if (s.archived === true) void stopAgent(s);
}
keepGoingAheadOnUnansweredDefaults();
keepSweepingPreviews();

async function resyncAndReportFailure() {
  try {
    await resync();
  } catch (error) {
    console.error("resync", error);
  }
}
setTimeout(() => {
  void resyncAndReportFailure();
}, FIRST_RESYNC_AFTER_MS);
setInterval(() => {
  void resyncAndReportFailure();
}, RESYNC_MS);

const delivery = { isRunning: false };
async function deliverToEverySession() {
  if (delivery.isRunning) return;
  delivery.isRunning = true;
  try {
    for (const s of sessions.values()) await deliver(s);
  } finally {
    delivery.isRunning = false;
  }
}
setInterval(() => {
  void deliverToEverySession();
}, DELIVERY_MS);

function isSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (origin === null || origin === "") return true;
  const host = new URL(origin).host;
  return host === `localhost:${String(PORT)}` || host === `${HOST}:${String(PORT)}`;
}

// constraint: while we're down the health sentry serves its panic page on our port, and hands the port back when asked
for (let i = 0; i < PANIC_RELEASE_TRIES; i++) {
  if (!(await isAnsweringOk(`http://${HOST}:${String(PORT)}/__panic/release`, { method: "POST" }))) break;
  await Bun.sleep(PANIC_RELEASE_RETRY_MS);
}

const upgraded = (isUpgraded: boolean): Upgrade => ({ response: isUpgraded ? undefined : new Response("upgrade failed", { status: 400 }) });

function websocketUpgrade(req: Request, path: string, server: Server<WsData>): Upgrade | undefined {
  const browserCast = /^\/ws\/browser\/([\w-]+)$/.exec(path)?.[1];
  if (browserCast !== undefined) return upgraded(server.upgrade(req, { data: { id: browserCast, browser: true } }));
  const id = /^\/ws\/([\w-]+)$/.exec(path)?.[1];
  if (id === undefined) return undefined;
  if (!sessions.has(id)) return { response: new Response("no such session", { status: 404 }) };
  return upgraded(server.upgrade(req, { data: { id } }));
}

async function mockOrRealWorkKeptOutOfTheRepo() {
  const file = Bun.file(`${DIR}/mock.local.json`);
  return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
}

const ROUTES: Route[] = [
  async (req, url) => docsRoute(req, url),
  async (req, url) => canvasRoute(req, url),
  async (req, url) => sizingRoute(req, url),
  async (req, url, path, server) => sessionsWorldRoute(req, url, path, server),
  async (req, url, path) => signalsRoute(req, url, path),
  async (req, url, path) => objectivesRoute(req, url, path),
  async (req, url, path) => threadsRoute(req, url, path),
  async (req, _url, path) => browserRoute(req, path),
  async (req, url, path) => miscRoute(req, url, path),
  async (req, url, path) => prsRoute(req, url, path),
  async (req, url, path) => timelinesRoute(req, url, path),
  async (req, url, path) => statsTodosRoute(req, url, path),
  async (req, url, path) => restrictionsRoute(req, url, path),
  async (req, url, path) => tasksLinksRoute(req, url, path),
  async (req, url, path) => filesRoute(req, url, path),
  async (req, url, path) => sessionRoute(req, url, path),
  async (req, url, path) => boardRoute(req, url, path),
  async (req, url, path) => previewsRoute(req, url, path),
];

async function answer(req: Request, server: Server<WsData>): Promise<Response | undefined> {
  if (!isSameOrigin(req)) return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const path = url.pathname;
  const upgrade = websocketUpgrade(req, path, server);
  if (upgrade) return upgrade.response;
  if (path === "/api/instance") return Response.json({ instance: INSTANCE === "" ? "live" : INSTANCE, port: PORT, pid: process.pid });
  for (const route of ROUTES) {
    const answered = await route(req, url, path, server);
    if (answered) return answered;
  }
  if (path === "/mock.local.json") return mockOrRealWorkKeptOutOfTheRepo();
  return new Response("not found", { status: 404 });
}

Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  // constraint: `wait` and event subscriptions long-poll, so a request may stay open indefinitely
  idleTimeout: 0,
  development: { hmr: true },
  routes: { "/": app },
  error: (err) => (err instanceof SessionCap ? new Response(err.message, { status: 429 }) : undefined),
  fetch: withCursors(answer),
  websocket: websocketHandlers,
});

console.log(`yarn listening on http://localhost:${String(PORT)}`);
const git = Bun.spawn(["git", "-C", DIR, "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
publish("server/start", { pid: process.pid, commit: (await new Response(git.stdout).text()).trim() });
writeStateText("server.pid", String(process.pid));

function restartIfNewSourceFile(file: string | null) {
  if (file === null || !/\.(tsx?|css)$/.test(file)) return;
  const path = `${DIR}/src/${file}`;
  if (known.has(path) || !existsSync(path)) return;
  known.add(path);
  console.log(`new source file ${file}, restarting so the bundler sees it`);
  setTimeout(() => process.exit(0), RESTART_FOR_NEW_SOURCE_AFTER_MS);
}
watch(`${DIR}/src`, { recursive: true }, (_, file) => {
  restartIfNewSourceFile(file);
});
const sourceFiles = new Bun.Glob("**/*.{ts,tsx,css}").scanSync(`${DIR}/src`);
for (const f of sourceFiles) known.add(`${DIR}/src/${f}`);
