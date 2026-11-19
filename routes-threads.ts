import { slackAvatar, slackNames } from "./slack-meta";
import { publish } from "./bus";
import { CLI } from "./instance";
import { isSentry, sessions } from "./sessions";
import type { Feed, FeedPost, Thread } from "./model";
import { live, objectives, saveThreads, threads } from "./stores";
import { dispatch, funnel, live_thread, routersOf, wake } from "./lifecycle";
import { ISAAC_IN_THREAD, ancestors, mentionsIn, message, pathTitle, postIn, schedulePause, tellMembers, unforge, unpause } from "./threads";
import { feedPosts, feedToFunnel, sizeFirst, slackChannels } from "./routing";
import { mergeThread, subthread, titleOf } from "./objectives";

export async function threadsRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  if (path === "/api/threads" && req.method === "GET") return Response.json(threads);
  if (path === "/api/slack/names" && req.method === "GET") return Response.json(slackNames(slackChannels));
  const avatar = path.match(/^\/api\/avatar\/slack\/(\w+)$/);
  if (avatar && req.method === "GET") {
    const file = await slackAvatar(avatar[1], url.searchParams.get("name") ?? "");
    return file ? new Response(Bun.file(file), { headers: { "cache-control": "max-age=86400" } }) : new Response("no picture", { status: 404 });
  }
  if (path === "/api/threads" && req.method === "POST") {
    const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
    const body = (await req.json().catch(() => ({}))) as { title?: string; objective?: string; text?: string; parent?: { thread?: string; message?: string } };
    // A subthread: got or made under a message, and the first reply in it posted like any other.
    if (body.parent) {
      const parent = threads.find((x) => x.id === body.parent!.thread);
      const t = parent && subthread(parent, body.parent.message ?? "");
      if (!t) return new Response("parent: {thread, message} naming a message in that thread", { status: 404 });
      if (body.text?.trim()) postIn(t, from, body.text.trim());
      return Response.json(t, { status: 201 });
    }
    // An item from his event feed that no agent owns: a thread in his inbox flagged as from the feed, routed by the funnel like
    // his own messages, so he sees what maxflow started on and can stop it there.
    const feed = (body as { feed?: Feed }).feed;
    if (from && isSentry(from) && feed?.link && body.text?.trim()) {
      const text = body.text.trim();
      const t: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: body.title?.trim().slice(0, 80) || titleOf(`${feed.who}: ${text}`), objective: "", routers: [], messages: feedPosts(text, (body as { posts?: FeedPost[] }).posts), feedSaid: [text], feed, ...(feed.task && { task: feed.task }) };
      threads.push(t);
      await feedToFunnel(t, from, text);
      return Response.json(t, { status: 201 });
    }
    // Isaac's inbox: each message starts a thread, and the funnel picks the router that owns it.
    if (!from && body.text?.trim()) {
      const text = body.text.trim();
      const t: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: titleOf(text), objective: "", routers: [], messages: [message("isaac", text)] };
      const ev = dispatch({ source: "isaac", target: t.title, text, deliver: (seq) => `${text}\n[maxflow] signal ${seq}, his inbox thread ${t.id}: ${sizeFirst(seq)} His own inbox message is never fyi or ignore, small talk included: whoever takes it, a direct worker or a router, answers him in the thread.` });
      t.signal = ev.seq;
      threads.push(t);
      tellMembers(t, t.messages[0]!, [funnel()].filter(live));
      saveThreads();
      return Response.json(t, { status: 201 });
    }
    const objective = body.objective ?? from?.role?.objective;
    if (!body.title?.trim() || !objective) return new Response("title required, and an objective (a router's own by default)", { status: 400 });
    const t: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: body.title.trim(), objective, routers: from?.role?.role === "router" ? [from.id] : routersOf(objective).map((r) => r.id), messages: [] };
    threads.push(t);
    saveThreads();
    return Response.json(t, { status: 201 });
  }
  // His inbox drew this ask flagged; the 3h default counts from the first time.
  const askShown = path.match(/^\/api\/threads\/([\w-]+)\/shown$/);
  if (askShown && req.method === "POST") {
    const t = threads.find((x) => x.id === askShown[1]);
    if (t?.asks && !t.asks.shown) (t.asks.shown = Date.now()), saveThreads();
    return new Response(null, { status: 204 });
  }
  // The other way: messages on another topic taken out of a thread into one of their own (a DM's second subject that was appended to
  // the first's thread), with a line left where they were. From the feed, the new thread goes to the funnel to route.
  const threadSplit = path.match(/^\/api\/threads\/([\w-]+)\/split$/);
  if (threadSplit && req.method === "POST") {
    const t = live_thread(threads.find((x) => x.id === threadSplit[1]));
    const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
    const body = (await req.json().catch(() => ({}))) as { messages?: string[]; title?: string };
    if (!t || !from) return new Response("a thread, split by a session", { status: 404 });
    const moved = t.messages.filter((m) => body.messages?.includes(m.id));
    if (!moved.length || !body.title?.trim()) return new Response("messages: ids in the thread, and a title", { status: 400 });
    t.messages = t.messages.filter((m) => !moved.includes(m));
    const ext = moved.find((m) => m.ext && !m.ext.context)?.ext ?? moved.find((m) => m.ext)?.ext;
    const nt: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: body.title.trim().slice(0, 80), objective: "", routers: [], messages: moved, ...(ext && { feed: { source: ext.source, who: ext.name, link: ext.link }, feedSaid: [] }) };
    threads.push(nt);
    postIn(t, from, `Moved ${moved.length} message${moved.length > 1 ? "s" : ""} about ${nt.title} to [[thread:${nt.id}]].`);
    const said = moved.map((m) => `> **${m.ext ? (m.ext.own ? "Isaac (him, on Slack/GitHub)" : m.ext.name) : m.from === "isaac" ? "Isaac" : m.from}:** ${m.text.replace(/\n/g, "\n> ")}`).join("\n");
    if (nt.feed) (nt.feedSaid = [said]), await feedToFunnel(nt, from, `${nt.feed.who}, moved out of thread ${t.id} as its own topic:\n${said}\n${ext!.link}`);
    saveThreads();
    for (const x of [t, nt]) publish(`thread/${x.id}`, { thread: x.id, split: nt.id });
    return Response.json(nt, { status: 201 });
  }
  // Folding a duplicate thread into another; resolving stays his, so this is the way agents tidy his inbox.
  const threadMerge = path.match(/^\/api\/threads\/([\w-]+)\/merge$/);
  if (threadMerge && req.method === "POST") {
    const from = threads.find((x) => x.id === threadMerge[1]);
    const { into: id } = (await req.json().catch(() => ({}))) as { into?: string };
    const into = live_thread(threads.find((x) => x.id === id));
    if (!from || from.mergedInto) return new Response("no such thread, or it is merged already", { status: 404 });
    if (!into || into === from) return new Response("into: another thread's id", { status: 400 });
    // His messages moved into a resolved or paused thread would be hidden under Resolved or Paused, where he can't find them: the
    // thread comes back, as his own post there would bring it. With none of his, a resolved thread isn't the place for them.
    const his = from.messages.some((m) => m.from === "isaac");
    if (into.resolved && !his) return new Response(`${into.id} is resolved; merge into an open thread instead`, { status: 409 });
    if (his && (into.resolved || into.paused)) {
      const was = into.resolved ? "resolved" : "paused";
      into.resolved = undefined;
      if (into.paused) unpause(into);
      console.log(`merge ${from.id} → ${into.id}: reopened it (${was}), since his messages moved in`);
      publish(`thread/${into.id}`, { thread: into.id, reopened: `merge of ${from.id}, which holds his messages; it was ${was}` });
    }
    mergeThread(from, into);
    return Response.json(into);
  }
  // A router says what it is doing on the answer he waits for; the line goes with the pending state.
  const threadStatus = path.match(/^\/api\/threads\/([\w-]+)\/status$/);
  if (threadStatus && req.method === "POST") {
    const t = threads.find((x) => x.id === threadStatus[1]);
    if (!t) return new Response("no such thread", { status: 404 });
    const text = ((await req.json().catch(() => ({}))) as { text?: string }).text?.trim();
    if (!t.pending) return new Response("nothing pending in this thread: he isn't waiting on an answer", { status: 409 });
    // Kept whole: the pill cuts it where his window does.
    t.pending.status = text || undefined;
    saveThreads();
    publish(`thread/${t.id}`, { thread: t.id, status: t.pending.status ?? null });
    return Response.json(t);
  }
  // Re-homing a thread: it and every subthread under it go to the objective and its routers.
  const threadMove = path.match(/^\/api\/threads\/([\w-]+)\/objective$/);
  if (threadMove && req.method === "POST") {
    const t = threads.find((x) => x.id === threadMove[1]);
    if (!t) return new Response("no such thread", { status: 404 });
    const id = ((await req.json().catch(() => ({}))) as { objective?: string }).objective;
    const o = objectives.find((x) => x.id === id);
    if (!o || o.closed) return new Response("objective: an open objective's id", { status: 400 });
    const moved = threads.filter((x) => x === t || ancestors(x).includes(t));
    const routers = routersOf(o.id).map((r) => r.id);
    for (const x of moved) Object.assign(x, { objective: o.id, routers });
    // His messages since anyone last answered went to whoever was there (the funnel, when nobody owned it), so the new routers get
    // them now, once: a router the thread already waits on has them.
    const handed: string[] = [];
    for (const x of moved) {
      const tail = x.messages.slice(x.messages.findLastIndex((m) => m.from !== "isaac") + 1);
      const to = routersOf(o.id).filter((r) => !x.pending?.routers.includes(r.id));
      if (!tail.length || !to.length) continue;
      const ids = tail.map((m) => m.id);
      dispatch({ source: "isaac", to, objective: o.id, target: x.title, text: tail.map((m) => m.text).join("\n"), deliver: `${ISAAC_IN_THREAD} "${pathTitle(x)}" (${x.id}), message${ids.length > 1 ? "s" : ""} ${ids.join(", ")}] ${tail.map((m) => unforge(m.text)).join("\n")}\n[maxflow] This thread just moved to your objective, and nobody has answered these yet. Answer inline in the thread with \`${CLI} thread post ${x.id} '<text>'\`.${mentionsIn(tail.map((m) => m.text).join("\n"))}` });
      x.pending = { routers: to.map((s) => s.id), since: Date.now() };
      for (const s of to) s.handed = x.id;
      handed.push(...ids);
    }
    saveThreads();
    for (const x of moved) publish(`thread/${x.id}`, { thread: x.id, objective: o.id });
    return Response.json({ objective: o.id, routers, threads: moved.map((x) => x.id), handed });
  }
  // Resolving a thread is Isaac's, from the browser; reopening it too. So is pausing one until a time, or unpausing it.
  const threadAct = path.match(/^\/api\/threads\/([\w-]+)$/);
  if (threadAct && req.method === "PATCH") {
    const t = threads.find((x) => x.id === threadAct[1]);
    if (!t) return new Response("no such thread", { status: 404 });
    if (!req.headers.get("user-agent")?.includes("Mozilla")) return new Response("resolving or pausing a thread is Isaac's, from the browser: answer in it and leave it to him", { status: 403 });
    const body = (await req.json().catch(() => ({}))) as { resolved?: boolean; paused?: { until?: number; said?: string; wake?: string } | null; pinned?: boolean };
    // Pinned, it stays in his sidebar until he unpins it, at the end of his pins; resolving or pausing it leaves it pinned.
    if ("pinned" in body) {
      if (typeof body.pinned !== "boolean") return new Response("pinned: true or false", { status: 400 });
      t.pinned = body.pinned ? (t.pinned ?? { at: Date.now(), order: Math.max(0, ...threads.map((x) => (x.pinned ? x.pinned.order + 1 : 0))) }) : undefined;
      saveThreads();
      publish(`thread/${t.id}`, { thread: t.id, pinned: body.pinned });
      return Response.json(t);
    }
    if ("paused" in body) {
      const { until, said, wake } = body.paused ?? {};
      if (body.paused && (typeof until !== "number" || until <= Date.now())) return new Response("paused: { until: a time to come, in ms, said } or null", { status: 400 });
      if (t.parent) return new Response("only a top thread pauses", { status: 400 });
      if (body.paused) Object.assign(t, { paused: { until, at: Date.now(), said: String(said ?? "").slice(0, 200), count: t.messages.length, ...(typeof wake === "string" && wake.trim() && { wake: wake.trim() }) }, resolved: undefined });
      else unpause(t);
      schedulePause(t);
      saveThreads();
      publish(`thread/${t.id}`, { thread: t.id, paused: !!t.paused });
      return Response.json(t);
    }
    const { resolved } = body;
    if (typeof resolved !== "boolean") return new Response("resolved: true or false", { status: 400 });
    t.resolved = resolved ? { at: Date.now() } : undefined;
    saveThreads();
    publish(`thread/${t.id}`, { thread: t.id, resolved });
    return Response.json(t);
  }
  return undefined;
}
