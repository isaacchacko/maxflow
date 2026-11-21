import { ArrowLeftRight, Plus, Trash2, Workflow } from "lucide-react";
import { useRef, useState } from "react";
import { reloadResource, useEventListener, useResource } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { ago } from "@/threads/Replies";
import { type AgentGraph, type AgentNode, type Edge, MODELS, type Model } from "../../shared/agent-graphs";
import { createGraph, deleteGraph, graphKey, LIST_KEY, loadGraph, loadGraphs, putGraph } from "./graphs/api";
import { type Cell, CELL_H, CELL_W, cellAt, firstFreeCell, gridSize, isOnNode, labelAt, moveTo, NODE_H, NODE_W, nodeIn, nodeX, nodeY, PAD, pathOf, type Point, routes, routeToPoint } from "./graphs/grid";

type Selection = { kind: "node" | "edge"; id: string } | undefined;
type Drag = { kind: "move"; id: string } | { kind: "link"; from: string; at: Point };
type SaveState = "saved" | "saving" | "failed";

const SAVE_SETTLE_MS = 400;
const goTo = (id: string) => `#graphs/${id}`;
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 6)}`;
const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
const field = "w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring";

function useSaver() {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [state, setState] = useState<SaveState>("saved");
  const save = (g: AgentGraph) => {
    clearTimeout(timer.current);
    setState("saving");
    timer.current = setTimeout(() => {
      putGraph(g).then(
        () => {
          setState("saved");
          void reloadResource(LIST_KEY);
        },
        () => setState("failed"),
      );
    }, SAVE_SETTLE_MS);
  };
  return { state, save };
}

function GraphEdge({ edge, points, selected, onSelect }: { edge: Edge; points: Point[]; selected: boolean; onSelect: () => void }) {
  const mid = labelAt(points);
  return (
    <g className={cn("cursor-pointer", selected ? "text-primary" : "text-muted-foreground hover:text-foreground")} onPointerDown={e => { e.stopPropagation(); onSelect(); }} data-agent={`graphs:edge:${edge.id}`}>
      <path d={pathOf(points)} fill="none" stroke="transparent" strokeWidth={14} />
      <path d={pathOf(points)} fill="none" stroke="currentColor" strokeWidth={selected ? 2 : 1.5} markerEnd={selected ? "url(#graph-arrow-on)" : "url(#graph-arrow)"} />
      {hasText(edge.label) && (
        <foreignObject x={mid.x - 80} y={mid.y - 11} width={160} height={22} className="overflow-visible">
          <div className="flex justify-center">
            <span className={cn("max-w-40 truncate rounded border bg-card px-1.5 text-[11px] leading-5", selected && "border-primary")}>{edge.label}</span>
          </div>
        </foreignObject>
      )}
    </g>
  );
}

function GraphNode({ node, selected, linkable, onGrab, onLink }: { node: AgentNode; selected: boolean; linkable: boolean; onGrab: (e: React.PointerEvent) => void; onLink: (e: React.PointerEvent) => void }) {
  return (
    <div
      data-agent={`graphs:node:${node.id}`}
      onPointerDown={onGrab}
      style={{ left: nodeX(node.col), top: nodeY(node.row), width: NODE_W, height: NODE_H }}
      className={cn(
        "absolute flex cursor-grab touch-none flex-col justify-center rounded-md border bg-card px-3 shadow-xs select-none active:cursor-grabbing",
        selected && "border-primary ring-2 ring-primary/30",
        linkable && "border-primary/60",
      )}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{hasText(node.name) ? node.name : "Unnamed agent"}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground uppercase">{node.model}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">{hasText(node.role) ? node.role : "No role yet"}</span>
      <button
        type="button"
        title="Drag to another agent to hand work to it"
        data-agent={`graphs:port:${node.id}`}
        onPointerDown={onLink}
        className="absolute top-1/2 -right-[7px] size-3.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-primary bg-card hover:bg-primary"
      />
    </div>
  );
}

function Canvas({ graph, selection, select, change }: { graph: AgentGraph; selection: Selection; select: (s: Selection) => void; change: (g: AgentGraph) => void }) {
  const surface = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>();
  const [hover, setHover] = useState<Cell>();
  const { cols, rows, width, height } = gridSize(graph.nodes);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const paths = routes(graph);

  const pointAt = (e: { clientX: number; clientY: number }): Point => {
    const r = surface.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const addAt = (c: Cell) => {
    const node: AgentNode = { id: newId("n"), name: "", role: "", prompt: "", model: "opus", ...c };
    change({ ...graph, nodes: [...graph.nodes, node] });
    select({ kind: "node", id: node.id });
  };

  useEventListener("pointermove", e => {
    if (!drag) return;
    const p = pointAt(e);
    if (drag.kind === "link") {
      setDrag({ ...drag, at: p });
      return;
    }
    const next = moveTo(graph, drag.id, cellAt(p));
    if (next !== graph) change(next);
  });

  useEventListener("pointerup", e => {
    if (drag?.kind === "link") {
      const p = pointAt(e);
      const c = cellAt(p);
      const to = nodeIn(graph, c);
      const isNew = to && to.id !== drag.from && isOnNode(p, c) && !graph.edges.some(x => x.from === drag.from && x.to === to.id);
      if (isNew) {
        const edge: Edge = { id: newId("e"), from: drag.from, to: to.id, label: "" };
        change({ ...graph, edges: [...graph.edges, edge] });
        select({ kind: "edge", id: edge.id });
      }
    }
    setDrag(undefined);
  });

  const linking = drag?.kind === "link" ? byId.get(drag.from) : undefined;
  const hoverIsFree = hover && !drag && !nodeIn(graph, hover);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/20" data-agent="graphs:canvas">
      <div
        ref={surface}
        style={{ width, height }}
        className="relative"
        onPointerDown={() => select(undefined)}
        onPointerMove={e => {
          const c = cellAt(pointAt(e));
          if (c.col !== hover?.col || c.row !== hover.row) setHover(c);
        }}
        onPointerLeave={() => setHover(undefined)}
        onDoubleClick={e => {
          const c = cellAt(pointAt(e));
          if (!nodeIn(graph, c)) addAt(c);
        }}
      >
        <svg width={width} height={height} className="absolute inset-0">
          <defs>
            <pattern id="graph-cell" x={PAD} y={PAD} width={CELL_W} height={CELL_H} patternUnits="userSpaceOnUse">
              <path d={`M0 0 L${CELL_W} 0 M0 0 L0 ${CELL_H}`} fill="none" stroke="currentColor" strokeDasharray="2 6" className="text-border" />
            </pattern>
            {(["graph-arrow", "graph-arrow-on"] as const).map(id => (
              <marker key={id} id={id} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" className={id === "graph-arrow" ? "fill-muted-foreground" : "fill-primary"} />
              </marker>
            ))}
          </defs>
          <rect x={PAD} y={PAD} width={cols * CELL_W} height={rows * CELL_H} fill="url(#graph-cell)" className="text-border" />
          {Array.from({ length: cols }, (_, col) => (
            <text key={col} x={nodeX(col)} y={PAD - 10} className="fill-muted-foreground font-mono text-[10px]">
              STEP {col + 1}
            </text>
          ))}
          {graph.edges.map(edge => {
            const points = paths.get(edge.id);
            if (!points) return null;
            return <GraphEdge key={edge.id} edge={edge} points={points} selected={selection?.kind === "edge" && selection.id === edge.id} onSelect={() => select({ kind: "edge", id: edge.id })} />;
          })}
          {linking && drag?.kind === "link" && <path d={pathOf(routeToPoint(linking, drag.at))} fill="none" stroke="currentColor" strokeDasharray="4 4" strokeWidth={1.5} className="text-primary" />}
        </svg>
        {hoverIsFree && (
          <div style={{ left: nodeX(hover.col), top: nodeY(hover.row), width: NODE_W, height: NODE_H }} className="pointer-events-none absolute flex items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
            Double-click to add an agent
          </div>
        )}
        {graph.nodes.map(node => (
          <GraphNode
            key={node.id}
            node={node}
            selected={selection?.kind === "node" && selection.id === node.id}
            linkable={linking !== undefined && linking.id !== node.id}
            onGrab={e => {
              e.stopPropagation();
              select({ kind: "node", id: node.id });
              setDrag({ kind: "move", id: node.id });
            }}
            onLink={e => {
              e.stopPropagation();
              setDrag({ kind: "link", from: node.id, at: pointAt(e) });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{text}</span>
      {children}
    </label>
  );
}

function NodeInspector({ graph, node, change, select }: { graph: AgentGraph; node: AgentNode; change: (g: AgentGraph) => void; select: (s: Selection) => void }) {
  const edit = (patch: Partial<AgentNode>) => change({ ...graph, nodes: graph.nodes.map(n => (n.id === node.id ? { ...n, ...patch } : n)) });
  const nameOf = (id: string) => graph.nodes.find(n => n.id === id)?.name || "Unnamed agent";
  const links = graph.edges.filter(e => e.from === node.id || e.to === node.id);
  return (
    <div className="space-y-3" data-agent="graphs:inspector:node">
      <p className="font-mono text-[10px] text-muted-foreground">AGENT · STEP {node.col + 1}</p>
      <Label text="Name">
        <input autoFocus={!hasText(node.name)} value={node.name} onChange={e => edit({ name: e.target.value })} placeholder="e.g. Researcher" className={field} data-agent="graphs:node-name" />
      </Label>
      <Label text="Role">
        <input value={node.role} onChange={e => edit({ role: e.target.value })} placeholder="What it owns, one line" className={field} data-agent="graphs:node-role" />
      </Label>
      <Label text="Model">
        <select value={node.model} onChange={e => edit({ model: e.target.value as Model })} className={field}>
          {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </Label>
      <Label text="Instructions">
        <textarea value={node.prompt} onChange={e => edit({ prompt: e.target.value })} rows={8} placeholder="The brief this agent starts from" className={cn(field, "resize-y font-mono text-xs leading-relaxed")} />
      </Label>
      {links.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Hand-offs</p>
          {links.map(e => (
            <button key={e.id} type="button" onClick={() => select({ kind: "edge", id: e.id })} className="block w-full truncate rounded px-1.5 py-1 text-left text-xs hover:bg-muted">
              {e.from === node.id ? `→ ${nameOf(e.to)}` : `← ${nameOf(e.from)}`}
              {hasText(e.label) && <span className="text-muted-foreground"> · {e.label}</span>}
            </button>
          ))}
        </div>
      )}
      <button type="button" onClick={() => removeSelection(graph, { kind: "node", id: node.id }, change, select)} className="flex items-center gap-1.5 text-xs text-destructive hover:underline" data-agent="graphs:delete-node">
        <Trash2 className="size-3.5" /> Delete agent
      </button>
    </div>
  );
}

function EdgeInspector({ graph, edge, change, select }: { graph: AgentGraph; edge: Edge; change: (g: AgentGraph) => void; select: (s: Selection) => void }) {
  const edit = (patch: Partial<Edge>) => change({ ...graph, edges: graph.edges.map(e => (e.id === edge.id ? { ...e, ...patch } : e)) });
  const nameOf = (id: string) => graph.nodes.find(n => n.id === id)?.name || "Unnamed agent";
  const reversedExists = graph.edges.some(e => e.from === edge.to && e.to === edge.from);
  return (
    <div className="space-y-3" data-agent="graphs:inspector:edge">
      <p className="font-mono text-[10px] text-muted-foreground">HAND-OFF</p>
      <p className="text-sm">
        <button type="button" className="font-medium hover:underline" onClick={() => select({ kind: "node", id: edge.from })}>{nameOf(edge.from)}</button>
        <span className="text-muted-foreground"> → </span>
        <button type="button" className="font-medium hover:underline" onClick={() => select({ kind: "node", id: edge.to })}>{nameOf(edge.to)}</button>
      </p>
      <Label text="What it hands over">
        <input autoFocus value={edge.label} onChange={e => edit({ label: e.target.value })} placeholder="e.g. findings, a plan, a PR" className={field} data-agent="graphs:edge-label" />
      </Label>
      <div className="flex items-center gap-4">
        <button type="button" disabled={reversedExists} onClick={() => edit({ from: edge.to, to: edge.from })} className="flex items-center gap-1.5 text-xs hover:underline disabled:opacity-40">
          <ArrowLeftRight className="size-3.5" /> Reverse
        </button>
        <button type="button" onClick={() => removeSelection(graph, { kind: "edge", id: edge.id }, change, select)} className="flex items-center gap-1.5 text-xs text-destructive hover:underline" data-agent="graphs:delete-edge">
          <Trash2 className="size-3.5" /> Delete hand-off
        </button>
      </div>
    </div>
  );
}

function GraphInspector({ graph, change }: { graph: AgentGraph; change: (g: AgentGraph) => void }) {
  const [isArmed, setArmed] = useState(false);
  const remove = async () => {
    await deleteGraph(graph.id);
    await reloadResource(LIST_KEY);
    location.hash = "graphs";
  };
  return (
    <div className="space-y-3" data-agent="graphs:inspector:graph">
      <p className="font-mono text-[10px] text-muted-foreground">GRAPH</p>
      <Label text="Name">
        <input value={graph.name} onChange={e => change({ ...graph, name: e.target.value })} className={field} data-agent="graphs:name" />
      </Label>
      <Label text="Goal">
        <textarea value={graph.goal} onChange={e => change({ ...graph, goal: e.target.value })} rows={4} placeholder="The multistep problem this team solves" className={cn(field, "resize-y")} data-agent="graphs:goal" />
      </Label>
      <p className="text-xs text-muted-foreground">
        {graph.nodes.length} agent(s), {graph.edges.length} hand-off(s). Double-click an empty cell to add an agent, drag a node to move it a cell at a time, drag from its right dot to hand off to another. Arrow keys move the selected agent; Delete removes.
      </p>
      <button type="button" onBlur={() => setArmed(false)} onClick={() => (isArmed ? void remove() : setArmed(true))} className="flex items-center gap-1.5 text-xs text-destructive hover:underline" data-agent="graphs:delete-graph">
        <Trash2 className="size-3.5" /> {isArmed ? "Click again to delete this graph" : "Delete graph"}
      </button>
    </div>
  );
}

function removeSelection(graph: AgentGraph, s: Selection, change: (g: AgentGraph) => void, select: (s: Selection) => void) {
  if (!s) return;
  if (s.kind === "edge") change({ ...graph, edges: graph.edges.filter(e => e.id !== s.id) });
  else change({ ...graph, nodes: graph.nodes.filter(n => n.id !== s.id), edges: graph.edges.filter(e => e.from !== s.id && e.to !== s.id) });
  select(undefined);
}

const ARROWS: Record<string, Cell> = { ArrowLeft: { col: -1, row: 0 }, ArrowRight: { col: 1, row: 0 }, ArrowUp: { col: 0, row: -1 }, ArrowDown: { col: 0, row: 1 } };

function Editor({ initial }: { initial: AgentGraph }) {
  const [graph, setGraph] = useState(initial);
  const [selection, select] = useState<Selection>();
  const saver = useSaver();
  const change = (g: AgentGraph) => {
    setGraph(g);
    saver.save(g);
  };
  const node = selection?.kind === "node" ? graph.nodes.find(n => n.id === selection.id) : undefined;
  const edge = selection?.kind === "edge" ? graph.edges.find(e => e.id === selection.id) : undefined;

  useEventListener("keydown", e => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
    if (e.key === "Escape" && selection) {
      e.stopPropagation();
      select(undefined);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
      e.preventDefault();
      removeSelection(graph, selection, change, select);
    } else if (node && e.key in ARROWS) {
      e.preventDefault();
      const d = ARROWS[e.key] ?? { col: 0, row: 0 };
      if (node.col + d.col >= 0 && node.row + d.row >= 0) change(moveTo(graph, node.id, { col: node.col + d.col, row: node.row + d.row }));
    }
  }, { capture: true });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <Workflow className="size-4 text-muted-foreground" />
        <span className="truncate text-sm font-semibold">{graph.name}</span>
        <span className={cn("text-xs", saver.state === "failed" ? "text-destructive" : "text-muted-foreground")} data-agent="graphs:save-state">
          {saver.state === "saved" ? "Saved" : saver.state === "saving" ? "Saving…" : "Not saved"}
        </span>
        <button
          type="button"
          onClick={() => {
            const n: AgentNode = { id: newId("n"), name: "", role: "", prompt: "", model: "opus", ...firstFreeCell(graph) };
            change({ ...graph, nodes: [...graph.nodes, n] });
            select({ kind: "node", id: n.id });
          }}
          className="ml-auto flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-muted"
          data-agent="graphs:add-node"
        >
          <Plus className="size-3.5" /> Agent
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <Canvas graph={graph} selection={selection} select={select} change={change} />
        <aside className="w-80 shrink-0 overflow-y-auto border-l p-4">
          {node && <NodeInspector key={node.id} graph={graph} node={node} change={change} select={select} />}
          {edge && <EdgeInspector key={edge.id} graph={graph} edge={edge} change={change} select={select} />}
          {!node && !edge && <GraphInspector graph={graph} change={change} />}
        </aside>
      </div>
    </div>
  );
}

function GraphPane({ id }: { id: string }) {
  const loaded = useResource(graphKey(id), async () => loadGraph(id));
  if (loaded.error) return <p className="flex-1 p-4 text-sm text-destructive">{loaded.error.message}</p>;
  if (!loaded.value) return <p className="flex-1 p-4 text-sm text-muted-foreground">Loading…</p>;
  return <Editor key={id} initial={loaded.value} />;
}

export function GraphsView({ id }: { id: string | undefined }) {
  const list = useResource(LIST_KEY, loadGraphs);
  const add = async () => {
    const g = await createGraph("Untitled graph");
    await reloadResource(LIST_KEY);
    location.hash = goTo(g.id);
  };
  return (
    <div className="flex h-full min-h-0" data-agent="graphs">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <span className="text-sm font-semibold">Agent graphs</span>
          <button type="button" onClick={() => void add()} title="New graph" className="ml-auto rounded-md p-1 hover:bg-muted" data-agent="graphs:new">
            <Plus className="size-4" />
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-1">
          {list.error && <p className="px-2 text-sm text-destructive">{list.error.message}</p>}
          {list.value?.map(g => (
            <a key={g.id} href={goTo(g.id)} data-agent={`graphs:open:${g.id}`} className={cn("flex flex-col rounded-md px-2 py-1.5 hover:bg-muted", id === g.id && "bg-muted")}>
              <span className="truncate text-sm">{g.name}</span>
              <span className="truncate text-xs text-muted-foreground">{g.agents} agent(s) · {ago(Date.parse(g.updatedAt))} ago</span>
            </a>
          ))}
          {list.value?.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No graphs yet.</p>}
        </nav>
      </aside>
      {hasText(id) ? <GraphPane id={id} /> : <p className="flex-1 p-4 text-sm text-muted-foreground">Pick a graph, or start one with +.</p>}
    </div>
  );
}
