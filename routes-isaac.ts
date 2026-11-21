import { enroll, loginOptions, mayEnroll, registrationOptions, signIn, status } from "./isaac-auth";
import { callerOf } from "./shared/legacy-maxflow";
import { type Route, exactly, firstAnswer, jsonBody, textOf } from "./route-kit";

const notForAgents = () => new Response("an agent can't sign in as Isaac", { status: 403 });

async function enrollOptions(req: Request) {
  if (!mayEnroll(req)) return new Response("a passkey is enrolled already: sign in with it, then add another", { status: 403 });
  return Response.json(await registrationOptions());
}

async function enrollVerify(req: Request) {
  if (!mayEnroll(req)) return new Response("a passkey is enrolled already: sign in with it, then add another", { status: 403 });
  const body = await jsonBody(req);
  const done = await enroll(body["response"], textOf(body, "label") ?? "a browser");
  return "error" in done ? new Response(done.error, { status: 400 }) : Response.json({ enrolled: true, token: done.token });
}

async function signInOptions(req: Request) {
  return callerOf(req) === "" ? Response.json(await loginOptions()) : notForAgents();
}

async function signInVerify(req: Request) {
  if (callerOf(req) !== "") return notForAgents();
  const done = await signIn(req, (await jsonBody(req))["response"]);
  return "error" in done ? new Response(done.error, { status: 400 }) : Response.json({ signedIn: true, ...done });
}

const ROUTES: Route[] = [
  exactly("GET", "/api/isaac", (req) => Response.json(status(req))),
  exactly("POST", "/api/isaac/enroll/options", enrollOptions),
  exactly("POST", "/api/isaac/enroll", enrollVerify),
  exactly("POST", "/api/isaac/sign-in/options", signInOptions),
  exactly("POST", "/api/isaac/sign-in", signInVerify),
];

export const isaacRoute = async (req: Request, url: URL, path: string) => firstAnswer(ROUTES, req, url, path);
