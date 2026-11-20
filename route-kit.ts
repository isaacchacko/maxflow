import { homedir } from "node:os";
import { sessions } from "./sessions";
import { isRecord } from "./shared/guards";

export type Body = Record<string, unknown>;
export type Route = (req: Request, url: URL, path: string) => Promise<Response | undefined>;

type Answer = (req: Request, url: URL) => Promise<Response | undefined> | Response | undefined;
type MatchedAnswer = (req: Request, url: URL, match: RegExpExecArray) => Promise<Response | undefined> | Response | undefined;

export const exactly =
  (method: string, path: string, answer: Answer): Route =>
  async (req, url, asked) =>
    asked === path && req.method === method ? answer(req, url) : undefined;

export const matching =
  (pattern: RegExp, answer: MatchedAnswer): Route =>
  async (req, url, path) => {
    const match = pattern.exec(path);
    return match ? answer(req, url, match) : undefined;
  };

export async function firstAnswer(routes: readonly Route[], req: Request, url: URL, path: string): Promise<Response | undefined> {
  for (const route of routes) {
    const answer = await route(req, url, path);
    if (answer !== undefined) return answer;
  }
  return undefined;
}

export async function parsedOr(req: Request, fallback: unknown): Promise<unknown> {
  try {
    const body: unknown = await req.json();
    return body;
  } catch {
    return fallback;
  }
}

export async function jsonBody(req: Request): Promise<Body> {
  const body = await parsedOr(req, {});
  return isRecord(body) ? body : {};
}

export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export function textOf(body: Body, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

export function flagOf(body: Body, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

export function textsOf(body: Body, key: string): string[] | undefined {
  const value = body[key];
  return isStringList(value) ? value : undefined;
}

export const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, () => homedir());

export const sender = (req: Request) => sessions.get(req.headers.get("x-maxflow-from") ?? "");

export const isFromTheBrowser = (req: Request) => req.headers.get("user-agent")?.includes("Mozilla") === true;

// constraint: an agent's request carries x-maxflow-from, and only a page the server served sends same-origin; Isaac-only actions (merging a PR) check both
export const isIsaacsBrowser = (req: Request) => (req.headers.get("x-maxflow-from") ?? "") === "" && req.headers.get("sec-fetch-site") === "same-origin";
