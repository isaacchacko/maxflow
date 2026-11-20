#!/usr/bin/env bun
import { boardVerbs, objectiveVerbs } from "./cli-board";
import { browserVerbs } from "./cli-browser";
import { CANVAS_USAGE, canvasVerbs } from "./cli-canvas";
import { docVerbs } from "./cli-docs";
import { holdVerbs } from "./cli-holds";
import { eventVerbs, sessionVerbs } from "./cli-sessions";
import { base, type Verb } from "./cli-shared";
import { threadVerbs } from "./cli-threads";
import { timelineVerbs } from "./cli-timeline";
import { waitVerbs } from "./cli-wait";
import { watchVerbs } from "./cli-watch";

const usage = `usage:
  maxflow ls
  maxflow new [--name N] [--cwd DIR] [--role router|worker] [--objective ID] [--parent ID] [--scope S] [-- cmd ...]   from a router: its worker
  maxflow send <id> <text...> [--no-enter] [--isaac]   type text, then Enter; --isaac: the funnel relaying Isaac's own request
  maxflow keys <id> <key...>                 tmux key names: Enter Escape C-c Up BTab ...
  maxflow screen <id> [--history N]          print the screen as plain text
  maxflow wait <id> [--idle MS] [--match RE] [--timeout MS]   block until quiet / RE on screen / exit, print screen
  maxflow wait thread:<id> | approval:<pr> | ci:<pr | branch | sha> | agent:<id> [agent:<id>…] | slack:<permalink | channel | #channel | query> | done   declare what you wait on; you sleep from your turn's end until a message wakes you
  maxflow wait until '<what you wait for, in words>' -- <command...> | --pane <session> | --pid <pid>   sleep until a shell concludes: the server runs the command in its own pane (or watches the session or process), and you wake with its exit code and last lines
  maxflow rename <id> <name...> | maxflow kill <id>
  maxflow handoff <note-file>               when maxflow asks (your context is filling up): hand your work to a fresh agent with this note once your turn ends
  maxflow notify <id> <text...> [--isaac]    deliver text once the session is idle at an empty claude prompt; --isaac as for send
  maxflow who router|parent|workers|objective   the agents around you, as mf-<id> names for SendMessage
  maxflow ask <question...> [--re THREAD] [--default REC] [--new] [--image PATH]   ask the user in a thread of yours, flagged as waiting on him; prints its id.
                                             Refused when an open ask on your objective reads the same: add to that one with --re, or --new if yours differs.
                                             --re: ask again in that thread; --default: your recommendation for a reversible step, which you go ahead with if he hasn't answered in 3h
  maxflow todo ls [--day YYYY-MM-DD] [--json]   his todos (all days, or that day's): id, day, state (todo|doing|done|cancelled), text, tagged thread ids
  maxflow todo tag <todo id> <thread id> | maxflow todo untag <todo id> <thread id>   show a thread under his todo, indented, or take it off
  maxflow restrictions ls [--json]           his autonomy restrictions: id, mode (allow|ask|deny), label, scope
  maxflow restrictions check --tool <name> [--input <json>] [--cwd D] [--objective O]   the mode that applies to that tool call, and which restriction
  maxflow hold <pr> [why...] | maxflow unhold <pr> | maxflow holds   stand the sentries down on a PR: the approval sentry won't review, comment, hand back or send it for approval, and the review feed won't touch it
  maxflow tasks [--all]                      the user's task board, with each task's timeline; --all adds done and dropped ones
  maxflow task new <title...> | maxflow task <id> [--title T] [--status todo|doing|you|waiting|blocked|done|dropped] [--question] [--answer A]
                                             [--session ID] [--link URL] [--event TEXT] [--at TIME]   sentry:assistant's edits to the board
  maxflow link <id> <id> [why...]            introduce two sessions to each other, as drawing an edge in the graph does
  maxflow sub <topic-glob> [--since SEQ] [--timeout MS] [--follow]   block for the next matching event, print it as JSON
  maxflow pub <topic> [json]
  maxflow gh status [pr] [--json]           CI, checks, reviews, open threads from the sentry's last poll; no pr: every PR you're tied to
  maxflow gh watch <pr> [--session ID] | maxflow gh unwatch <pr> | maxflow gh ls
  maxflow slack read <permalink | channel id | #channel | query> [--last N]   latest messages from the sentry's last poll
  maxflow slack watch <permalink | channel id | #channel | query> [--session ID] | maxflow slack unwatch <same> | maxflow slack ls
  maxflow chats [query] | maxflow resume <claude-session-id> [--safe] [--force]
  maxflow objectives | maxflow objective new <title...> [--cwd DIR] [--scope S]   an objective and its first router
  maxflow objective merge <from id> <into id>   the target takes the source's agents, threads, tasks and signals; the source closes
  maxflow route <signal seq> <objective id> | maxflow route <signal seq> --new <title> [--cwd DIR]   the funnel routing a signal from the event log
  maxflow size <signal seq> direct|area|fyi|ignore [--cwd DIR] [--name N] [--note '<line>'] [--about <thread id>]   the funnel sizing a signal first: direct starts one worker on it, fyi notes a digest line, area is routed next
  maxflow promote <objective title...>   a direct worker whose job grew becomes the router of a new objective holding its thread
  maxflow thread new <title...> [--objective ID] | maxflow thread new --parent <thread id>:<message id> [text...]   a subthread under that message | maxflow thread post <thread id> <text...> [--as <device>/<name>, outside maxflow, where MAXFLOW_SESSION isn't set] | maxflow thread status <thread id> <line...> | maxflow threads
  maxflow thread read <thread id> [--last N]   print a thread's messages as text, e.g. one he @-mentions
                                             --image PATH on thread new/post/done and ask, repeatable: shows him that png/jpg/gif/webp inline
  maxflow thread merge <thread id> <into thread id>   fold a duplicate into another thread: messages, routers, ask and waits move, the duplicate leaves the inbox
  maxflow thread move <thread id> <objective id>   re-home a thread and its subthreads onto that objective and its routers
  maxflow page put <objective/ID | task/tN> '<block json>' | maxflow page rm <ref> <block id>
  maxflow docs ls | read <path> | write <path> [text...] | mv <path> <to> | rm <path>   Isaac's docs vault (markdown, git-committed per write; stdin when no text)
  ${CANVAS_USAGE}   a .canvas in the docs vault, one box per call (agents never clobber a box being typed in)
  maxflow timeline add <path> <title> [text...] [--at TIME] | now <path> [text...]   an event on a timeline (stdin when no text), or rewrite its now.txt; committed at once
  maxflow timeline read <path> [--last N] | ls [prefix] | find <words...>   now.txt then the last N events (default 10), the timelines under a folder, events matching every word
  maxflow browser open <url> | goto <url>   your own headless Chrome (started on demand, closed after 10 min unused): load a page, print its url and title
  maxflow browser screenshot [path] | read [--ax] | console [--last N]   a PNG (prints its path), the page's text or accessibility tree, its console
  maxflow browser click <selector | visible text> | type <selector | text> <text...> [--enter] | eval <js> | cdp | close   real input events; cdp prints the page's DevTools socket
  maxflow browser size [phone | tablet | laptop | desktop | WxH]   set the page size (phone 390x844 mobile at 3x, tablet 768x1024, laptop 1280x800, desktop 1920x1080); no size prints the current one
  maxflow deploy                             ship origin's feat/v2 to the live yarn: refuses a dirty live checkout or a commit whose CI check isn't green,
                                             fast-forwards, restarts, checks every session and sentry came back,
                                             and restarts the sentries whose code changed;
                                             one at a time, and a no-op when live is already at origin's tip
  maxflow install                            run this checkout as the login service and add its hooks to ~/.claude/settings.json`;

async function install() {
  const { install: installService, LABEL, LOG } = await import("./service");
  const r = installService();
  console.log(r.ok ? `service ${LABEL} running ${base}, logging to ${LOG}` : `service install failed:\n${r.out}`);
  const { installHooks } = await import("./hooks/install");
  console.log(installHooks());
}

const shipVerbs: Verb[] = [
  {
    matches: (verb) => verb === "deploy",
    run: async () => {
      await (await import("./deploy")).deploy();
    },
  },
  { matches: (verb) => verb === "install", run: install },
];

const VERBS: Verb[] = [...waitVerbs, ...sessionVerbs, ...boardVerbs, ...eventVerbs, ...watchVerbs, ...objectiveVerbs, ...threadVerbs, ...docVerbs, ...canvasVerbs, ...timelineVerbs, ...holdVerbs, ...browserVerbs, ...shipVerbs];

const [verb, ...rest] = process.argv.slice(2);
const chosen = VERBS.find((v) => v.matches(verb, rest));
if (chosen) await chosen.run(rest);
else {
  console.log(usage);
  process.exit(1);
}
