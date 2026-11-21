import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { createStore } from "@/store";

const TOKEN_KEY = "yarn-isaac-token";
const TOKEN_HEADER = "x-yarn-isaac-token";
const NEEDS_HEADER = "x-yarn-isaac";

export type IsaacStatus = { enrolled: { label: string; at: number }[]; signedIn: boolean; fresh: boolean };
export const isaacStore = createStore<IsaacStatus | undefined>(undefined);

const original = globalThis.fetch.bind(globalThis);

export function storedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeToken(token: unknown) {
  if (typeof token !== "string" || token === "") return;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // constraint: storage throws in a private window; he then signs in again on each reload
  }
}

const isOwnOrigin = (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : String(input), location.href).origin === location.origin;

function withToken(input: RequestInfo | URL, init: RequestInit | undefined): RequestInit | undefined {
  const token = storedToken();
  if (token === "" || !isOwnOrigin(input)) return init;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(TOKEN_HEADER, token);
  return { ...init, headers };
}

async function postJson(path: string, body: unknown = {}) {
  const res = await original(path, { method: "POST", headers: { "content-type": "application/json", [TOKEN_HEADER]: storedToken() }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as Record<string, unknown>;
}

export async function refreshIsaac() {
  const res = await original("/api/isaac", { headers: { [TOKEN_HEADER]: storedToken() } });
  if (res.ok) isaacStore.set((await res.json()) as IsaacStatus);
}

export async function signInAsIsaac() {
  const options = await postJson("/api/isaac/sign-in/options");
  const response = await startAuthentication({ optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
  storeToken((await postJson("/api/isaac/sign-in", { response }))["token"]);
  await refreshIsaac();
}

export async function enrollAsIsaac(label: string) {
  const options = await postJson("/api/isaac/enroll/options");
  const response = await startRegistration({ optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]["optionsJSON"] });
  storeToken((await postJson("/api/isaac/enroll", { response, label }))["token"]);
  await refreshIsaac();
}

async function fetchAsIsaac(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await original(input, withToken(input, init));
  if (res.status !== 401 || !res.headers.has(NEEDS_HEADER) || !isOwnOrigin(input)) return res;
  try {
    await signInAsIsaac();
  } catch {
    return res;
  }
  return original(input, withToken(input, init));
}

// constraint: a cookie on localhost reaches every port, agent-run previews too, so his token stays in this origin's storage
export function installIsaacFetch() {
  // eslint-disable-next-line unicorn/no-global-object-property-assignment -- every request the page makes must carry his token, and 18 call sites use fetch directly
  globalThis.fetch = fetchAsIsaac as typeof fetch;
  void refreshIsaac();
}
