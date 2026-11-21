import { mergeGate, setMergeGate } from "./merge-gate";
import { prRows } from "./prs";
import { type Route, exactly, firstAnswer, flagOf, jsonBody, textOf } from "./route-kit";
import { isaacRefusal } from "./isaac-auth";

const PR_KEY = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

async function mergeAsIsaac(req: Request): Promise<Response> {
  const refused = isaacRefusal(req, "merges", true);
  if (refused) return refused;
  const key = textOf(await jsonBody(req), "pr") ?? "";
  const [, repo = "", n = ""] = PR_KEY.exec(key) ?? [];
  const isListed = prRows().some((r) => r.pr === key && r.ended === null);
  if (repo === "" || !isListed) return new Response("no such open PR", { status: 404 });
  const gh = Bun.spawn(["gh", "pr", "merge", n, "-R", repo, "--squash"], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([gh.exited, new Response(gh.stderr).text()]);
  return code === 0 ? Response.json({ merged: key }) : new Response(err.trim() || `gh exited ${code}`, { status: 409 });
}

async function flipTheGate(req: Request): Promise<Response> {
  const refused = isaacRefusal(req, "flips the merge gate", true);
  if (refused) return refused;
  const on = flagOf(await jsonBody(req), "on");
  return on === undefined ? new Response("on: true or false", { status: 400 }) : Response.json(setMergeGate(on));
}

const ROUTES: Route[] = [
  exactly("GET", "/api/prs", () => Response.json(prRows())),
  exactly("POST", "/api/prs/merge", mergeAsIsaac),
  exactly("GET", "/api/merge-gate", () => Response.json(mergeGate())),
  exactly("POST", "/api/merge-gate", flipTheGate),
];

export async function prsRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
