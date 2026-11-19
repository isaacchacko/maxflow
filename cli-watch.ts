import { argAt, didTouchSentry, fail, flag, hasArg, isBlank, mySession, positional, type Verb } from "./cli-shared";
import { fetchPrs, links, parsePr, readStatus, readWatches, render, writeWatches, type Link, type PolledPr } from "./gh";
import * as slackRead from "./slack-read";

const GH_POLL_STALE_MS = 120_000;
const SLACK_POLL_STALE_MS = 180_000;

function prOnBranch(l: Link, polled: Record<string, PolledPr>) {
  const key = Object.keys(polled).find((k) => k.startsWith(`${l.repo}#`) && polled[k]?.pr.headRefName === l.branch);
  if (key !== undefined) return key;
  const pr = l.branch === undefined || l.branch === "" ? undefined : fetchPrs(l.repo, [], [l.branch]).byBranch.get(l.branch);
  return pr === undefined ? undefined : `${l.repo}#${pr.number}`;
}

async function prsTiedToMe(ref: string | undefined, polled: Record<string, PolledPr>) {
  if (!isBlank(ref)) return [parsePr(ref, process.cwd())];
  const me = mySession();
  const mine = (await links()).filter((l) => l.session === me);
  return [...new Set(mine.flatMap((l) => l.pr ?? prOnBranch(l, polled) ?? []))];
}

function watchPrFrom(key: string, me: string | undefined) {
  if (isBlank(me)) return;
  if (readWatches().every((w) => !(w.pr === key && w.sessions.includes(me))))
    writeWatches([...readWatches().filter((w) => w.pr !== key), { pr: key, sessions: [...(readWatches().find((w) => w.pr === key)?.sessions ?? []), me] }]);
}

function freshEntry(key: string, polled: Record<string, PolledPr>): PolledPr {
  const entry = polled[key];
  if (entry && Date.now() - entry.at <= GH_POLL_STALE_MS) return entry;
  const [repo = "", n = ""] = key.split("#", 2);
  const pr = fetchPrs(repo, [Number(n)], []).byNumber.get(Number(n));
  if (!pr) fail(`${key}: not found`);
  if (pr.state === "OPEN") watchPrFrom(key, mySession());
  return { at: Date.now(), pr };
}

async function ghStatus(args: string[]) {
  await didTouchSentry("gh", "read");
  const ref = positional(args.slice(1), [])[0];
  const polled = readStatus();
  const prs = await prsTiedToMe(ref, polled);
  if (prs.includes(null)) fail(`can't tell which repo ${String(ref)} is in; use owner/repo#n or a PR url`);
  if (prs.length === 0) fail("you're tied to no PR; name one");
  const keys = prs.filter((pr) => pr !== null);
  for (const key of keys) {
    const entry = freshEntry(key, polled);
    console.log(args.includes("--json") ? JSON.stringify(entry.pr) : `${render(key, entry.pr, entry.at)}\n`);
  }
}

function watchSlackFrom(target: string, me: string | undefined) {
  if (isBlank(me)) return;
  if (slackRead.readWatches().every((w) => !(w.target === target && w.sessions.includes(me))))
    slackRead.writeWatches([...slackRead.readWatches().filter((w) => w.target !== target), { target, sessions: [...(slackRead.readWatches().find((w) => w.target === target)?.sessions ?? []), me] }]);
}

async function freshSlack(target: string): Promise<slackRead.Kept> {
  const kept = slackRead.readMessages()[target];
  if (kept && Date.now() - kept.at <= SLACK_POLL_STALE_MS) return kept;
  const got = { at: Date.now(), ...(await slackRead.read(target)) };
  watchSlackFrom(target, mySession());
  return got;
}

async function slackReadVerb(args: string[]) {
  await didTouchSentry("slack", "read");
  const ref = positional(args.slice(1), ["--last"]).join(" ");
  const target = await slackRead.parseTarget(ref);
  if (target === null || target === "") fail(`no channel named ${ref}`);
  const got = await freshSlack(target);
  const { channel, thread } = slackRead.splitTarget(target);
  console.log(`${got.title}  (polled ${Math.round((Date.now() - got.at) / 1000)}s ago)`);
  const shown = got.msgs.slice(-Number(flag(args, "--last") ?? 20));
  for (const m of shown) console.log(`\n${m.who}${isBlank(m.channel) ? "" : ` in ${m.channel}`}  ${new Date(Number(m.ts) * 1000).toLocaleString()}  ${m.link ?? slackRead.permalink(channel, m.ts, thread)}\n${m.text}`);
}

const withSession = (sessions: string[], session: string | undefined) => [...new Set([...sessions, ...(isBlank(session) ? [] : [session])])];
const watchedLine = (isWatch: boolean, what: string, session: string | undefined) => `${isWatch ? "watching" : "unwatched"} ${what}${isWatch && !isBlank(session) ? ` for session ${session}` : ""}`;

async function ghWatch(args: string[]) {
  await didTouchSentry("gh", "write");
  const pr = parsePr(argAt(args, 1), process.cwd());
  if (pr === null || pr === "") fail(`can't tell which repo ${argAt(args, 1)} is in; use owner/repo#n or a PR url`);
  const session = flag(args, "--session") ?? mySession();
  const isWatch = args[0] === "watch";
  const watches = readWatches().filter((w) => w.pr !== pr);
  const prev = readWatches().find((w) => w.pr === pr)?.sessions ?? [];
  if (isWatch) watches.push({ pr, sessions: withSession(prev, session) });
  writeWatches(watches);
  console.log(watchedLine(isWatch, pr, session));
}

async function slackWatch(args: string[]) {
  await didTouchSentry("slack", "write");
  const target = await slackRead.parseTarget(positional(args.slice(1), ["--session"]).join(" "));
  if (target === null || target === "") fail(`no channel named ${argAt(args, 1)}`);
  const session = flag(args, "--session") ?? mySession();
  const isWatch = args[0] === "watch";
  const prev = slackRead.readWatches().find((w) => w.target === target)?.sessions ?? [];
  const watches = slackRead.readWatches().filter((w) => w.target !== target);
  if (isWatch) watches.push({ target, sessions: withSession(prev, session) });
  slackRead.writeWatches(watches);
  console.log(watchedLine(isWatch, target, session));
}

function listGhWatches() {
  for (const w of readWatches()) console.log(`${w.pr}  ${w.sessions.join(", ") || "(no session)"}`);
}

function listSlackWatches() {
  for (const w of slackRead.readWatches()) console.log(`${w.target}  ${w.sessions.join(", ") || "(no session)"}`);
}

const isWatchVerb = (args: string[]) => (args[0] === "watch" || args[0] === "unwatch") && hasArg(args, 1);

export const watchVerbs: Verb[] = [
  { matches: (verb, args) => verb === "gh" && args[0] === "status", run: ghStatus },
  { matches: (verb, args) => verb === "slack" && args[0] === "read" && hasArg(args, 1), run: slackReadVerb },
  { matches: (verb, args) => verb === "gh" && args[0] === "ls", run: listGhWatches },
  { matches: (verb, args) => verb === "gh" && isWatchVerb(args), run: ghWatch },
  { matches: (verb, args) => verb === "slack" && args[0] === "ls", run: listSlackWatches },
  { matches: (verb, args) => verb === "slack" && isWatchVerb(args), run: slackWatch },
];
