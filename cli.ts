#!/usr/bin/env bun
import { BASE as base } from "./instance";
const [verb, ...rest] = process.argv.slice(2);
const usage = `usage:
  maxflow ls
  maxflow new [--name N] [--cwd DIR] [--role router|worker] [--objective ID] [--parent ID] [--scope S] [-- cmd ...]   from a router: its worker
  maxflow send <id> <text...> [--no-enter] [--isaac]   type text, then Enter; --isaac: the funnel relaying Isaac's own request
  maxflow keys <id> <key...>                 tmux key names: Enter Escape C-c Up BTab ...
  maxflow screen <id> [--history N]          print the screen as plain text
  maxflow wait <id> [--idle MS] [--match RE] [--timeout MS]   block until quiet / RE on screen / exit, print screen
  maxflow wait thread:<id> | approval:<pr> | ci:<pr> | agent:<id> [agent:<id>…] | slack:<permalink | channel | #channel | query> | done   declare what you wait on; you sleep from your turn's end until a message wakes you
  maxflow rename <id> <name...> | maxflow kill <id>
  maxflow notify <id> <text...> [--isaac]    deliver text once the session is idle at an empty claude prompt; --isaac as for send
  maxflow who router|parent|workers|objective   the agents around you, as mf-<id> names for SendMessage
  maxflow ask <question...> [--re THREAD] [--default REC] [--new] [--image PATH]   ask the user in a thread of yours, flagged as waiting on him; prints its id.
                                             Refused when an open ask on your objective reads the same: add to that one with --re, or --new if yours differs.
                                             --re: ask again in that thread; --default: your recommendation for a reversible step, which you go ahead with if he hasn't answered in 3h
  maxflow todo ls [--day YYYY-MM-DD] [--json]   his todos (all days, or that day's): id, day, state (todo|doing|done|cancelled), text, tagged thread ids
  maxflow todo tag <todo id> <thread id> | maxflow todo untag <todo id> <thread id>   show a thread under his todo, indented, or take it off
  maxflow restrictions ls [--json]           his autonomy restrictions: id, mode (allow|ask|deny), label, scope
  maxflow restrictions check --tool <name> [--input <json>] [--cwd D] [--objective O]   the mode that applies to that tool call, and which restriction
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
  maxflow thread new <title...> [--objective ID] | maxflow thread new --parent <thread id>:<message id> [text...]   a subthread under that message | maxflow thread post <thread id> <text...> | maxflow thread status <thread id> <line...> | maxflow threads
  maxflow thread read <thread id> [--last N]   print a thread's messages as text, e.g. one he @-mentions
                                             --image PATH on thread new/post/done and ask, repeatable: shows him that png/jpg/gif/webp inline
  maxflow thread merge <thread id> <into thread id>   fold a duplicate into another thread: messages, routers, ask and waits move, the duplicate leaves the inbox
  maxflow thread move <thread id> <objective id>   re-home a thread and its subthreads onto that objective and its routers
  maxflow page put <objective/ID | task/tN> '<block json>' | maxflow page rm <ref> <block id>
  maxflow install                            run this checkout as the login service and add its hooks to ~/.claude/settings.json`;
import { fetchPrs, links, parsePr, readStatus, readWatches, render, writeWatches } from "./sentries/gh";
import * as slack from "./sentries/slack";
import { loadRestrictions, resolve, type Restriction } from "./restrictions";
const flag = (args: string[], k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const positional = (args: string[], valued: string[]) => args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));

// The server draws a session reading or typing into another in the graph, so it needs to know who is calling.
const caller = process.env.MAXFLOW_SESSION ? { "x-maxflow-from": process.env.MAXFLOW_SESSION } : undefined;

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: caller });
  if (!res.ok) console.error(`${res.status} ${await res.text()}`), process.exit(1);
  return res.status === 204 ? null : res.json();
}
// Using a sentry through the CLI draws this session touching it in the graph; maxflow being down never fails the verb.
const touchSentry = (sentry: string, kind: "read" | "write") =>
  caller && fetch(`${base}/api/touch`, { method: "POST", headers: caller, body: JSON.stringify({ sentry, kind }) }).catch(() => {});

// An image an agent shows him goes into the same uploads store as his pasted ones, as the same markdown, so it renders inline.
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const withoutImages = (args: string[]) => args.filter((a, i) => a !== "--image" && args[i - 1] !== "--image");
async function withImages(text: string, args: string[]) {
  const shown = [];
  for (const file of args.filter((_, i) => args[i - 1] === "--image")) {
    const type = IMAGE_TYPES[file.split(".").at(-1)!.toLowerCase()];
    if (!type || !(await Bun.file(file).exists())) console.error(`--image ${file}: no png, jpg, gif or webp file there`), process.exit(1);
    const res = await fetch(`${base}/api/uploads`, { method: "POST", headers: { ...caller, "content-type": type }, body: Bun.file(file) });
    if (!res.ok) console.error(`--image ${file}: ${res.status} ${await res.text()}`), process.exit(1);
    shown.push(`![image](${((await res.json()) as { path: string }).path})`);
  }
  return [text, ...shown].filter(Boolean).join("\n");
}

async function create(body: { name?: string; cmd?: string[]; cwd?: string; role?: string; objective?: string; parent?: string; scope?: string }) {
  const res = await fetch(`${base}/api/sessions`, { method: "POST", headers: caller, body: JSON.stringify(body) });
  if (!res.ok) console.error(`${res.status} ${await res.text()}`), process.exit(1);
  const s = await res.json();
  console.log(`${base}/#agent/${s.id}`);
}

if (verb === "ls") {
  for (const s of await (await fetch(`${base}/api/sessions`)).json()) console.log(`${s.id}  ${s.running ? "run " : "exit"}  ${s.name}  ${base}/#agent/${s.id}`);
} else if (verb === "chats") {
  for (const c of await (await fetch(`${base}/api/chats?limit=30&q=${encodeURIComponent(rest.join(" "))}`)).json())
    console.log(`${c.id}  ${c.session ? "mf  " : c.live ? "live" : "    "}  ${c.title.slice(0, 60).padEnd(60)}  ${c.cwd}`);
} else if (verb === "resume" && rest[0]) {
  const res = await fetch(`${base}/api/chats/${rest[0]}/resume`, { method: "POST", body: JSON.stringify({ bypass: !rest.includes("--safe"), force: rest.includes("--force") }) });
  if (res.status === 409) console.error("that chat is open in another claude process; rerun with --force to fork it"), process.exit(1);
  if (!res.ok) console.error(await res.text()), process.exit(1);
  console.log(`${base}/#agent/${(await res.json()).id}`);
} else if (verb === "new") {
  const dash = rest.indexOf("--");
  const flags = dash === -1 ? rest : rest.slice(0, dash);
  const role = flag(flags, "--role") as "router" | "worker" | undefined;
  await create({ name: flag(flags, "--name"), cwd: flag(flags, "--cwd") ?? process.cwd(), cmd: dash === -1 ? undefined : rest.slice(dash + 1), role, objective: flag(flags, "--objective"), parent: flag(flags, "--parent"), scope: flag(flags, "--scope") });
} else if (verb === "send" && rest[1]) {
  const [id, ...words] = positional(rest, []);
  await call(`/api/sessions/${id}/input`, { method: "POST", body: JSON.stringify({ text: words.join(" "), enter: !rest.includes("--no-enter"), isaac: rest.includes("--isaac") }) });
} else if (verb === "keys" && rest[1]) {
  await call(`/api/sessions/${rest[0]}/input`, { method: "POST", body: JSON.stringify({ keys: rest.slice(1) }) });
} else if (verb === "screen" && rest[0]) {
  console.log((await call(`/api/sessions/${rest[0]}/screen?history=${flag(rest, "--history") ?? 0}`)).screen);
} else if (verb === "wait" && /^(thread|q|approval|ci|agent|slack):.|^done$/.test(rest[0] ?? "")) {
  const me = process.env.MAXFLOW_SESSION;
  if (!me) console.error("wait works only inside a maxflow session"), process.exit(1);
  const [kind, ...ref] = rest[0].split(":");
  let target = ref.join(":");
  // Several agents: whichever messages or finishes first ends the wait.
  if (kind === "agent") target = [target, ...rest.slice(1).filter((a) => a.startsWith("agent:")).map((a) => a.slice(6))].join(",");
  // A PR wait ties the session to the PR, so gh sentry's notice of the review or CI is what wakes it.
  if (kind === "approval" || kind === "ci") {
    const pr = parsePr(target, process.cwd());
    if (!pr) console.error(`can't tell which repo ${target} is in; use owner/repo#n or a PR url`), process.exit(1);
    target = pr;
    const prev = readWatches().find((w) => w.pr === pr)?.sessions ?? [];
    writeWatches([...readWatches().filter((w) => w.pr !== pr), { pr, sessions: [...new Set([...prev, me])] }]);
  }
  // A Slack wait ties the session to the thread, channel or search, so the slack sentry's next message there wakes it.
  if (kind === "slack") {
    const found = await slack.parseTarget([target, ...rest.slice(1)].join(" "));
    if (!found) console.error(`no channel named ${target}`), process.exit(1);
    target = found;
    const prev = slack.readWatches().find((w) => w.target === found)?.sessions ?? [];
    slack.writeWatches([...slack.readWatches().filter((w) => w.target !== found), { target: found, sessions: [...new Set([...prev, me])] }]);
  }
  // The server may name the wait differently: q:<n> is the thread that question moved into.
  const { wait } = await call(`/api/sessions/${me}/await`, { method: "POST", body: JSON.stringify({ kind, ref: target }) });
  // A wait on an agent already done is answered at once and leaves no wait.
  console.log(
    kind === "done" ? "done. End your turn now; you stay awake with your last reply on screen."
    : !wait ? `${kind}:${target} is already done; nothing to wait on.`
    : `waiting on ${wait.kind}:${wait.ref}. End your turn now; you sleep until a message wakes you.`,
  );
} else if (verb === "wait" && rest[0]) {
  const q = new URLSearchParams(Object.entries({ idle: flag(rest, "--idle"), match: flag(rest, "--match"), timeout: flag(rest, "--timeout") }).filter(([, v]) => v) as [string, string][]);
  const r = await call(`/api/sessions/${rest[0]}/wait?${q}`);
  console.log(r.screen);
  console.error(`[${r.reason}]`);
  if (r.reason === "timeout") process.exit(2);
} else if (verb === "rename" && rest[1]) {
  await call(`/api/sessions/${rest[0]}`, { method: "PATCH", body: JSON.stringify({ name: rest.slice(1).join(" ") }) });
} else if (verb === "kill" && rest[0]) {
  await call(`/api/sessions/${rest[0]}`, { method: "DELETE" });
} else if (verb === "who" && rest[0]) {
  // The agents around the caller by role, as the mf-<id> names SendMessage takes.
  const all = await (await fetch(`${base}/api/sessions`)).json();
  const me = all.find((s: { id: string }) => s.id === process.env.MAXFLOW_SESSION);
  if (!me?.role) console.error("who works only inside a maxflow agent with a role (router or worker)"), process.exit(1);
  const live = all.filter((s: { running: boolean; id: string; role?: { objective: string } }) => s.running && s.id !== me.id && s.role?.objective === me.role.objective);
  const routerOf = me.role.role === "router" ? undefined : me.role.parent;
  const pick: Record<string, (s: { id: string; role: { role: string; parent?: string } }) => boolean> = {
    router: (s) => s.role.role === "router" && (!routerOf || s.id === routerOf),
    parent: (s) => s.id === routerOf,
    workers: (s) => s.role.parent === me.id,
    objective: () => true,
  };
  if (!pick[rest[0]]) console.error("who router|parent|workers|objective"), process.exit(1);
  for (const s of live.filter(pick[rest[0]])) console.log(`mf-${s.id}  ${s.role.role.padEnd(6)}  ${s.status.padEnd(7)}  ${s.name}`);
} else if (verb === "notify" && rest[1]) {
  const [id, ...words] = positional(rest, []);
  await call(`/api/sessions/${id}/notify`, { method: "POST", body: JSON.stringify({ text: words.join(" "), isaac: rest.includes("--isaac") }) });
} else if (verb === "ask" && rest[0]) {
  if (!process.env.MAXFLOW_SESSION) console.error("ask works only inside a maxflow session"), process.exit(1);
  const t = await call("/api/asks", { method: "POST", body: JSON.stringify({ text: await withImages(positional(rest, ["--re", "--default", "--image"]).join(" "), rest), re: flag(rest, "--re"), default: flag(rest, "--default"), new: rest.includes("--new") }) });
  console.log(`${t.id}: asked in "${t.title}" in his inbox, flagged as waiting on him (it goes in the thread you were handed; --new for a thread of its own, --re <id> for another). Keep working; his reply arrives in your prompt. Once nothing is left that doesn't hang on it, run \`maxflow wait thread:${t.id}\` and end your turn.`);
} else if (verb === "todo" && rest[0] === "ls") {
  const day = flag(rest, "--day");
  const todos = ((await call("/api/todos")) as { id: string; day: string; state: string; text: string; threadIds: string[]; at: string }[])
    .filter((t) => !day || t.day === day)
    .sort((a, b) => a.day.localeCompare(b.day) || a.at.localeCompare(b.at))
    .map(({ id, day, state, text, threadIds }) => ({ id, day, state, text, threadIds }));
  if (rest.includes("--json")) console.log(JSON.stringify(todos, null, 2));
  else for (const t of todos) console.log(`${t.id}  ${t.day}  ${t.state.padEnd(9)}  ${t.text}${t.threadIds.length ? `  [${t.threadIds.join(" ")}]` : ""}`);
} else if (verb === "todo" && (rest[0] === "tag" || rest[0] === "untag") && rest[1] && rest[2]) {
  const t = await call(`/api/todos/${rest[1]}/threads/${rest[2]}`, { method: rest[0] === "tag" ? "POST" : "DELETE" });
  console.log(`${t.id}  ${t.text}  [${t.threadIds.join(" ")}]`);
} else if (verb === "restrictions" && rest[0] === "ls") {
  const list = (await call("/api/restrictions")) as Restriction[];
  if (rest.includes("--json")) console.log(JSON.stringify(list, null, 2));
  else for (const r of list) console.log(`${r.id.padEnd(12)}  ${r.mode.padEnd(5)}  ${r.label}${r.scope?.objective || r.scope?.cwd ? `  (${[r.scope.objective, r.scope.cwd].filter(Boolean).join(" ")})` : ""}`);
} else if (verb === "restrictions" && rest[0] === "check" && flag(rest, "--tool")) {
  // Read from disk, as the enforcement hook does, so the answer is the same whether or not the server is up.
  let input: Record<string, unknown> | undefined;
  try { input = JSON.parse(flag(rest, "--input") ?? "{}"); } catch { console.error("--input: not JSON"), process.exit(1); }
  const { mode, restriction } = resolve(loadRestrictions(), { tool: flag(rest, "--tool")!, input, cwd: flag(rest, "--cwd") ?? process.cwd(), objective: flag(rest, "--objective") });
  console.log(restriction ? `${mode}  ${restriction.id}  ${restriction.label}` : `${mode}  (no restriction matches)`);
} else if (verb === "tasks") {
  for (const t of await call("/api/tasks"))
    if (rest.includes("--all") || (t.status !== "done" && t.status !== "dropped"))
      console.log(`t${t.id}  ${t.status.padEnd(7)}  ${t.kind === "question" ? "? " : ""}${t.title}  [${t.sessions.join(" ")}]\n${t.timeline.map((e: { at: number; text: string }) => `  ${new Date(e.at).toLocaleString()}  ${e.text}`).join("\n")}${t.answer ? `\n  answer: ${t.answer}` : ""}\n`);
} else if (verb === "task" && rest[0]) {
  const valued = ["--title", "--status", "--answer", "--session", "--link", "--event", "--at", "--objective"];
  const [ref, ...words] = positional(rest, valued);
  const at = flag(rest, "--at");
  const edit = {
    title: flag(rest, "--title") ?? (ref === "new" ? words.join(" ") : undefined),
    status: flag(rest, "--status"),
    kind: rest.includes("--question") ? "question" : undefined,
    answer: flag(rest, "--answer"),
    session: flag(rest, "--session"),
    link: flag(rest, "--link"),
    event: flag(rest, "--event"),
    objective: flag(rest, "--objective"),
    at: at ? (/^\d+$/.test(at) ? Number(at) : Date.parse(at)) : undefined,
  };
  const t = await call(ref === "new" ? "/api/tasks" : `/api/tasks/${ref.replace(/^t/, "")}`, { method: "POST", body: JSON.stringify(edit) });
  console.log(`t${t.id} ${t.status}: ${t.title}`);
} else if (verb === "link" && rest[1]) {
  await call("/api/link", { method: "POST", body: JSON.stringify({ a: rest[0], b: rest[1], why: rest.slice(2).join(" ") || undefined }) });
} else if (verb === "pub" && rest[0]) {
  console.log(JSON.stringify(await call("/api/events", { method: "POST", body: JSON.stringify({ topic: rest[0], data: rest[1] ? JSON.parse(rest[1]) : null }) })));
} else if (verb === "sub" && rest[0]) {
  const topic = encodeURIComponent(rest[0]);
  let after = flag(rest, "--since") ?? (await fetch(`${base}/api/events?topic=${topic}&after=now`)).headers.get("x-maxflow-seq")!;
  const deadline = Date.now() + Number(flag(rest, "--timeout") ?? Infinity);
  for (;;) {
    const wait = Math.min(deadline - Date.now(), 240_000);
    if (wait <= 0) console.error("[timeout]"), process.exit(2);
    const events = await call(`/api/events?topic=${topic}&after=${after}&wait=${wait}`);
    for (const e of events) console.log(JSON.stringify(e));
    if (events.length && !rest.includes("--follow")) break;
    if (events.length) after = String(events.at(-1).seq);
  }
} else if (verb === "gh" && rest[0] === "status") {
  await touchSentry("gh", "read");
  const ref = positional(rest.slice(1), [])[0];
  const me = process.env.MAXFLOW_SESSION;
  const polled = readStatus();
  const mine = ref ? [] : (await links()).filter((l) => l.session === me);
  const onBranch = (l: { repo: string; branch?: string }) => {
    const key = Object.keys(polled).find((k) => k.startsWith(`${l.repo}#`) && polled[k].pr.headRefName === l.branch);
    const pr = !key && l.branch ? fetchPrs(l.repo, [], [l.branch]).byBranch.get(l.branch) : undefined;
    return key ?? (pr && `${l.repo}#${pr.number}`);
  };
  const prs = ref ? [parsePr(ref, process.cwd())] : [...new Set(mine.flatMap((l) => l.pr ?? onBranch(l) ?? []))];
  if (prs.includes(null)) console.error(`can't tell which repo ${ref} is in; use owner/repo#n or a PR url`), process.exit(1);
  if (!prs.length) console.error("you're tied to no PR; name one"), process.exit(1);
  for (const key of prs as string[]) {
    let entry = polled[key];
    // Not polled lately: ask GitHub once, and watch it so the sentry keeps it from now on.
    if (!entry || Date.now() - entry.at > 120_000) {
      const [repo, n] = key.split("#");
      const pr = fetchPrs(repo, [Number(n)], []).byNumber.get(Number(n));
      if (!pr) console.error(`${key}: not found`), process.exit(1);
      entry = { at: Date.now(), pr };
      if (me && pr.state === "OPEN" && !readWatches().some((w) => w.pr === key && w.sessions.includes(me)))
        writeWatches([...readWatches().filter((w) => w.pr !== key), { pr: key, sessions: [...(readWatches().find((w) => w.pr === key)?.sessions ?? []), me] }]);
    }
    console.log(rest.includes("--json") ? JSON.stringify(entry.pr) : `${render(key, entry.pr, entry.at)}\n`);
  }
} else if (verb === "slack" && rest[0] === "read" && rest[1]) {
  await touchSentry("slack", "read");
  const ref = positional(rest.slice(1), ["--last"]).join(" ");
  const target = await slack.parseTarget(ref);
  if (!target) console.error(`no channel named ${ref}`), process.exit(1);
  const me = process.env.MAXFLOW_SESSION;
  let got = slack.readMessages()[target];
  // Not polled lately: ask Slack once, and watch it so the sentry keeps it from now on.
  if (!got || Date.now() - got.at > 180_000) {
    got = { at: Date.now(), ...(await slack.read(target)) };
    if (me && !slack.readWatches().some((w) => w.target === target && w.sessions.includes(me)))
      slack.writeWatches([...slack.readWatches().filter((w) => w.target !== target), { target, sessions: [...(slack.readWatches().find((w) => w.target === target)?.sessions ?? []), me] }]);
  }
  const [channel, thread] = target.split("/");
  console.log(`${got.title}  (polled ${Math.round((Date.now() - got.at) / 1000)}s ago)`);
  for (const m of got.msgs.slice(-Number(flag(rest, "--last") ?? 20)))
    console.log(`\n${m.who}${m.channel ? ` in ${m.channel}` : ""}  ${new Date(Number(m.ts) * 1000).toLocaleString()}  ${m.link ?? slack.permalink(channel, m.ts, thread)}\n${m.text}`);
} else if (verb === "gh" && rest[0] === "ls") {
  for (const w of readWatches()) console.log(`${w.pr}  ${w.sessions.join(", ") || "(no session)"}`);
} else if (verb === "gh" && (rest[0] === "watch" || rest[0] === "unwatch") && rest[1]) {
  await touchSentry("gh", "write");
  const pr = parsePr(rest[1], process.cwd());
  if (!pr) console.error(`can't tell which repo ${rest[1]} is in; use owner/repo#n or a PR url`), process.exit(1);
  const session = flag(rest, "--session") ?? process.env.MAXFLOW_SESSION;
  const watches = readWatches().filter((w) => w.pr !== pr);
  const prev = readWatches().find((w) => w.pr === pr)?.sessions ?? [];
  if (rest[0] === "watch") watches.push({ pr, sessions: [...new Set([...prev, ...(session ? [session] : [])])] });
  writeWatches(watches);
  console.log(`${rest[0] === "watch" ? "watching" : "unwatched"} ${pr}${rest[0] === "watch" && session ? ` for session ${session}` : ""}`);
} else if (verb === "slack" && rest[0] === "ls") {
  for (const w of slack.readWatches()) console.log(`${w.target}  ${w.sessions.join(", ") || "(no session)"}`);
} else if (verb === "slack" && (rest[0] === "watch" || rest[0] === "unwatch") && rest[1]) {
  await touchSentry("slack", "write");
  const target = await slack.parseTarget(positional(rest.slice(1), ["--session"]).join(" "));
  if (!target) console.error(`no channel named ${rest[1]}`), process.exit(1);
  const session = flag(rest, "--session") ?? process.env.MAXFLOW_SESSION;
  const prev = slack.readWatches().find((w) => w.target === target)?.sessions ?? [];
  const watches = slack.readWatches().filter((w) => w.target !== target);
  if (rest[0] === "watch") watches.push({ target, sessions: [...new Set([...prev, ...(session ? [session] : [])])] });
  slack.writeWatches(watches);
  console.log(`${rest[0] === "watch" ? "watching" : "unwatched"} ${target}${rest[0] === "watch" && session ? ` for session ${session}` : ""}`);
} else if (verb === "objectives") {
  for (const o of await call("/api/objectives")) if (!o.closed) console.log(`${o.id}  ${o.title}  ${o.cwd}`);
} else if (verb === "objective" && rest[0] === "new" && rest[1]) {
  const o = await call("/api/objectives", { method: "POST", body: JSON.stringify({ title: positional(rest.slice(1), ["--cwd", "--scope"]).join(" "), cwd: flag(rest, "--cwd") ?? process.cwd(), scope: flag(rest, "--scope") }) });
  console.log(`objective ${o.id}, router ${o.router}  ${base}/#objective/${o.id}`);
} else if (verb === "objective" && rest[0] === "merge" && rest[2]) {
  const r = await call(`/api/objectives/${rest[1]}/merge`, { method: "POST", body: JSON.stringify({ into: rest[2] }) });
  console.log(`objective ${r.from} merged into ${r.into} (moved ${r.sessions.length} sessions)`);
} else if (verb === "route" && rest[1]) {
  const title = flag(rest, "--new");
  const r = await call(`/api/signals/${rest[0]}/route`, { method: "POST", body: JSON.stringify(title ? { title, cwd: flag(rest, "--cwd") ?? process.cwd() } : { objective: rest[1] }) });
  console.log(`signal ${rest[0]} → objective ${r.objective} (routers ${r.routedTo.join(", ")})`);
} else if (verb === "threads") {
  for (const t of await call("/api/threads")) console.log(`${t.id}  ${t.objective}  ${t.title}  (${t.messages.length} messages)`);
} else if (verb === "thread" && rest[0] === "new" && flag(rest, "--parent")) {
  const [thread, message] = flag(rest, "--parent")!.split(":");
  const t = await call("/api/threads", { method: "POST", body: JSON.stringify({ parent: { thread, message }, text: await withImages(positional(rest.slice(1), ["--parent", "--image"]).join(" "), rest) }) });
  console.log(t.id);
} else if (verb === "thread" && rest[0] === "new" && rest[1]) {
  const t = await call("/api/threads", { method: "POST", body: JSON.stringify({ title: positional(rest.slice(1), ["--objective", "--image"]).join(" "), objective: flag(rest, "--objective") }) });
  if (rest.includes("--image")) await call(`/api/threads/${t.id}/messages`, { method: "POST", body: JSON.stringify({ text: await withImages("", rest) }) });
  console.log(t.id);
} else if (verb === "thread" && rest[0] === "read" && rest[1]) {
  type Msg = { id: string; from: string; at: number; text: string };
  const all: { id: string; title: string; objective: string; messages: Msg[]; parent?: { thread: string; message: string }; mergedInto?: string }[] = await call("/api/threads");
  let t = all.find((x) => x.id === rest[1]);
  while (t?.mergedInto) t = all.find((x) => x.id === t!.mergedInto);
  if (!t) console.error(`no thread ${rest[1]}`), process.exit(1);
  const who = new Map<string, string>((await call("/api/sessions")).map((s: { id: string; name: string }) => [s.id, s.name]));
  const last = Number(flag(rest, "--last") ?? 0);
  const shown = last > 0 ? t.messages.slice(-last) : t.messages;
  console.log(`${t.id} "${t.title}"${t.objective ? ` on ${t.objective}` : ""}${t.parent ? `, a subthread of ${t.parent.thread} under ${t.parent.message}` : ""}: ${t.messages.length} messages${shown.length < t.messages.length ? `, the last ${shown.length} below` : ""}`);
  for (const m of shown) console.log(`\n${m.id}  ${new Date(m.at).toLocaleString()}  ${m.from === "isaac" ? "Isaac" : (who.get(m.from) ?? m.from)}\n${m.text}`);
} else if (verb === "thread" && (rest[0] === "post" || rest[0] === "done") && rest[2]) {
  // done: what commands answered with, kept as a plain post for agents that still run it.
  await call(`/api/threads/${rest[1]}/messages`, { method: "POST", body: JSON.stringify({ text: await withImages(withoutImages(rest.slice(2)).join(" "), rest) }) });
} else if (verb === "thread" && rest[0] === "merge" && rest[2]) {
  const t = await call(`/api/threads/${rest[1]}/merge`, { method: "POST", body: JSON.stringify({ into: rest[2] }) });
  console.log(`${rest[1]} merged into ${t.id} (${t.messages.length} messages)`);
} else if (verb === "thread" && rest[0] === "move" && rest[2]) {
  const r = await call(`/api/threads/${rest[1]}/objective`, { method: "POST", body: JSON.stringify({ objective: rest[2] }) });
  console.log(`moved ${r.threads.join(" ")} to ${r.objective} (routers ${r.routers.join(" ") || "none"})${r.handed?.length ? `; handed them his unanswered ${r.handed.join(" ")}` : ""}`);
} else if (verb === "thread" && rest[0] === "status" && rest[2]) {
  await call(`/api/threads/${rest[1]}/status`, { method: "POST", body: JSON.stringify({ text: rest.slice(2).join(" ") }) });
} else if (verb === "page" && (rest[0] === "put" || rest[0] === "rm") && rest[2]) {
  const body = rest[0] === "put" ? { ref: rest[1], block: JSON.parse(rest[2]) } : { ref: rest[1], id: rest[2] };
  await call("/api/pages", { method: rest[0] === "put" ? "POST" : "DELETE", body: JSON.stringify(body) });
} else if (verb === "install") {
  const { install, LABEL, LOG } = await import("./service");
  const r = install();
  console.log(r.ok ? `service ${LABEL} running ${base}, logging to ${LOG}` : `service install failed:\n${r.out}`);
  const { installHooks } = await import("./hooks/install");
  console.log(installHooks());
} else {
  console.log(usage);
  process.exit(1);
}
