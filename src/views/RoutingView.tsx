import { GitPullRequest, Hash, Network, User, Waypoints } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { agentStateColor, sentries, type Signal, type Source } from "@/mock";
import { agentStore, signalStore, threadStore } from "@/store";

const look: Record<Source, { icon: typeof User; text: string; stroke: string; ring: string }> = {
  isaac: { icon: User, text: "text-sky-400", stroke: "stroke-sky-400", ring: "border-sky-400/60" },
  gh: { icon: GitPullRequest, text: "text-emerald-400", stroke: "stroke-emerald-400", ring: "border-emerald-400/60" },
  slack: { icon: Hash, text: "text-amber-400", stroke: "stroke-amber-400", ring: "border-amber-400/60" },
};

type Edge = { key: string; from: string; to: string; source: Source; watch?: boolean };
type Pos = Record<string, { l: number; r: number; y: number }>;

function when(at: string) {
  const d = new Date(at);
  return at.startsWith("2026-11-15") || at.startsWith(new Date().toISOString().slice(0, 10))
    ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function buildEdges(signals: Signal[]) {
  const edges: Edge[] = [];
  for (const s of signals) {
    edges.push({ key: `src:${s.source}>sig:${s.id}`, from: `src:${s.source}`, to: `sig:${s.id}`, source: s.source });
    for (const a of s.routedTo) edges.push({ key: `sig:${s.id}>agent:${a}`, from: `sig:${s.id}`, to: `agent:${a}`, source: s.source });
  }
  for (const sentry of sentries) {
    for (const a of new Set(sentry.watching.flatMap(w => w.routedTo)))
      edges.push({ key: `src:${sentry.id}~agent:${a}`, from: `src:${sentry.id}`, to: `agent:${a}`, source: sentry.id, watch: true });
  }
  return edges;
}

/** Everything connected to the focused node, one hop through signals. */
function trace(focus: string, edges: Edge[]) {
  const nodes = new Set([focus]);
  const lit = new Set<string>();
  const routed = edges.filter(e => !e.watch);
  const visit = (e: Edge) => {
    lit.add(e.key);
    nodes.add(e.from);
    nodes.add(e.to);
  };
  if (focus.startsWith("sig:")) routed.filter(e => e.from === focus || e.to === focus).forEach(visit);
  if (focus.startsWith("src:")) {
    const sigs = routed.filter(e => e.from === focus);
    sigs.forEach(visit);
    routed.filter(e => sigs.some(s => s.to === e.from)).forEach(visit);
    edges.filter(e => e.watch && e.from === focus).forEach(visit);
  }
  if (focus.startsWith("agent:")) {
    const into = routed.filter(e => e.to === focus);
    into.forEach(visit);
    routed.filter(e => into.some(i => i.from === e.to)).forEach(visit);
    edges.filter(e => e.watch && e.to === focus).forEach(visit);
  }
  return { nodes, lit };
}

export function RoutingView() {
  const signals = signalStore.use();
  const agents = agentStore.use();
  const threads = threadStore.use();
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos>({});
  const [pinned, setPinned] = useState<string>();
  const [hover, setHover] = useState<string>();

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const next: Pos = {};
    root.querySelectorAll<HTMLElement>("[data-node]").forEach(el => {
      const r = el.getBoundingClientRect();
      next[el.dataset.node!] = { l: r.left - base.left, r: r.right - base.left, y: r.top - base.top + r.height / 2 };
    });
    setPos(next);
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rootRef.current!);
    return () => ro.disconnect();
  }, [measure, signals.length]);

  const edges = buildEdges(signals);
  const focus = hover ?? pinned;
  const traced = focus ? trace(focus, edges) : undefined;
  const dim = (id: string) => traced && !traced.nodes.has(id);

  const node = (id: string) => ({
    "data-node": id,
    onMouseEnter: () => setHover(id),
    onMouseLeave: () => setHover(undefined),
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      setPinned(p => (p === id ? undefined : id));
    },
  });

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        {sentries.map(s => {
          const Icon = look[s.id].icon;
          return (
            <span key={s.id} className={cn("flex items-center gap-1.5", look[s.id].text)}>
              <Icon className="size-3.5" />
              {s.label}
            </span>
          );
        })}
        <span className="flex items-center gap-1.5"><span className="w-5 border-t" /> routed</span>
        <span className="flex items-center gap-1.5"><span className="w-5 border-t border-dashed" /> watches for</span>
        <span className="ml-auto">{pinned ? "Click again or on empty space to release" : "Hover or click anything to trace it"}</span>
      </div>

      <div ref={rootRef} onClick={() => setPinned(undefined)} className="relative grid min-h-0 flex-1 grid-cols-[14rem_1fr_17rem] gap-x-24">
        <svg className="pointer-events-none absolute inset-0 size-full overflow-hidden">
          {edges.map(e => {
            const a = pos[e.from];
            const b = pos[e.to];
            if (!a || !b) return null;
            const on = traced?.lit.has(e.key);
            if (e.watch && !on) return null;
            const x1 = a.r, x2 = b.l, mid = (x1 + x2) / 2;
            return (
              <path
                key={e.key}
                d={`M${x1},${a.y} C${mid},${a.y} ${mid},${b.y} ${x2},${b.y}`}
                className={cn("fill-none transition-opacity", look[e.source].stroke, on ? "opacity-90" : traced ? "opacity-5" : "opacity-25")}
                strokeWidth={on ? 1.75 : 1}
                strokeDasharray={e.watch ? "4 4" : undefined}
              />
            );
          })}
        </svg>

        <section className="relative flex flex-col justify-around gap-3">
          {sentries.map(s => {
            const Icon = look[s.id].icon;
            const id = `src:${s.id}`;
            return (
              <Card key={s.id} {...node(id)} className={cn("cursor-pointer gap-2 px-3 py-3 transition-opacity", dim(id) && "opacity-30", focus === id && look[s.id].ring)}>
                <div className="flex items-center gap-2">
                  <Icon className={cn("size-4", look[s.id].text)} />
                  <span className="text-sm font-medium">{s.label}</span>
                  <Badge variant="outline" className="ml-auto gap-1 text-[10px]">
                    <span className={cn("size-1.5 rounded-full", s.state === "backoff" ? "bg-amber-400" : "animate-pulse bg-emerald-400")} />
                    {s.state}
                  </Badge>
                </div>
                {s.every && <p className="text-xs text-muted-foreground">every {s.every} · last {s.lastPoll}</p>}
                <div className="flex flex-wrap gap-1">
                  {s.watching.map(w => (
                    <Badge key={w.target} variant="secondary" className="font-mono text-[10px]">{w.target}</Badge>
                  ))}
                </div>
              </Card>
            );
          })}
        </section>

        <section className="relative -mx-2 min-h-0 overflow-y-auto px-2" onScroll={measure}>
          <div className="flex flex-col gap-2 py-1">
            {signals.map(s => {
              const Icon = look[s.source].icon;
              const id = `sig:${s.id}`;
              return (
                <Card key={s.id} {...node(id)} className={cn("cursor-pointer gap-1 px-3 py-2 transition-opacity", dim(id) && "opacity-30", focus === id && look[s.source].ring)}>
                  <div className="flex items-center gap-2 text-xs">
                    <Icon className={cn("size-3.5 shrink-0", look[s.source].text)} />
                    <span className="font-mono text-muted-foreground">{s.target}</span>
                    <span className="ml-auto text-muted-foreground tabular-nums">{when(s.at)}</span>
                  </div>
                  <p className="line-clamp-1 text-sm">{s.text}</p>
                </Card>
              );
            })}
          </div>
        </section>

        <section className="relative flex min-h-0 flex-col justify-center gap-3 overflow-y-auto">
          {threads.map(thread => (
            <div key={thread.id} className="flex flex-col gap-1">
              <a href={`#thread/${thread.id}`} onClick={e => e.stopPropagation()} className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground hover:text-foreground">
                <Waypoints className="size-3 text-agent" />
                {thread.title}
              </a>
              {agents.filter(a => a.threadId === thread.id && a.role === "router").map(router => (
                <div key={router.id} className="flex flex-col gap-1">
                  {[router, ...agents.filter(w => w.parent === router.id)].map(a => {
                    const id = `agent:${a.id}`;
                    return (
                      <Card
                        key={a.id}
                        {...node(id)}
                        className={cn(
                          "cursor-pointer flex-row items-center gap-2 px-3 py-1.5 transition-opacity",
                          a.role === "worker" && "ml-6",
                          dim(id) && "opacity-30",
                          focus === id && "border-agent",
                        )}
                      >
                        {a.role === "router" ? <Network className="size-3.5 text-fuchsia-400" /> : <span className={cn("size-2 rounded-full", agentStateColor[a.state])} />}
                        <span className="shrink-0 font-mono text-xs whitespace-nowrap">{a.id}</span>
                        <span className="truncate text-xs text-muted-foreground">{a.doing}</span>
                      </Card>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
