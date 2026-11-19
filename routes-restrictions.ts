import { invalid, resolve, saveRestrictions, type Restriction } from "./restrictions";
import { backfill, link, people as restrictionPeople } from "./restrictions-identities";
import { preview } from "./restrictions-recent";
import { restrictions } from "./threads";
import { restrictionRepos } from "./repos";

export async function restrictionsRoute(req: Request, _url: URL, path: string): Promise<Response | undefined> {
  if (path === "/api/restrictions" && req.method === "GET") return Response.json(restrictions);
  if (path === "/api/restrictions" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Partial<Restriction>;
    // An override is named after what it overrides unless he names it.
    const parent = body.parent ? restrictions.find((r) => r.id === body.parent) : undefined;
    const draft = { ...body, label: body.label?.trim() || parent?.label, action: body.action?.trim() || parent?.action, match: body.match ?? {} };
    const bad = invalid(draft, restrictions);
    if (bad) return new Response(bad, { status: 400 });
    const r: Restriction = { id: crypto.randomUUID().slice(0, 8), action: draft.action!, label: draft.label!.trim(), mode: draft.mode!, match: parent ? {} : draft.match, scope: draft.scope, parent: parent?.id, note: draft.note, ...(!parent && draft.reaches && { reaches: draft.reaches }), ...(!parent && draft.about && { about: draft.about }) };
    restrictions.push(r), saveRestrictions(restrictions);
    return Response.json(r, { status: 201 });
  }
  // The mode that applies to a tool call, for `maxflow restrictions check`.
  if (path === "/api/restrictions/check" && req.method === "POST") return Response.json(resolve(restrictions, await req.json().catch(() => ({ tool: "" }))));
  // The people the page offers for a restriction's scope, one a human (restrictions-identities.ts): everyone the slack sentry
  // has heard from, joined to their GitHub login from the PRs the gh sentry polls. Email addresses he types. A listing also
  // gives restrictions naming one account of a linked person the other.
  if (path === "/api/restrictions/people" && req.method === "GET") {
    if (backfill(restrictions)) saveRestrictions(restrictions);
    return Response.json(restrictionPeople());
  }
  // What a custom rule's matchers would have caught among the tool calls agents made lately (restrictions-recent.ts).
  if (path === "/api/restrictions/preview" && req.method === "POST") {
    const { match } = (await req.json().catch(() => ({}))) as { match?: Restriction["match"] };
    const bad = invalid({ label: "x", action: "x", mode: "ask", match: match ?? {} });
    return bad ? new Response(bad, { status: 400 }) : Response.json(preview(match!));
  }
  // The repositories his agents work in, for an exception that holds inside one: each live session's folder, as its git root.
  if (path === "/api/restrictions/repos" && req.method === "GET") return Response.json(restrictionRepos());
  // He links a Slack user to a GitHub login, or unlinks a pair yarn matched or he linked.
  if (path === "/api/restrictions/people/link" && (req.method === "POST" || req.method === "DELETE")) {
    const pair = (await req.json().catch(() => ({}))) as { slack?: string; github?: string };
    if (!pair.slack || !pair.github) return new Response("slack and github required", { status: 400 });
    link({ slack: pair.slack, github: pair.github }, req.method === "POST");
    if (backfill(restrictions, req.method === "DELETE" ? { slack: pair.slack, github: pair.github } : undefined)) saveRestrictions(restrictions);
    return Response.json(restrictionPeople());
  }
  const restrictionPath = path.match(/^\/api\/restrictions\/([\w-]+)$/);
  const restriction = restrictionPath && restrictions.find((r) => r.id === restrictionPath[1]);
  if (restrictionPath && !restriction && (req.method === "PATCH" || req.method === "DELETE")) return new Response("no such restriction", { status: 404 });
  if (restriction && req.method === "PATCH") {
    const edit = (await req.json().catch(() => ({}))) as Partial<Restriction>;
    const next = { ...restriction, ...edit, id: restriction.id, builtin: restriction.builtin, parent: restriction.parent };
    const bad = invalid(next, restrictions);
    if (bad) return new Response(bad, { status: 400 });
    Object.assign(restriction, next), saveRestrictions(restrictions);
    return Response.json(restriction);
  }
  // Its overrides go with it.
  if (restriction && req.method === "DELETE") {
    restrictions.splice(0, restrictions.length, ...restrictions.filter((r) => r.id !== restriction.id && r.parent !== restriction.id));
    return saveRestrictions(restrictions), new Response(null, { status: 204 });
  }
  return undefined;
}
