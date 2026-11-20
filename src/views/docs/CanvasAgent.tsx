import { Check, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { AgentFace } from "@/components/AgentFace";
import { cn } from "@/lib/utils";
import { tokenDiff } from "../../../shared/merge-text";
import type { Camera } from "./camera";
import type { Agent, CanvasNode, Edge, Proposal } from "./canvas-api";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

const MARKER_INSET = 28;
const centerOf = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

function borderToward(r: Rect, toward: Point): Point {
  const c = centerOf(r);
  const [dx, dy] = [toward.x - c.x, toward.y - c.y];
  const scale = Math.min(Math.abs(r.width / 2 / (dx === 0 ? 1e-9 : dx)), Math.abs(r.height / 2 / (dy === 0 ? 1e-9 : dy)));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

export function Edges({ nodes, edges }: { nodes: CanvasNode[]; edges: Edge[] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines: { id: string; a: Point; b: Point }[] = [];
  for (const e of edges) {
    const [from, to] = [byId.get(e.fromNode), byId.get(e.toNode)];
    if (from && to) lines.push({ id: e.id, a: borderToward(from, centerOf(to)), b: borderToward(to, centerOf(from)) });
  }
  return (
    <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden>
      {lines.map((l) => (
        <line key={l.id} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} className="stroke-muted-foreground/40" strokeWidth={1.5} strokeDasharray="4 4" />
      ))}
    </svg>
  );
}

function keyedSteps(proposal: Proposal) {
  let offset = 0;
  return tokenDiff(proposal.base, proposal.text).map((step) => {
    offset += step.token.length;
    return { ...step, key: `${step.kind}${offset}` };
  });
}

function Diff({ proposal }: { proposal: Proposal }) {
  return (
    <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
      {keyedSteps(proposal).map((step) => (
        <span key={step.key} className={cn(step.kind === "drop" && "bg-destructive/10 text-destructive line-through", step.kind === "add" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300")}>
          {step.token}
        </span>
      ))}
    </p>
  );
}

export function ProposalCard({ path, node, onSettle }: { path: string; node: CanvasNode & { proposal: Proposal }; onSettle: (verdict: "accept" | "reject") => void }) {
  return (
    <div
      data-agent={`canvas:proposal:${path}:${node.id}`}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="absolute top-full right-0 left-0 z-10 mt-2 flex flex-col gap-1.5 rounded-lg border border-amber-400/70 bg-card p-2.5 shadow-md"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <AgentFace id={node.proposal.author} small still className="size-4" />
        <span className="flex-1">suggests</span>
        <button type="button" title="Reject" data-agent={`canvas:reject:${node.id}`} onClick={() => onSettle("reject")} className="rounded p-0.5 hover:bg-muted hover:text-destructive">
          <X className="size-3.5" />
        </button>
        <button type="button" title="Accept" data-agent={`canvas:accept:${node.id}`} onClick={() => onSettle("accept")} className="flex items-center gap-0.5 rounded bg-emerald-600 px-1.5 py-0.5 font-medium text-white hover:bg-emerald-700">
          <Check className="size-3" />
          Accept
        </button>
      </div>
      <Diff proposal={node.proposal} />
    </div>
  );
}

export function AgentChip({ agent, onAsk }: { agent: Agent | undefined; onAsk: () => void }) {
  return (
    <button type="button" title="Ask the canvas agent to look now (⌘S)" data-agent="canvas:ask" onClick={onAsk} className="flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted">
      {agent ? <AgentFace id={agent.id} small still={!agent.isWorking} className="size-4" /> : <Sparkles className="size-3.5 text-muted-foreground" />}
      <span>{agent?.isWorking === true ? "Thinking…" : "Ask agent"}</span>
      <kbd className="text-[10px] text-muted-foreground">⌘S</kbd>
    </button>
  );
}

type View = { camera: Camera; width: number; height: number };

function screenOf(n: Rect, { camera }: View) {
  return { x: n.x * camera.z + camera.x, y: n.y * camera.z + camera.y, width: n.width * camera.z, height: n.height * camera.z };
}

const isOnScreen = (r: Rect, v: View) => r.x + r.width > 0 && r.y + r.height > 0 && r.x < v.width && r.y < v.height;

export function useFresh(nodes: CanvasNode[] | undefined, view: View | undefined) {
  const [known, setKnown] = useState<ReadonlySet<string> | undefined>();
  const [fresh, setFresh] = useState<readonly string[]>([]);
  const ids = nodes?.map((n) => n.id) ?? [];
  const arrived = known ? ids.filter((id) => !known.has(id)) : [];
  if (nodes && !known) setKnown(new Set(ids));
  if (known && arrived.length > 0) {
    setKnown(new Set([...known, ...arrived]));
    const byAgents = arrived.filter((id) => (nodes?.find((n) => n.id === id)?.author ?? "isaac") !== "isaac");
    setFresh((was) => [...was, ...byAgents]);
  }
  const freshNodes = (nodes ?? []).filter((n) => fresh.includes(n.id));
  const seen = view ? freshNodes.filter((n) => isOnScreen(screenOf(n, view), view)) : [];
  if (seen.length > 0) setFresh((was) => was.filter((id) => seen.every((n) => n.id !== id)));
  const offScreen = view ? freshNodes.filter((n) => !seen.includes(n)) : [];
  return { offScreen, dismiss: (id: string) => setFresh((was) => was.filter((x) => x !== id)) };
}

export function OffscreenMarkers({ nodes, view, onJump }: { nodes: CanvasNode[]; view: View; onJump: (id: string) => void }) {
  return nodes.map((n) => {
    const c = centerOf(screenOf(n, view));
    const at = { x: Math.min(view.width - MARKER_INSET, Math.max(MARKER_INSET, c.x)), y: Math.min(view.height - MARKER_INSET, Math.max(MARKER_INSET, c.y)) };
    const angle = (Math.atan2(c.y - at.y, c.x - at.x) * 180) / Math.PI;
    return (
      <button
        key={n.id}
        type="button"
        title="An agent added a box over here: click to look"
        data-agent={`canvas:offscreen:${n.id}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onJump(n.id)}
        style={{ left: at.x, top: at.y }}
        className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center rounded-full border bg-card/95 p-1 shadow-md hover:scale-110"
      >
        <AgentFace id={n.author ?? ""} small still className="size-4" />
        <span style={{ transform: `rotate(${angle}deg)` }} className="absolute inset-0 flex items-center justify-end" aria-hidden>
          <span className="-mr-2 border-y-4 border-l-[6px] border-y-transparent border-l-muted-foreground/60" />
        </span>
      </button>
    );
  });
}
