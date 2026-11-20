import { isRecord } from "../../../shared/guards";

export type CanvasNode = { id: string; type: "text"; text: string; x: number; y: number; width: number; height: number; color?: string; author?: string };
export type Box = Partial<Pick<CanvasNode, "text" | "x" | "y" | "width" | "height">>;
export type Link = { text: string; to: string; near: number };

export const CANVAS_CHANGED = "yarn:canvas-changed";
export function canvasChanged(path: string) {
  dispatchEvent(new CustomEvent(CANVAS_CHANGED, { detail: path }));
}

const at = (path: string, rest = "") => `/api/canvas/${encodeURIComponent(path)}${rest}`;

async function answer(url: string, method = "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method, ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!res.ok && res.status !== 409) throw new Error(await res.text());
  const json: unknown = await res.json();
  if (!isRecord(json)) throw new Error(`${url} didn't answer with an object`);
  return { status: res.status, body: json };
}

export async function loadBoxes(path: string): Promise<CanvasNode[]> {
  const { body } = await answer(at(path));
  const canvas = isRecord(body["canvas"]) ? body["canvas"] : {};
  return Array.isArray(canvas["nodes"]) ? (canvas["nodes"] as CanvasNode[]) : [];
}

export const createCanvas = async (path: string) => answer(at(path), "POST");
export const addBox = async (path: string, box: Box) => (await answer(at(path, "/nodes"), "POST", box)).body as CanvasNode;
export const removeBox = async (path: string, id: string) => answer(at(path, `/nodes/${id}`), "DELETE");
export const linkBox = async (path: string, from: string, link: Link) => (await answer(at(path, `/nodes/${from}/link`), "POST", { text: link.text, to: link.to, at: link.near })).body as CanvasNode;

export async function editBox(path: string, id: string, box: Box & { base?: string }) {
  const { status, body } = await answer(at(path, `/nodes/${id}`), "PATCH", box);
  return { node: body as CanvasNode, isConflict: status === 409 };
}

export async function markTyping(path: string, id: string) {
  try {
    await fetch(at(path, `/nodes/${id}/typing`), { method: "POST" });
  } catch (error) {
    console.warn("canvas typing beat dropped:", error);
  }
}
