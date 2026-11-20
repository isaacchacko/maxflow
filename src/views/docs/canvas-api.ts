import { isRecord } from "../../../shared/guards";

export type Proposal = { text: string; base: string; author: string; at: number };
export type CanvasNode = { id: string; type: "text"; text: string; x: number; y: number; width: number; height: number; color?: string; author?: string; proposal?: Proposal };
export type Edge = { id: string; fromNode: string; toNode: string };
export type Agent = { id: string; name: string; isWorking: boolean };
export type Shown = { nodes: CanvasNode[]; edges: Edge[]; agent: Agent | undefined };
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

const listAt = <T>(record: Record<string, unknown>, key: string) => (Array.isArray(record[key]) ? (record[key] as T[]) : []);

export async function loadCanvas(path: string): Promise<Shown> {
  const { body } = await answer(at(path));
  const canvas = isRecord(body["canvas"]) ? body["canvas"] : {};
  return { nodes: listAt<CanvasNode>(canvas, "nodes"), edges: listAt<Edge>(canvas, "edges"), agent: isRecord(body["agent"]) ? (body["agent"] as Agent) : undefined };
}

export const createCanvas = async (path: string) => answer(at(path), "POST");
export const askAgent = async (path: string) => answer(at(path, "/ask"), "POST");
export const addBox = async (path: string, box: Box) => (await answer(at(path, "/nodes"), "POST", box)).body as CanvasNode;
export const removeBox = async (path: string, id: string) => answer(at(path, `/nodes/${id}`), "DELETE");
export const linkBox = async (path: string, from: string, link: Link) => (await answer(at(path, `/nodes/${from}/link`), "POST", { text: link.text, to: link.to, at: link.near })).body as CanvasNode;
export const settleProposal = async (path: string, id: string, verdict: "accept" | "reject") => (await answer(at(path, `/nodes/${id}/${verdict}`), "POST")).body as CanvasNode;

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
