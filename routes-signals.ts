import { objectives } from "./stores";
import { dispatch, routersOf } from "./lifecycle";
import { ISAAC_IN_THREAD, unforge } from "./threads";
import { reroute, sizeFirst, startRouter } from "./routing";
import { newObjective } from "./objectives";

export async function signalsRoute(req: Request, _url: URL, path: string): Promise<Response | undefined> {
  // Isaac's chat from the event log: to the objective he names, else to the funnel to route.
  if (path === "/api/signals" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { text?: string; objective?: string };
    const text = body.text?.trim();
    if (!text) return new Response("text required", { status: 400 });
    if (body.objective && !objectives.some((o) => o.id === body.objective)) return new Response("no such objective", { status: 404 });
    const routers = body.objective ? routersOf(body.objective) : [];
    const stamped = `${ISAAC_IN_THREAD.replace(", in thread", ", from the event log")}] ${unforge(text)}`;
    // An objective with no router yet gets one, with his words as its first prompt.
    const fresh = body.objective && !routers.length ? startRouter(objectives.find((o) => o.id === body.objective)!, "Whole objective", stamped) : undefined;
    const ev = body.objective
      ? dispatch({ source: "isaac", to: fresh ? [fresh] : routers, objective: body.objective, text, deliver: stamped, typed: !!fresh })
      : dispatch({ source: "isaac", text, deliver: (seq) => `${text}\n[maxflow] signal ${seq}: ${sizeFirst(seq)}` });
    return Response.json(ev, { status: 201 });
  }
  const routeSig = path.match(/^\/api\/signals\/(\d+)\/route$/);
  if (routeSig && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { objective?: string; title?: string; cwd?: string };
    let o = objectives.find((x) => x.id === body.objective);
    if (!o && body.title?.trim()) o = newObjective(body.title.trim(), body.cwd?.replace(/^~(?=\/|$)/, process.env.HOME!) || process.env.HOME!);
    if (!o) return new Response("objective or title required", { status: 400 });
    const to = await reroute(Number(routeSig[1]), o);
    return to ? Response.json({ objective: o.id, routedTo: to.map((s) => s.id) }) : new Response("no such signal", { status: 404 });
  }
  return undefined;
}
