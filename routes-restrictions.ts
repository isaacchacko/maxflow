import { invalid, resolve, saveRestrictions, type Restriction } from "./restrictions";
import { didBackfillPeople, link, people as restrictionPeople } from "./restrictions-identities";
import { preview } from "./restrictions-recent";
import { restrictions } from "./threads";
import { restrictionRepos } from "./repos";
import { isFilled } from "./shared/guards";
import { callOf, isModeUnknown, matchOf, refusalInValidationOrder, restrictionDraftOf } from "./restriction-draft";
import { type Route, exactly, firstAnswer, jsonBody, matching, parsedOr, textOf } from "./route-kit";

const firstFilled = (...texts: (string | undefined)[]) => texts.find(isFilled);

function namedAfterWhatItOverridesUnlessNamed(asked: Partial<Restriction>, parent: Restriction | undefined): Partial<Restriction> {
  const label = firstFilled(asked.label?.trim(), parent?.label);
  const action = firstFilled(asked.action?.trim(), parent?.action);
  return { ...asked, ...(label !== undefined && { label }), ...(action !== undefined && { action }), match: asked.match ?? {} };
}

function restrictionFrom(draft: Partial<Restriction>, parent: Restriction | undefined): Restriction {
  const { action = "", label = "", mode = "ask", match = {}, scope, note, reaches, about } = draft;
  return {
    id: crypto.randomUUID().slice(0, 8),
    action,
    label: label.trim(),
    mode,
    match: parent ? {} : match,
    scope,
    ...(parent && { parent: parent.id }),
    ...(note !== undefined && { note }),
    ...(!parent && isFilled(reaches) && { reaches }),
    ...(!parent && isFilled(about) && { about }),
  };
}

async function addRestriction(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const asked = restrictionDraftOf(body);
  const parent = isFilled(asked.parent) ? restrictions.find((r) => r.id === asked.parent) : undefined;
  const draft = namedAfterWhatItOverridesUnlessNamed(asked, parent);
  const bad = refusalInValidationOrder(body, invalid(draft, restrictions));
  if (bad !== undefined) return new Response(bad, { status: 400 });
  const r = restrictionFrom(draft, parent);
  restrictions.push(r);
  saveRestrictions(restrictions);
  return Response.json(r, { status: 201 });
}

async function verdictForAToolCall(req: Request): Promise<Response> {
  const call = callOf(await parsedOr(req, { tool: "" }));
  return Response.json(resolve(restrictions, call));
}

function peopleForAScope() {
  if (didBackfillPeople(restrictions)) saveRestrictions(restrictions);
  return Response.json(restrictionPeople());
}

async function whatTheMatchersWouldHaveCaught(req: Request): Promise<Response> {
  const match = matchOf((await jsonBody(req))["match"]) ?? {};
  const bad = invalid({ label: "x", action: "x", mode: "ask", match });
  return bad === undefined ? Response.json(preview(match)) : new Response(bad, { status: 400 });
}

async function linkOrUnlinkSlackAndGithub(req: Request): Promise<Response | undefined> {
  if (req.method !== "POST" && req.method !== "DELETE") return undefined;
  const body = await jsonBody(req);
  const slack = textOf(body, "slack");
  const github = textOf(body, "github");
  if (!isFilled(slack) || !isFilled(github)) return new Response("slack and github required", { status: 400 });
  link({ slack, github }, req.method === "POST");
  if (didBackfillPeople(restrictions, req.method === "DELETE" ? { slack, github } : undefined)) saveRestrictions(restrictions);
  return Response.json(restrictionPeople());
}

async function editRestriction(req: Request, restriction: Restriction): Promise<Response> {
  const body = await jsonBody(req);
  const { id: _id, builtin: _builtin, parent: _parent, ...edit } = restrictionDraftOf(body);
  const { mode: _mode, ...withoutMode } = restriction;
  const next = { ...(isModeUnknown(body) ? withoutMode : restriction), ...edit };
  const bad = refusalInValidationOrder(body, invalid(next, restrictions));
  if (bad !== undefined) return new Response(bad, { status: 400 });
  Object.assign(restriction, next);
  saveRestrictions(restrictions);
  return Response.json(restriction);
}

function deleteWithItsOverrides(restriction: Restriction): Response {
  restrictions.splice(0, restrictions.length, ...restrictions.filter((r) => r.id !== restriction.id && r.parent !== restriction.id));
  saveRestrictions(restrictions);
  return new Response(null, { status: 204 });
}

async function editOrDeleteRestriction(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "PATCH" && req.method !== "DELETE") return undefined;
  const restriction = restrictions.find((r) => r.id === match[1]);
  if (!restriction) return new Response("no such restriction", { status: 404 });
  return req.method === "PATCH" ? editRestriction(req, restriction) : deleteWithItsOverrides(restriction);
}

const ROUTES: Route[] = [
  exactly("GET", "/api/restrictions", () => Response.json(restrictions)),
  exactly("POST", "/api/restrictions", addRestriction),
  exactly("POST", "/api/restrictions/check", verdictForAToolCall),
  exactly("GET", "/api/restrictions/people", peopleForAScope),
  exactly("POST", "/api/restrictions/preview", whatTheMatchersWouldHaveCaught),
  exactly("GET", "/api/restrictions/repos", () => Response.json(restrictionRepos())),
  matching(/^\/api\/restrictions\/people\/link$/, linkOrUnlinkSlackAndGithub),
  matching(/^\/api\/restrictions\/([\w-]+)$/, editOrDeleteRestriction),
];

export async function restrictionsRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
