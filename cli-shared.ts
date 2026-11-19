import { BASE } from "./instance";
import { isRecord } from "./shared/guards";

export const base = BASE;
const CLI_FETCH_TIMEOUT_MS = 60_000;
export const timeout = () => AbortSignal.timeout(CLI_FETCH_TIMEOUT_MS);
export const mySession = () => process.env["MAXFLOW_SESSION"];
export const isBlank = (value: string | undefined) => value === undefined || value === "";
export const isTruthy: (value: unknown) => boolean = Boolean;

const session = mySession();
export const caller = session === undefined || session === "" ? undefined : { "x-maxflow-from": session };
const callerHeaders = caller && { headers: caller };

export type Verb = { matches: (verb: string | undefined, args: string[]) => boolean; run: (args: string[]) => Promise<void> | void };

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export const argAt = (args: string[], i: number) => args[i] ?? "";
export const hasArg = (args: string[], i: number) => argAt(args, i) !== "";

export function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

export const positional = (args: string[], valued: string[]) => args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));

export async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { ...init, ...callerHeaders });
  if (!res.ok) fail(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export const post = async (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

export type Reply = Record<string, unknown>;
export const replyOf = (value: unknown): Reply => (isRecord(value) ? value : {});
export const str = (reply: Reply, key: string) => String(reply[key]);

export function listOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`expected a list from maxflow, got ${JSON.stringify(value)}`);
  return value;
}

export const replies = (value: unknown) => listOf(value).map(replyOf);
export const listAt = (reply: Reply, key: string) => listOf(reply[key]);
export const localTime = (at: unknown) => new Date(typeof at === "number" || typeof at === "string" ? at : NaN).toLocaleString();

export async function didTouchSentry(sentry: string, kind: "read" | "write") {
  if (!caller) return false;
  try {
    await fetch(`${base}/api/touch`, { method: "POST", headers: caller, body: JSON.stringify({ sentry, kind }), signal: timeout() });
    return true;
  } catch {
    return false;
  }
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const withoutImages = (args: string[]) => args.filter((a, i) => a !== "--image" && args[i - 1] !== "--image");

async function uploadedImage(file: string) {
  const type = IMAGE_TYPES[(file.split(".").at(-1) ?? "").toLowerCase()];
  if (type === undefined || !(await Bun.file(file).exists())) fail(`--image ${file}: no png, jpg, gif or webp file there`);
  const res = await fetch(`${base}/api/uploads`, { method: "POST", headers: { ...caller, "content-type": type }, body: Bun.file(file), signal: timeout() });
  if (!res.ok) fail(`--image ${file}: ${res.status} ${await res.text()}`);
  return `![image](${str(replyOf(await res.json()), "path")})`;
}

export async function withImages(text: string, args: string[]) {
  const shown: string[] = [];
  const files = args.filter((_, i) => args[i - 1] === "--image");
  for (const file of files) shown.push(await uploadedImage(file));
  return [text, ...shown].filter((part) => part !== "").join("\n");
}
