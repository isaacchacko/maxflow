import type { AgentGraph, GraphSummary } from "../../../shared/agent-graphs";

export const LIST_KEY = "graphs";
export const graphKey = (id: string) => `graph:${id}`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export const loadGraphs = async () => json<GraphSummary[]>(await fetch("/api/graphs"));
export const loadGraph = async (id: string) => json<AgentGraph>(await fetch(`/api/graphs/${id}`));
export const createGraph = async (name: string) => json<AgentGraph>(await fetch("/api/graphs", { method: "POST", body: JSON.stringify({ name }) }));
export const putGraph = async (g: AgentGraph) => json<AgentGraph>(await fetch(`/api/graphs/${g.id}`, { method: "PUT", body: JSON.stringify(g) }));

export async function deleteGraph(id: string) {
  const res = await fetch(`/api/graphs/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}
