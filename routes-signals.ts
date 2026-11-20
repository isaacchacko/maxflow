import { homedir } from "node:os";
import type { Objective } from "./model";
import { objectives, threads } from "./stores";
import { ROUTERS_RETIRED, areOwnersOn } from "./owners";
import { dispatch, live_thread, routersOf } from "./lifecycle";
import { ISAAC_IN_THREAD, unforge } from "./threads";
import { reroute, sizeFirst, startRouter, toThreadOwner } from "./routing";
import { newObjective } from "./objectives";
import { isFilled } from "./shared/guards";
import { type Route, exactly, expandHome, firstAnswer, jsonBody, matching, textOf } from "./route-kit";

function toItsRoutersOrAFreshOneWithHisWordsAsItsFirstPrompt(o: Objective, text: string, stamped: string) {
  const routers = routersOf(o.id);
  const fresh = routers.length === 0 ? startRouter(o, "Whole objective", stamped) : undefined;
  return dispatch({ source: "isaac", to: fresh ? [fresh] : routers, objective: o.id, text, deliver: stamped, typed: fresh !== undefined });
}

async function isaacsChatFromTheEventLogToHisObjectiveOrTheFunnel(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const text = textOf(body, "text")?.trim() ?? "";
  if (text === "") return new Response("text required", { status: 400 });
  const named = textOf(body, "objective");
  const objective = isFilled(named) ? objectives.find((o) => o.id === named) : undefined;
  if (!objective && isFilled(named)) return new Response("no such objective", { status: 404 });
  const stamped = `${ISAAC_IN_THREAD.replace(", in thread", ", from the event log")}] ${unforge(text)}`;
  const ev = objective
    ? toItsRoutersOrAFreshOneWithHisWordsAsItsFirstPrompt(objective, text, stamped)
    : dispatch({ source: "isaac", text, deliver: (seq) => `${text}\n[yarn] signal ${seq}: ${sizeFirst(seq)}` });
  return Response.json(ev, { status: 201 });
}

async function toTheThreadsOwner(seq: number, id: string): Promise<Response> {
  const target = live_thread(threads.find((t) => t.id === id));
  if (!target) return new Response(`no open thread ${id}`, { status: 404 });
  const to = await toThreadOwner(seq, target);
  if (to === null) return new Response("no such signal", { status: 404 });
  if (to.length === 0) return new Response(`${id} has no live owner: start a fresh one with \`size ${String(seq)} owner\``, { status: 409 });
  return Response.json({ thread: target.id, routedTo: to.map((s) => s.id) });
}

async function routeSignal(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const body = await jsonBody(req);
  const thread = textOf(body, "thread");
  if (isFilled(thread)) return toTheThreadsOwner(Number(match[1]), thread);
  if (areOwnersOn()) return new Response(ROUTERS_RETIRED, { status: 409 });
  const title = textOf(body, "title")?.trim() ?? "";
  const cwd = expandHome(textOf(body, "cwd") ?? "");
  const o = objectives.find((x) => x.id === body["objective"]) ?? (title === "" ? undefined : newObjective(title, isFilled(cwd) ? cwd : homedir()));
  if (!o) return new Response("objective or title required", { status: 400 });
  const to = await reroute(Number(match[1]), o);
  return to ? Response.json({ objective: o.id, routedTo: to.map((s) => s.id) }) : new Response("no such signal", { status: 404 });
}

const ROUTES: Route[] = [exactly("POST", "/api/signals", isaacsChatFromTheEventLogToHisObjectiveOrTheFunnel), matching(/^\/api\/signals\/(\d+)\/route$/, routeSignal)];

export async function signalsRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
