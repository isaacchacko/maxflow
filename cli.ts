#!/usr/bin/env bun
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
const [verb, ...rest] = process.argv.slice(2);
const usage = `usage:
  maxflow ls
  maxflow new [--name N] [--cwd DIR] [-- cmd ...]
  maxflow send <id> <text...> [--no-enter]   type text, then Enter
  maxflow keys <id> <key...>                 tmux key names: Enter Escape C-c Up BTab ...
  maxflow screen <id> [--history N]          print the screen as plain text
  maxflow wait <id> [--idle MS] [--match RE] [--timeout MS]   block until quiet / RE on screen / exit, print screen
  maxflow rename <id> <name...> | maxflow kill <id>
  maxflow notify <id> <text...>              deliver text once the session is idle at an empty claude prompt
  maxflow ask <question...> [--re QID]       raise a question to the user through sentry:questions; returns at once
  maxflow questions [--all]                  the user's question queue
  maxflow link <id> <id> [why...]            introduce two sessions to each other, as drawing an edge in the graph does
  maxflow sub <topic-glob> [--since SEQ] [--timeout MS] [--follow]   block for the next matching event, print it as JSON
  maxflow pub <topic> [json]
  maxflow gh status [pr] [--json]           CI, checks, reviews, open threads from the sentry's last poll; no pr: every PR you're tied to
  maxflow gh watch <pr> [--session ID] | maxflow gh unwatch <pr> | maxflow gh ls
  maxflow slack read <permalink | channel id | #channel | query> [--last N]   latest messages from the sentry's last poll
  maxflow slack watch <permalink | channel id | #channel | query> [--session ID] | maxflow slack unwatch <same> | maxflow slack ls
  maxflow chats [query] | maxflow resume <claude-session-id> [--safe] [--force]`;
import { fetchPrs, links, parsePr, readStatus, readWatches, render, writeWatches } from "./sentries/gh";
import * as slack from "./sentries/slack";
const flag = (args: string[], k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const positional = (args: string[], valued: string[]) => args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));

// The server draws a session reading or typing into another in the graph, so it needs to know who is calling.
const caller = process.env.MAXFLOW_SESSION ? { "x-maxflow-from": process.env.MAXFLOW_SESSION } : undefined;

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: caller });
  if (!res.ok) console.error(`${res.status} ${await res.text()}`), process.exit(1);
  return res.status === 204 ? null : res.json();
}

async function create(body: { name?: string; cmd?: string[]; cwd?: string }) {
  const res = await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify(body) });
  const s = await res.json();
  console.log(`${base}/s/${s.id}`);
}

if (verb === "ls") {
  for (const s of await (await fetch(`${base}/api/sessions`)).json()) console.log(`${s.id}  ${s.running ? "run " : "exit"}  ${s.name}  ${base}/s/${s.id}`);
} else if (verb === "chats") {
  for (const c of await (await fetch(`${base}/api/chats?limit=30&q=${encodeURIComponent(rest.join(" "))}`)).json())
    console.log(`${c.id}  ${c.session ? "mf  " : c.live ? "live" : "    "}  ${c.title.slice(0, 60).padEnd(60)}  ${c.cwd}`);
} else if (verb === "resume" && rest[0]) {
  const res = await fetch(`${base}/api/chats/${rest[0]}/resume`, { method: "POST", body: JSON.stringify({ bypass: !rest.includes("--safe"), force: rest.includes("--force") }) });
  if (res.status === 409) console.error("that chat is open in another claude process; rerun with --force to fork it"), process.exit(1);
  if (!res.ok) console.error(await res.text()), process.exit(1);
  console.log(`${base}/s/${(await res.json()).id}`);
} else if (verb === "new") {
  const dash = rest.indexOf("--");
  const flags = dash === -1 ? rest : rest.slice(0, dash);
  await create({ name: flag(flags, "--name"), cwd: flag(flags, "--cwd") ?? process.cwd(), cmd: dash === -1 ? undefined : rest.slice(dash + 1) });
} else if (verb === "send" && rest[1]) {
  const [id, ...words] = positional(rest, []);
  await call(`/api/sessions/${id}/input`, { method: "POST", body: JSON.stringify({ text: words.join(" "), enter: !rest.includes("--no-enter") }) });
} else if (verb === "keys" && rest[1]) {
  await call(`/api/sessions/${rest[0]}/input`, { method: "POST", body: JSON.stringify({ keys: rest.slice(1) }) });
} else if (verb === "screen" && rest[0]) {
  console.log((await call(`/api/sessions/${rest[0]}/screen?history=${flag(rest, "--history") ?? 0}`)).screen);
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
} else if (verb === "notify" && rest[1]) {
  await call(`/api/sessions/${rest[0]}/notify`, { method: "POST", body: JSON.stringify({ text: rest.slice(1).join(" ") }) });
} else if (verb === "ask" && rest[0]) {
  if (!process.env.MAXFLOW_SESSION) console.error("ask works only inside a maxflow session"), process.exit(1);
  const re = flag(rest, "--re");
  const q = await call("/api/questions", { method: "POST", body: JSON.stringify({ text: positional(rest, ["--re"]).join(" "), re: re ? Number(re.replace(/^q/, "")) : undefined }) });
  console.log(`q${q.id} ${q.thread.length > 1 ? "updated" : "queued"} (${q.status}). Keep working; the answer arrives in your prompt.`);
} else if (verb === "questions") {
  for (const q of await call("/api/questions"))
    if (rest.includes("--all") || q.status === "gating" || q.status === "pending")
      console.log(`q${q.id}  ${q.status.padEnd(9)}  ${q.name} (${q.session})\n${q.thread.map((m: { from: string; text: string }) => `  ${m.from}: ${m.text}`).join("\n")}\n`);
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
  const target = await slack.parseTarget(positional(rest.slice(1), ["--session"]).join(" "));
  if (!target) console.error(`no channel named ${rest[1]}`), process.exit(1);
  const session = flag(rest, "--session") ?? process.env.MAXFLOW_SESSION;
  const prev = slack.readWatches().find((w) => w.target === target)?.sessions ?? [];
  const watches = slack.readWatches().filter((w) => w.target !== target);
  if (rest[0] === "watch") watches.push({ target, sessions: [...new Set([...prev, ...(session ? [session] : [])])] });
  slack.writeWatches(watches);
  console.log(`${rest[0] === "watch" ? "watching" : "unwatched"} ${target}${rest[0] === "watch" && session ? ` for session ${session}` : ""}`);
} else {
  console.log(usage);
  process.exit(1);
}
