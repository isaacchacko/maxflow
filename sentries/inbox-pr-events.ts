import { isRecord } from "../shared/guards";
import { closeTask, dig, log, onBoard, repoAndNumber, run, shortened, stringField } from "./inbox-board";
import { feed, remember } from "./inbox-feed";
import { isBareAck, noteFyi } from "./inbox-fyi";
import { GITHUB_BOT_LOGIN } from "./inbox-github";
import { state } from "./inbox-state";

export type LocalFiles = { ownPrs: () => Set<string>; flakyChecks: () => RegExp[] };
type PrEvent = {
  pr: string;
  state: string | undefined;
  failed: string[];
  isToldToSession: boolean;
  sha: string | undefined;
  body: string | undefined;
  who: string | undefined;
  author: string | undefined;
  url: string | undefined;
  path: string | undefined;
};
type PersonEvent = { kind: string; event: PrEvent; who: string; url: string; isMine: boolean };

const PR_TOPIC = /^gh\/[^/]+\/[^/]+\/pr\/\d+\/(\w+)$/;
const PERSON_KINDS = new Set(["comment", "review", "thread"]);

function prEventOf(data: unknown): PrEvent | undefined {
  if (!isRecord(data)) return undefined;
  const pr = stringField(data, "pr");
  if (pr === undefined || pr === "") return undefined;
  const failed = data["failed"];
  const told = data["told"];
  return {
    pr,
    state: stringField(data, "state"),
    failed: Array.isArray(failed) ? failed.filter((f) => typeof f === "string") : [],
    isToldToSession: Array.isArray(told) && told.length > 0,
    sha: stringField(data, "sha"),
    body: stringField(data, "body"),
    who: stringField(data, "who"),
    author: stringField(data, "author"),
    url: stringField(data, "url"),
    path: stringField(data, "path"),
  };
}

function runIdOfFailedCheck(check: unknown, failed: string[]) {
  const name = dig(check, ["name"]);
  const link = dig(check, ["link"]);
  return typeof name === "string" && typeof link === "string" && failed.includes(name) ? /actions\/runs\/(\d+)/.exec(link)?.[1] : undefined;
}

function failedRunIds(repo: string, n: string, failed: string[]) {
  const checks: unknown = JSON.parse(run(["gh", "pr", "checks", n, "-R", repo, "--json", "name,link,state"]) || "[]");
  const ids = Array.isArray(checks) ? checks.map((check: unknown) => runIdOfFailedCheck(check, failed)) : [];
  return new Set(ids.filter((id) => id !== undefined));
}

function rerunFlaky(key: string, event: PrEvent, flaky: RegExp[]) {
  const { failed } = event;
  const tag = `${key}@${String(event.sha)}`;
  const isAllFlaky = flaky.length > 0 && failed.length > 0 && failed.every((f) => flaky.some((re) => re.test(f)));
  if (!isAllFlaky || state.reruns.includes(tag)) return null;
  state.reruns = [...state.reruns, tag].slice(-500);
  const [repo = "", n = ""] = key.split("#", 2);
  const runs = failedRunIds(repo, n, failed);
  for (const id of runs) run(["gh", "run", "rerun", id, "--failed", "-R", repo]);
  log(`re-ran flaky ${failed.join(", ")} on ${key} (${[...runs].join(", ") || "no runs found"})`);
  return runs.size > 0 ? `re-ran known-flaky ${failed.join(", ")} once` : null;
}

async function onCiFailure(key: string, url: string, event: PrEvent, files: LocalFiles) {
  const rerun = rerunFlaky(key, event, files.flakyChecks());
  if (event.isToldToSession) return;
  const failed = `CI failed: ${event.failed.join(", ") || String(event.state)}`;
  const task = await onBoard(key, url, rerun ?? failed, { title: `CI failing on ${repoAndNumber(key)}` });
  if (task !== null && rerun === null) feed({ task, key, source: "ci", who: "CI", where: key, text: failed, link: url });
}

function rememberComment(key: string, event: PrEvent, who: string) {
  const isHis = who.startsWith("the user");
  remember(key, { at: Date.now(), who: isHis ? "Isaac" : who, text: shortened(event.body ?? "", 600), mine: isHis, user: event.author, raw: event.body, link: event.url });
}

const isAckOnly = (kind: string, reviewState: string, body: string) => (body.trim() === "" ? kind === "review" && reviewState !== "changes requested" : isBareAck(body));
const noteAck = async (key: string, what: string, body: string, link: string) => noteFyi(`${what}${body.trim() === "" ? "" : `: "${body.trim()}"`} on ${repoAndNumber(key)}`, link);

async function notePersonEvent(key: string, person: PersonEvent) {
  const { kind, event, who, url, isMine } = person;
  const reviewState = String(event.state).toLowerCase().replace("_", " ");
  const path = event.path ?? "";
  const body = event.body ?? "";
  const what = kind === "review" ? `${who} reviewed (${reviewState})` : `${who} commented${path === "" ? "" : ` on ${path}`}`;
  if (isAckOnly(kind, reviewState, body)) {
    await noteAck(key, what, body, event.url ?? url);
    return;
  }
  const task = await onBoard(key, url, `${what}: "${shortened(body, 120)}"`, { title: `${what} on ${repoAndNumber(key)}`, ...(!isMine && { status: "you" }) });
  if (task === null) return;
  const verdict = kind === "review" ? `**${reviewState}**${body === "" ? "" : "\n\n"}` : "";
  const raw = `${verdict}${body}${path === "" ? "" : `\n\n\`${path}\``}`;
  const text = `${what}: "${shortened(body, 500)}"${path === "" ? "" : ` (${path})`}`;
  feed({ task, key, source: "github", who, where: key, text, link: event.url ?? url, at: Date.now(), user: event.author, raw });
}

const isFromBot = (event: PrEvent) => GITHUB_BOT_LOGIN.test(event.author ?? "") || GITHUB_BOT_LOGIN.test(event.who ?? "");

async function onPersonActivity(kind: string, event: PrEvent, url: string, isMine: boolean) {
  const who = event.who ?? "";
  if (who === "" || !PERSON_KINDS.has(kind) || isFromBot(event)) return;
  if ((event.body ?? "") !== "") rememberComment(event.pr, event, who);
  if (event.isToldToSession || who.startsWith("the user")) return;
  await notePersonEvent(event.pr, { kind, event, who, url, isMine });
}

type PrContext = { files: LocalFiles; url: string; isMine: boolean; isReviewing: boolean };

async function routePrEvent(kind: string, event: PrEvent, context: PrContext) {
  const { files, url, isMine, isReviewing } = context;
  if (isMine && kind === "ci" && event.state !== "SUCCESS") await onCiFailure(event.pr, url, event, files);
  else if (isReviewing && (kind === "merged" || kind === "closed")) await closeTask(event.pr, `the PR was ${kind}`);
  else await onPersonActivity(kind, event, url, isMine);
}

export async function onPrEvent(topic: string, data: unknown, files: LocalFiles) {
  const kind = PR_TOPIC.exec(topic)?.[1];
  const event = prEventOf(data);
  if (kind === undefined || !event) return;
  const reviewing = state.prs[event.pr];
  const isMine = files.ownPrs().has(event.pr);
  if (!reviewing && !isMine) return;
  const url = reviewing?.url ?? `https://github.com/${event.pr.replace("#", "/pull/")}`;
  await routePrEvent(kind, event, { files, url, isMine, isReviewing: reviewing !== undefined });
}
