import { inboxesTable } from "./state";
import { publish } from "./bus";
import { CLI } from "./instance";
import { paste, pressEnter, setOption, tmux, tmuxAsync, tmuxName } from "./tmux";
import { type ClaudeState, isAgent, sessions } from "./sessions";
import { intro } from "./intro";
import { dispatch, endWait, screen, setArchived, waitsOn, wake } from "./lifecycle";
import { declareWait, sayWhyInThreadsHeWaitsIn, untilShell } from "./waits";
import { claudeStateChanged } from "./turns";
import { SENTRY_USES, describe } from "./world";
import { requested } from "./routing";
import { touchFrom } from "./sentry-files";
import { stamp } from "./stamp";
import { setTranscript } from "./transcripts";

export async function sessionRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  const act = path.match(/^\/api\/sessions\/([\w-]+)\/(input|screen|wait|notify|state|intro|await|wake|peer)$/);
  if (act) {
    const s = sessions.get(act[1]);
    if (!s) return new Response("no such session", { status: 404 });
    if (act[2] === "intro" && req.method === "GET") return new Response(intro(s, SENTRY_USES));
    const t = tmuxName(s.id);
    const touch = (kind: "read" | "write", held = false) => touchFrom(req, s, kind, held);
    if (act[2] === "input" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { text?: string; keys?: string[]; enter?: boolean; isaac?: boolean };
      if (s.exitCode !== null) return new Response("session ended", { status: 409 });
      // A shell gets its text as is; an agent is told who typed it.
      const typed: ReturnType<typeof stamp> | { text?: string; request?: undefined } = body.text && isAgent(s) ? stamp(req, body.text, body.isaac) : { text: body.text };
      if ("error" in typed) return new Response(typed.error, { status: 409 });
      if (typed.request) requested(s, typed.request);
      // A session or sentry sending an agent text to submit goes through its inbox like notify: typed only at an idle prompt, and
      // delivered only once claude has it as a prompt. Typed from a plain shell, or left unsubmitted, it goes straight in.
      const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      const queued = !!typed.text && isAgent(s) && !!body.enter && (!!from || !!body.isaac);
      if (typed.text && isAgent(s)) dispatch({ from, source: body.isaac ? "isaac" : undefined, to: [s], text: body.text!, ...(queued ? { deliver: typed.text } : { typed: true }) });
      touch("write");
      if (typed.text && !queued) await paste(t, typed.text);
      if (body.keys?.length) await tmuxAsync("send-keys", "-t", t, ...body.keys);
      // A TUI like claude reads text + Enter in one burst as a paste, so the submit goes separately.
      if (body.enter && !queued) await Bun.sleep(body.text ? 150 : 0), await pressEnter(t);
      return Response.json(describe(s));
    }
    // Typed by the user into an asleep agent's pane: his own words, delivered once its claude is back.
    if (act[2] === "wake" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      if (!body.text?.trim()) return new Response("text required", { status: 400 });
      if (s.exitCode !== null) return new Response("session ended", { status: 409 });
      dispatch({ source: "isaac", to: [s], text: body.text.trim() });
      return Response.json(describe(s));
    }
    // An agent's native SendMessage, reported by its PreToolUse hook: logged like any message. Awake, the native send goes
    // through; asleep, it has no claude to land in, so it is queued here instead, which wakes it.
    if (act[2] === "peer" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      if (!body.text?.trim() || !from) return new Response("text and a calling session required", { status: 400 });
      const asleep = !!(s.archived || s.asleep) && s.exitCode === null;
      const stamped = stamp(req, body.text.trim());
      dispatch({ from, to: [s], text: body.text.trim(), deliver: "error" in stamped ? body.text.trim() : stamped.text, typed: !asleep });
      if (waitsOn(s, from.id)) endWait(s);
      touch("write");
      return Response.json({ queued: asleep });
    }
    if (act[2] === "notify" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { text?: string; isaac?: boolean };
      if (!body.text?.trim()) return new Response("text required", { status: 400 });
      const stamped = stamp(req, body.text.trim(), body.isaac);
      if ("error" in stamped) return new Response(stamped.error, { status: 409 });
      if (stamped.request) requested(s, stamped.request);
      const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
      dispatch({ from, source: body.isaac ? "isaac" : undefined, to: [s], text: body.text.trim(), deliver: stamped.text });
      // The awaited agent's message ends the wait on it.
      if (waitsOn(s, req.headers.get("x-maxflow-from"))) endWait(s);
      touch("write");
      return Response.json(describe(s), { status: 202 });
    }
    if (act[2] === "state" && req.method === "POST") {
      const { state, transcript } = (await req.json().catch(() => ({}))) as { state?: string; transcript?: string };
      if (!["working", "waiting", "idle", "gone"].includes(state ?? "")) return new Response("state must be working, waiting, idle or gone", { status: 400 });
      if (transcript) setTranscript(s, transcript);
      claudeStateChanged(s, state as ClaudeState | "gone");
      return Response.json(describe(s));
    }
    if (act[2] === "await" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { kind?: string; ref?: string; why?: string } & Parameters<typeof untilShell>[1];
      const unsaid = sayWhyInThreadsHeWaitsIn(s, body.kind ?? "", body.why?.trim());
      if (unsaid !== null) return new Response(unsaid, { status: 409 });
      // until starts (or finds) the shell first, and waits on it by its id.
      const shell = body.kind === "until" && !body.ref ? untilShell(s, body) : undefined;
      if (typeof shell === "string") return new Response(shell, { status: 409 });
      const err = declareWait(s, body.kind ?? "", shell?.id ?? body.ref?.trim() ?? "", body.desc?.trim());
      return err ? new Response(err, { status: 409 }) : Response.json(describe(s));
    }
    if (act[2] === "screen" && req.method === "GET") return touch("read"), Response.json({ ...describe(s), screen: screen(s, Number(url.searchParams.get("history") ?? 0)) });
    if (act[2] === "wait" && req.method === "GET") {
      const idle = Number(url.searchParams.get("idle") ?? 1500);
      const timeout = Number(url.searchParams.get("timeout") ?? 120_000);
      const match = url.searchParams.get("match");
      const re = match ? new RegExp(match, "m") : null;
      const start = Date.now();
      touch("read", true);
      for (;;) {
        const text = screen(s, 0);
        const reason = s.exitCode !== null ? "exited" : re ? (re.test(text) ? "match" : null) : Date.now() - Math.max(s.lastOutputAt, start) >= idle ? "idle" : null;
        if (reason || Date.now() - start >= timeout) return touch("read"), Response.json({ ...describe(s), reason: reason ?? "timeout", screen: text });
        await Bun.sleep(200);
      }
    }
    return new Response("method not allowed", { status: 405 });
  }

  const one = path.match(/^\/api\/sessions\/([\w-]+)$/);
  if (one) {
    const s = sessions.get(one[1]);
    if (!s) return new Response("no such session", { status: 404 });
    if (req.method === "DELETE") {
      publish(`session/${s.id}/killed`, { session: s.id, name: s.name });
      sessions.delete(s.id);
      inboxesTable.delete(s.id);
      tmux("kill-session", "-t", tmuxName(s.id));
      s.proc.kill();
      for (const ws of s.clients) ws.close();
      return new Response(null, { status: 204 });
    }
    if (req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { name?: string; archived?: boolean };
      // Archiving is the user's, from the browser; an agent that finishes runs `wait done` and stays awake.
      if (body.archived === true && !req.headers.get("user-agent")?.includes("Mozilla"))
        return new Response(`agents don't archive themselves: run \`${CLI} wait done\` (or wait <kind>:<ref>) and end your turn`, { status: 403 });
      if (typeof body.archived === "boolean") {
        setArchived(s, body.archived);
        // Unarchived by hand, a sleeping agent is awake until its next turn ends; only the awaited event ends its wait.
        if (!body.archived) wake(s);
      }
      if (body.name?.trim()) {
        touchFrom(req, s, "write");
        s.name = body.name.trim().slice(0, 80);
        setOption(s.id, "@mf", JSON.stringify({ name: s.name, cmd: s.cmd, cwd: s.cwd, chatId: s.chatId, createdAt: s.createdAt }));
      }
    }
    return Response.json(describe(s));
  }
  return undefined;
}
