import { createGraph, deleteGraph, isGraphId, listGraphs, readGraph, saveGraph } from "./agent-graphs";
import { type Route, exactly, firstAnswer, jsonBody, matching, parsedOr, textOf } from "./route-kit";

const ONE = /^\/api\/graphs\/([^/]+)$/;
const notFound = () => new Response("no such graph", { status: 404 });

async function one(req: Request, id: string) {
  if (!isGraphId(id)) return notFound();
  if (req.method === "GET") return readGraph(id) ? Response.json(readGraph(id)) : notFound();
  if (req.method === "DELETE") return deleteGraph(id) ? new Response(null, { status: 204 }) : notFound();
  if (req.method !== "PUT") return undefined;
  if (!readGraph(id)) return notFound();
  const saved = saveGraph(id, await parsedOr(req, null));
  return typeof saved === "string" ? new Response(saved, { status: 400 }) : Response.json(saved);
}

const ROUTES: Route[] = [
  exactly("GET", "/api/graphs", () => Response.json(listGraphs())),
  exactly("POST", "/api/graphs", async req => Response.json(createGraph(textOf(await jsonBody(req), "name")?.trim() || "Untitled graph"))),
  matching(ONE, async (req, _url, match) => one(req, match[1] ?? "")),
];

export async function graphsRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
