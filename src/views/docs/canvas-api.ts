import { isRecord } from "../../../shared/guards";

export type CanvasNode = { id: string; type: "text"; text: string; x: number; y: number; width: number; height: number; color?: string; author?: string };
export type Box = Partial<Pick<CanvasNode, "text" | "x" | "y" | "width" | "height">>;
export type Shown = { path: string; rev: number; nodes: CanvasNode[] };

const listeners = new Set<(path: string) => void>();

export function onCanvasChanged(listener: (path: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const canvasChanged = (path: string) => {
  for (const listener of listeners) listener(path);
};

const at = (path: string, rest = "") => `/api/canvas/${encodeURIComponent(path)}${rest}`;

async function answer(url: string, method = "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method, ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!res.ok && res.status !== 409) throw new Error(await res.text());
  const json: unknown = await res.json();
  if (!isRecord(json)) throw new Error(`${url} didn't answer with an object`);
  return { status: res.status, body: json };
}

export async function loadCanvas(path: string): Promise<Shown> {
  const { body } = await answer(at(path));
  const canvas = isRecord(body["canvas"]) ? body["canvas"] : {};
  return { path, rev: Number(body["rev"]), nodes: Array.isArray(canvas["nodes"]) ? (canvas["nodes"] as CanvasNode[]) : [] };
}

export const createCanvas = async (path: string) => answer(at(path), "POST");
export const addBox = async (path: string, box: Box) => (await answer(at(path, "/nodes"), "POST", box)).body as CanvasNode;
export const removeBox = async (path: string, id: string) => answer(at(path, `/nodes/${id}`), "DELETE");
export const linkBox = async (path: string, from: string, text: string, to: string, near = 0) => (await answer(at(path, `/nodes/${from}/link`), "POST", { text, to, at: near })).body as CanvasNode;

// base is the text this edit started from; the server merges it with what agents wrote since, and answers 409 only when both touched the same words
export async function editBox(path: string, id: string, box: Box & { base?: string }) {
  const { status, body } = await answer(at(path, `/nodes/${id}`), "PATCH", box);
  return { node: body as CanvasNode, isConflict: status === 409 };
}

// beat while a box is open in the editor: an agent can't replace its whole text then, only find/replace or append, which merge
export const markTyping = async (path: string, id: string) => answer(at(path, `/nodes/${id}/typing`), "POST");
