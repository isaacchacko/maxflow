import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentGraph, type GraphSummary, graphOf } from "./shared/agent-graphs";
import { STATE_DIR } from "./instance";

export const GRAPHS_DIR = join(STATE_DIR, "agent-graphs");
const ID = /^g-[0-9a-f]{6}$/;

const fileOf = (id: string) => join(GRAPHS_DIR, `${id}.json`);
export const isGraphId = (id: string) => ID.test(id);

export function readGraph(id: string): AgentGraph | undefined {
  if (!isGraphId(id) || !existsSync(fileOf(id))) return undefined;
  return JSON.parse(readFileSync(fileOf(id), "utf8")) as AgentGraph;
}

export function listGraphs(): GraphSummary[] {
  if (!existsSync(GRAPHS_DIR)) return [];
  return readdirSync(GRAPHS_DIR)
    .filter(f => f.endsWith(".json"))
    .flatMap(f => readGraph(f.slice(0, -5)) ?? [])
    .map(g => ({ id: g.id, name: g.name, goal: g.goal, updatedAt: g.updatedAt, agents: g.nodes.length }))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function write(graph: AgentGraph) {
  mkdirSync(GRAPHS_DIR, { recursive: true });
  const tmp = `${fileOf(graph.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(graph, null, 2));
  renameSync(tmp, fileOf(graph.id));
  return graph;
}

export function saveGraph(id: string, raw: unknown): AgentGraph | string {
  const graph = graphOf(raw, id);
  return typeof graph === "string" ? graph : write({ ...graph, updatedAt: new Date().toISOString() });
}

export function createGraph(name: string): AgentGraph {
  let id = "";
  do id = `g-${crypto.randomUUID().slice(0, 6)}`;
  while (existsSync(fileOf(id)));
  return write({ id, name, goal: "", nodes: [], edges: [], updatedAt: new Date().toISOString() });
}

export function deleteGraph(id: string) {
  if (!isGraphId(id)) return false;
  const existed = existsSync(fileOf(id));
  rmSync(fileOf(id), { force: true });
  return existed;
}
