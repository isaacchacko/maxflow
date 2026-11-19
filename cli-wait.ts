import { argAt, base, fail, flag, isBlank, isTruthy, mySession, positional, post, replyOf, str, type Verb } from "./cli-shared";
import { parsePr, readWatches, writeWatches } from "./gh";
import * as slackRead from "./slack-read";

const WAIT_KIND = /^(thread|q|approval|ci|agent|slack):.|^done$/;

function sessionOrFail() {
  const me = mySession();
  if (me === undefined || me === "") fail("wait works only inside a maxflow session");
  return me;
}

async function waitUntil(args: string[]) {
  const me = sessionOrFail();
  const dash = args.indexOf("--");
  const head = dash === -1 ? args.slice(1) : args.slice(1, dash);
  const cmd = dash === -1 ? undefined : args.slice(dash + 1).join(" ");
  const pid = flag(head, "--pid");
  const pane = flag(head, "--pane");
  const desc = positional(head, ["--pid", "--pane"]).join(" ");
  if (desc === "" || (isBlank(cmd) && isBlank(pid) && isBlank(pane))) fail("usage: maxflow wait until '<what you wait for>' -- <command...> | --pane <session> | --pid <pid>");
  const until = { kind: "until", desc, cmd, cwd: process.cwd(), path: process.env["PATH"], pane, pid: isBlank(pid) ? undefined : Number(pid) };
  const wait = replyOf(await post(`/api/sessions/${me}/await`, until))["wait"];
  console.log(
    isTruthy(wait)
      ? `waiting until ${desc} (shell ${str(replyOf(wait), "ref")}, ${base}/#agent/${str(replyOf(wait), "ref")}). End your turn now; you sleep until it concludes or a message wakes you.`
      : `"${desc}" had already ended; its exit code and last lines are on their way to your prompt.`,
  );
}

function watchPr(pr: string, me: string) {
  const prev = readWatches().find((w) => w.pr === pr)?.sessions ?? [];
  writeWatches([...readWatches().filter((w) => w.pr !== pr), { pr, sessions: [...new Set([...prev, me])] }]);
}

function watchSlack(target: string, me: string) {
  const prev = slackRead.readWatches().find((w) => w.target === target)?.sessions ?? [];
  slackRead.writeWatches([...slackRead.readWatches().filter((w) => w.target !== target), { target, sessions: [...new Set([...prev, me])] }]);
}

async function waitTarget(kind: string, named: string, args: string[], me: string) {
  if (kind === "agent") return [named, ...args.slice(1).filter((a) => a.startsWith("agent:")).map((a) => a.slice(6))].join(",");
  if (kind === "approval" || kind === "ci") {
    const pr = parsePr(named, process.cwd());
    if (pr === null || pr === "") fail(`can't tell which repo ${named} is in; use owner/repo#n or a PR url`);
    watchPr(pr, me);
    return pr;
  }
  if (kind === "slack") {
    const found = await slackRead.parseTarget([named, ...args.slice(1)].join(" "));
    if (found === null || found === "") fail(`no channel named ${named}`);
    watchSlack(found, me);
    return found;
  }
  return named;
}

function waitAnswer(kind: string, target: string, wait: unknown) {
  if (kind === "done") return "done. End your turn now; you stay awake with your last reply on screen.";
  if (!isTruthy(wait)) return `${kind}:${target} is already done; nothing to wait on.`;
  return `waiting on ${str(replyOf(wait), "kind")}:${str(replyOf(wait), "ref")}. End your turn now; you sleep until a message wakes you.`;
}

async function waitOn(args: string[]) {
  const me = sessionOrFail();
  const what = argAt(args, 0);
  const colon = what.indexOf(":");
  const kind = colon === -1 ? what : what.slice(0, colon);
  const target = await waitTarget(kind, colon === -1 ? "" : what.slice(colon + 1), args, me);
  const wait = replyOf(await post(`/api/sessions/${me}/await`, { kind, ref: target }))["wait"];
  console.log(waitAnswer(kind, target, wait));
}

export const waitVerbs: Verb[] = [
  { matches: (verb, args) => verb === "wait" && args[0] === "until", run: waitUntil },
  { matches: (verb, args) => verb === "wait" && WAIT_KIND.test(argAt(args, 0)), run: waitOn },
];
