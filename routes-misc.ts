import { latestSeq, publish, query } from "./bus";
import { findChat, listChats } from "./chats";
import { CLI } from "./instance";
import { enforce } from "./restrictions-enforce";
import { Person } from "./restrictions";
import { isSentry, sessions } from "./sessions";
import { Block, FeedPost } from "./model";
import { names, saveThreads, threads } from "./stores";
import { createSession, live_thread } from "./lifecycle";
import { ask, enforcing, postIn } from "./threads";
import { describe } from "./world";
import { externalSignal, feedMore } from "./routing";
import { pointsAtItself, relayRefusal } from "./objectives";
import { onEvent } from "./events";
import { reviewBoard, reviewQueue, touchFrom } from "./sentry-files";
import { favicons, fetchFavicon } from "./favicons";
import { SENTRIES, restartSentry } from "./sentry-commands";
import { pageOf } from "./pages";

export async function miscRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  // The order of his pinned threads, as he dragged them in the sidebar: the ids, first to last.
  if (path === "/api/pins" && req.method === "PATCH") {
    if (!req.headers.get("user-agent")?.includes("Mozilla")) return new Response("pins are Isaac's, from the browser", { status: 403 });
    const { order } = (await req.json().catch(() => ({}))) as { order?: string[] };
    if (!Array.isArray(order)) return new Response("order: the pinned thread ids, first to last", { status: 400 });
    order.forEach((id, i) => {
      const t = threads.find((x) => x.id === id);
      if (t?.pinned) t.pinned.order = i;
    });
    saveThreads();
    publish("pins", { order });
    return new Response(null, { status: 204 });
  }
  const threadPost = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
  if (threadPost && req.method === "POST") {
    const t = live_thread(threads.find((x) => x.id === threadPost[1]));
    if (!t) return new Response("no such thread", { status: 404 });
    // done: from `thread done`, which commands used; it is a plain post now.
    const body = (await req.json().catch(() => ({}))) as { text?: string; nudge?: string; feed?: boolean; posts?: FeedPost[] };
    const text = body.text?.trim();
    if (!text) return new Response("text required", { status: 400 });
    const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
    if (body.feed && from && isSentry(from)) return await feedMore(t, from, text, body.posts), Response.json(t, { status: 201 });
    if (from && pointsAtItself(text, t))
      return new Response(`${threadPost[1] !== t.id ? `${threadPost[1]} was merged into ${t.id}, so this would land in ${t.id}` : `This is ${t.id}`}, and a pointer to it there points at itself. Post only what is new for him, or nothing.`, { status: 409 });
    const relay = from === undefined ? undefined : relayRefusal(t, from, text);
    if (relay !== undefined) return new Response(relay, { status: 409 });
    postIn(t, from, text, body.nudge === "subthread" ? "subthread" : undefined);
    return Response.json(t, { status: 201 });
  }

  // An agent edits a card on an objective's or a task's page.
  if (path === "/api/pages" && (req.method === "POST" || req.method === "DELETE")) {
    const body = (await req.json().catch(() => ({}))) as { ref?: string; block?: Block; id?: string };
    const p = pageOf(body.ref ?? "");
    if (!p) return new Response("ref must be objective/<id> or task/<id>", { status: 404 });
    if (req.method === "DELETE") p.page.splice(0, p.page.length, ...p.page.filter((b) => b.id !== body.id));
    else {
      const b = body.block;
      if (!b?.id || !b.kind || !b.w || !b.h) return new Response("block needs id, kind, w and h", { status: 400 });
      const i = p.page.findIndex((x) => x.id === b.id);
      if (i >= 0) p.page[i] = b;
      else p.page.push(b);
    }
    p.save();
    publish(`page/${body.ref}`, { ref: body.ref, block: body.block?.id ?? body.id });
    return Response.json(p.page);
  }

  if (path === "/api/chats" && req.method === "GET") {
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const open = new Map([...sessions.values()].filter((s) => s.chatId && s.exitCode === null).map((s) => [s.chatId!, s.id]));
    const chats = (await listChats())
      .filter((c) => !q || `${c.title} ${c.prompt} ${c.cwd} ${c.id}`.toLowerCase().includes(q))
      .slice(0, limit)
      .map((c) => ({ ...c, session: open.get(c.id) ?? null }));
    return Response.json(chats);
  }

  const resume = path.match(/^\/api\/chats\/([0-9a-f-]{36})\/resume$/);
  if (resume && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { bypass?: boolean; force?: boolean };
    const open = [...sessions.values()].find((s) => s.chatId === resume[1] && s.exitCode === null);
    if (open) return Response.json(describe(open));
    const chat = await findChat(resume[1]);
    if (!chat) return new Response("no such chat", { status: 404 });
    if (chat.live && !body.force) return Response.json({ error: "live", chat }, { status: 409 });
    const cmd = ["claude", "--resume", chat.id, ...(body.bypass ? ["--permission-mode", "bypassPermissions"] : [])];
    return Response.json(describe(createSession(chat.title.slice(0, 40), cmd, chat.cwd, chat.id)), { status: 201 });
  }

  if (path === "/api/sentries/restart" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { name?: string; fresh?: boolean };
    const s = [...sessions.values()].find((o) => o.sentry && o.name === body.name && o.exitCode === null);
    if (!s || !(s.name in SENTRIES)) return new Response(`no running sentry ${body.name}`, { status: 404 });
    const r = restartSentry(s, !!body.fresh);
    return r.ok ? Response.json(r) : new Response(`respawning ${s.name} failed; see the log`, { status: 500 });
  }
  if (path === "/api/events" && req.method === "GET") {
    const p = url.searchParams;
    const after = p.get("after") === "now" ? latestSeq() : Number(p.get("after") ?? 0);
    const events = await query(p.get("topic") ?? "**", after, Math.min(Number(p.get("wait") ?? 0), 3_600_000));
    return Response.json(events, { headers: { "x-maxflow-seq": String(after) } });
  }
  if (path === "/api/events" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { topic?: string; data?: unknown };
    if (!body.topic) return new Response("topic required", { status: 400 });
    const ev = publish(body.topic, body.data ?? null);
    onEvent(body.topic, body.data, sessions.get(req.headers.get("x-maxflow-from") ?? ""));
    externalSignal(ev);
    return Response.json(ev, { status: 201 });
  }

  if (path === "/api/favicon" && req.method === "GET") {
    const host = url.searchParams.get("host") ?? "";
    if (!/^[\w.-]+(:\d+)?$/.test(host)) return new Response("bad host", { status: 400 });
    if (!favicons.has(host)) favicons.set(host, fetchFavicon(host));
    return (await favicons.get(host))?.clone() ?? new Response("no favicon", { status: 404 });
  }

  if (path === "/api/review" && req.method === "GET") return Response.json({ board: reviewBoard(), queue: reviewQueue() });

  // An agent using a sentry through the CLI (gh status, slack read, ...), drawn in the graph as it touching that sentry.
  if (path === "/api/touch" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { sentry?: string; kind?: "read" | "write" };
    const to = [...sessions.values()].find((o) => isSentry(o) && o.name === `sentry:${body.sentry}` && o.exitCode === null);
    if (to) touchFrom(req, to, body.kind === "write" ? "write" : "read");
    return new Response(null, { status: 204 });
  }
  // The restrictions hook, on a call a restriction that asks or blocks matches: the verdict, with the session's objective.
  if (path === "/api/restrictions/enforce" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { tool?: string; input?: Record<string, unknown>; cwd?: string; people?: Person[] };
    const s = sessions.get(req.headers.get("x-maxflow-from") ?? "");
    if (!s || !body.tool) return Response.json({ decision: "allow" });
    return Response.json(enforce({ session: s.id, tool: body.tool, input: body.input, cwd: body.cwd, people: body.people, objective: s.role?.objective }, enforcing));
  }
  // `maxflow ask`: an agent's question to the user opens a thread from it, flagged as waiting on him.
  if (path === "/api/asks" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { text?: string; re?: string; default?: string; new?: boolean };
    const s = sessions.get(req.headers.get("x-maxflow-from") ?? "");
    if (!s) return new Response("ask from inside a maxflow session ($MAXFLOW_SESSION)", { status: 400 });
    if (!body.text?.trim()) return new Response("text required", { status: 400 });
    const t = ask(s, body.text.trim(), body.re?.trim() || undefined, body.default?.trim() || undefined, body.new);
    if (t && "same" in t) {
      const by = t.same.asks!.session;
      return new Response(`${t.same.id} already asks him something close, from ${sessions.get(by)?.name ?? names[by] ?? by}: "${t.same.title}". If it's the same ask, add to it with \`${CLI} ask --re ${t.same.id} '<text>'\` and wait on thread:${t.same.id}; if it really is different, ask again with --new.`, { status: 409 });
    }
    return t ? Response.json(t, { status: 201 }) : new Response(`no thread ${body.re}`, { status: 404 });
  }
  return undefined;
}
