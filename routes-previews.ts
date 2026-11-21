import { CLI, IS_LIVE, STATE_DIR } from "./instance";
import { dispatch, live_thread } from "./lifecycle";
import { PREVIEW_IDLE_MS, VERDICTS, VERDICT_LABELS, type Preview, type Verdict, endPreview, isServing, previewDir, previews, readPreview, writePreview } from "./previews";
import { type Route, firstAnswer, isIsaacsBrowser, jsonBody, matching, exactly, sender, textOf } from "./route-kit";
import { sessions } from "./sessions";
import { threads } from "./stores";
import { handedThread, postIn } from "./threads";

const SWEEP_MS = 5 * 60_000;
const BOOT_GRACE_MS = 5 * 60_000;
const STOP_AFTER_ANSWERING_MS = 1000;
const SEEN_EVERY_MS = 60_000;

const previewNamed = (name: string) => (name.startsWith("pv-") ? readPreview(previewDir(name)) : undefined);
const threadOf = (p: Preview) => live_thread(threads.find((t) => t.id === p.thread));
const tellAgent = (p: Preview, text: string) => {
  const agent = sessions.get(p.agent);
  if (agent) dispatch({ to: [agent], target: p.name, text });
};
const postAsThePreview = (p: Preview, text: string) => {
  const t = threadOf(p);
  if (t) postIn(t, `preview/${p.name}`, text);
};

async function announce(req: Request, _url: URL, match: RegExpExecArray) {
  const p = previewNamed(match[1] ?? "");
  if (!p) return new Response("no such preview", { status: 404 });
  const agent = sender(req);
  if (agent?.id !== p.agent) return new Response(`only ${p.agent}, the agent that started ${p.name}, announces it`, { status: 403 });
  const asked = textOf(await jsonBody(req), "thread");
  const t = asked === undefined ? (threadOf(p) ?? handedThread(agent)) : live_thread(threads.find((x) => x.id === asked));
  if (!t) return new Response(`no thread to post the preview in: pass --thread <id>, the thread Isaac asked for this change in`, { status: 409 });
  writePreview({ ...p, thread: t.id });
  postIn(
    t,
    agent,
    `Preview of \`${p.branch}\` to try: http://localhost:${String(p.port)}\nWhat changed: ${p.what}\nWhat to try: ${p.tryThis}\nThe banner at its top has Ship it, Needs changes and Discard; your verdict comes back to me.`,
  );
  return Response.json({ thread: t.id });
}

function nextStep(p: Preview, verdict: Verdict) {
  if (verdict === "ship") return `Ship it now: push ${p.branch}, wait for its check, push that sha to feat/v2 and run \`${CLI} deploy\`. The preview has stopped.`;
  if (verdict === "changes") return `Make the changes, then run \`${CLI} preview\` again from ${p.worktree}: it restarts this preview on your new code and posts again. Don't deploy until he presses Ship it.`;
  return `He doesn't want this change: don't deploy it. The preview has stopped; close out the branch and say in the thread what you did with it.`;
}

async function relayVerdict(req: Request, _url: URL, match: RegExpExecArray) {
  const p = previewNamed(match[1] ?? "");
  if (!p) return new Response("no such preview", { status: 404 });
  const body = await jsonBody(req);
  if (textOf(body, "token") !== p.token) return new Response("verdicts come from the preview's own banner", { status: 403 });
  const verdict = VERDICTS.find((v) => v === textOf(body, "verdict"));
  if (verdict === undefined) return new Response(`verdict must be one of ${VERDICTS.join(", ")}`, { status: 400 });
  const note = textOf(body, "note")?.trim() ?? "";
  writePreview({ ...p, verdict: { verdict, note, at: Date.now() } });
  const said = note === "" ? "" : `: "${note}"`;
  postAsThePreview(p, `Verdict from the preview banner: **${VERDICT_LABELS[verdict]}**${said}`);
  tellAgent(p, `[yarn · preview verdict] Isaac pressed "${VERDICT_LABELS[verdict]}" on your preview ${p.name} of ${p.branch}${said}.\n[yarn] ${nextStep(p, verdict)}`);
  if (verdict !== "changes")
    setTimeout(() => {
      endPreview(p.name);
    }, STOP_AFTER_ANSWERING_MS);
  return Response.json({ verdict, stopping: verdict !== "changes" });
}

function sweep() {
  const now = Date.now();
  for (const p of previews()) {
    if (!isServing(p) && now - p.startedAt > BOOT_GRACE_MS) {
      endPreview(p.name);
      tellAgent(p, `[yarn] Your preview ${p.name} of ${p.branch} had stopped running, so its state was cleaned. Run \`${CLI} preview\` from ${p.worktree} to start it again.`);
    } else if (isServing(p) && now - p.seenAt > PREVIEW_IDLE_MS) {
      endPreview(p.name);
      postAsThePreview(p, `Stopped after ${String(Math.round(PREVIEW_IDLE_MS / 3_600_000))}h with nobody looking at it.`);
      tellAgent(p, `[yarn] Your preview ${p.name} of ${p.branch} stopped after ${String(Math.round(PREVIEW_IDLE_MS / 3_600_000))}h unused, with no verdict. Run \`${CLI} preview\` again when he's ready to look.`);
    }
  }
}

export function keepSweepingPreviews() {
  if (IS_LIVE) setInterval(sweep, SWEEP_MS);
}

// The preview's own server: the banner reads what it previews, marks it seen while his tab shows it, and sends his verdict to live.
const thisPreview = () => (IS_LIVE ? undefined : readPreview(STATE_DIR));
const isHisBrowser = (req: Request) => isIsaacsBrowser(req) && req.headers.get("user-agent")?.includes("HeadlessChrome") !== true;
const lastSeen = { at: 0 };

function describePreview(req: Request) {
  const p = thisPreview();
  if (!p) return new Response("not a preview", { status: 404 });
  const { name, branch, what, tryThis, thread, verdict, startedAt } = p;
  return Response.json({ name, branch, what, tryThis, thread, verdict, startedAt, isHis: isHisBrowser(req) });
}

function markSeen(req: Request) {
  const p = thisPreview();
  if (!p || !isHisBrowser(req)) return new Response(null, { status: 204 });
  if (Date.now() - lastSeen.at >= SEEN_EVERY_MS) {
    lastSeen.at = Date.now();
    writePreview({ ...p, seenAt: lastSeen.at });
  }
  return new Response(null, { status: 204 });
}

async function sendVerdict(req: Request) {
  const p = thisPreview();
  if (!p) return new Response("not a preview", { status: 404 });
  if (!isHisBrowser(req)) return new Response("the verdict is Isaac's, from his own browser", { status: 403 });
  const body = await jsonBody(req);
  const r = await fetch(`${p.live}/api/previews/${p.name}/verdict`, { method: "POST", body: JSON.stringify({ ...body, token: p.token }), signal: AbortSignal.timeout(10_000) });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "text/plain" } });
}

type Matched = (req: Request, url: URL, match: RegExpExecArray) => Promise<Response>;
const onPost = (answer: Matched) => async (req: Request, url: URL, match: RegExpExecArray) => (req.method === "POST" ? answer(req, url, match) : undefined);

const ROUTES: Route[] = [
  matching(/^\/api\/previews\/(pv-[\w-]+)\/announce$/, onPost(announce)),
  matching(/^\/api\/previews\/(pv-[\w-]+)\/verdict$/, onPost(relayVerdict)),
  exactly("GET", "/api/preview", describePreview),
  exactly("POST", "/api/preview/seen", markSeen),
  exactly("POST", "/api/preview/verdict", sendVerdict),
];

export const previewsRoute = async (req: Request, url: URL, path: string) => (path.startsWith("/api/preview") ? firstAnswer(ROUTES, req, url, path) : undefined);
