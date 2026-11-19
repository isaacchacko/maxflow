import { isRecord } from "../../../shared/guards";

export type DocSummary = { path: string; owner?: string; open: number };
export type Vault = { dir: string; docs: DocSummary[]; folders: string[]; files: string[] };
export type Doc = { path: string; text: string; version: string; owner?: string };
export type Saved = { kind: "saved"; version: string } | { kind: "conflict"; text: string; version: string };

const docUrl = (path: string) => `/api/docs/${encodeURIComponent(path)}`;
const folderUrl = (path: string) => `/api/docs-folder/${encodeURIComponent(path)}`;

async function send(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok && res.status !== 409) throw new Error(await res.text());
  return res;
}

const json = (body: unknown): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function answer(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const body: unknown = await (await send(url, init)).json();
  if (!isRecord(body)) throw new Error(`${url} didn't answer with an object`);
  return body;
}

const known = { docPaths: [] as string[] };
export const knownDocPaths = () => known.docPaths;

export async function loadVault(): Promise<Vault> {
  const v = await answer("/api/docs");
  if (!Array.isArray(v["docs"]) || !Array.isArray(v["folders"])) throw new TypeError("The server didn't answer with the docs vault");
  const vault = v as Vault;
  known.docPaths = vault.docs.map((d) => d.path);
  return vault;
}

export async function loadDoc(path: string): Promise<Doc> {
  const d = await answer(docUrl(path));
  if (typeof d["text"] !== "string" || typeof d["version"] !== "string") throw new TypeError(`The server didn't answer with ${path}`);
  return d as Doc;
}

export async function saveDoc(path: string, text: string, base: string): Promise<Saved> {
  const res = await send(docUrl(path), { method: "PUT", ...json({ text, base }) });
  const body = (await res.json()) as { text: string; version: string };
  return res.status === 409 ? { kind: "conflict", text: body.text, version: body.version } : { kind: "saved", version: body.version };
}

export const createDoc = async (path: string, text: string) => answer(docUrl(path), { method: "PUT", ...json({ text }) });
export const uploadFile = async (path: string, file: Blob) => answer(docUrl(path), { method: "PUT", body: file });
export const moveDoc = async (path: string, to: string) => answer(docUrl(path), { method: "PATCH", ...json({ to }) });
export const removeDoc = async (path: string) => answer(docUrl(path), { method: "DELETE" });
export const makeFolder = async (path: string) => answer(folderUrl(path), { method: "POST" });
export const moveFolder = async (path: string, to: string) => answer(folderUrl(path), { method: "PATCH", ...json({ to }) });
export const removeFolder = async (path: string) => answer(folderUrl(path), { method: "DELETE" });
