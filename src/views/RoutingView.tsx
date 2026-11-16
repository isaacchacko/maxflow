import { GitPullRequest, Hash, Network, User, Waypoints } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { routeChat } from "@/agent/plan";
import { cn } from "@/lib/utils";
import { NOW_AT, agentStateColor, sentries, type Signal, type Source } from "@/mock";
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

function day(at: string) {
  const d = at.slice(0, 10);
  if (d === NOW_AT.slice(0, 10)) return "Today";
  return new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

export function RoutingView() {
  const signals = signalStore.use();
  const agents = agentStore.use();
  const threads = threadStore.use();
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos>({});
  const [pinned, setPinned] = useState<string>();
  const [hover, setHover] = useState<string>();
  const [shown, setShown] = useState<Set<Source>>(new Set(["isaac", "gh", "slack"]));
  const [draft, setDraft] = useState("");
  const [fresh, setFresh] = useState<string>();

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

  const visible = signals.filter(s => shown.has(s.source));

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rootRef.current!);
    return () => ro.disconnect();
  }, [measure, visible.length]);

  const edges = buildEdges(visible).filter(e => !e.watch || shown.has(e.source));
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

  const toggle = (source: Source) =>
    setShown(prev => {
      const next = new Set(prev);
      if (next.has(source) && next.size > 1) next.delete(source);
      else next.add(source);
      return next;
    });

  const days = [...new Set(visible.map(s => day(s.at)))];
  const to = pinned?.startsWith("agent:") ? pinned.slice("agent:".length) : undefined;

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setShown(prev => new Set([...prev, "isaac"]));
    setFresh(routeChat(text, to));
    setDraft("");
  }

  return (
    <div ref={rootRef} onClick={() => setPinned(undefined)} className="relative grid h-full grid-cols-[minmax(0,1fr)_18rem] gap-x-40 p-4">
      <svg className="pointer-events-none absolute inset-0 size-full overflow-hidden">
        {edges.map(e => {
          if (e.from.startsWith("src:") && !e.watch) return null;
          const a = e.watch ? pos.log && { ...pos.log, y: pos.log.y } : pos[e.from];
          const b = pos[e.to];
          if (!a || !b) return null;
          const on = traced?.lit.has(e.key);
          if (e.watch && !on) return null;
          const x1 = a.r, x2 = b.l, mid = (x1 + x2) / 2;
          return (
            <path
              key={e.key}
              d={`M${x1},${a.y} C${mid},${a.y} ${mid},${b.y} ${x2},${b.y}`}
              className={cn("fill-none transition-opacity", look[e.source].stroke, on ? "opacity-90" : traced ? "opacity-5" : "opacity-30")}
              strokeWidth={on ? 1.75 : 1}
              strokeDasharray={e.watch ? "4 4" : undefined}
            />
          );
        })}
      </svg>

      <section className="relative flex min-h-0 flex-col gap-3">
        <header data-node="log" className="flex items-center gap-2">
          <h2 className="mr-2 text-sm font-medium">Event log</h2>
          {sentries.map(s => {
            const Icon = look[s.id].icon;
            const id = `src:${s.id}`;
            const on = shown.has(s.id);
            return (
              <button
                key={s.id}
                {...node(id)}
                onClick={e => {
                  e.stopPropagation();
                  toggle(s.id);
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-opacity",
                  on ? look[s.id].ring : "opacity-40",
                  dim(id) && "opacity-30",
                )}
              >
                <Icon className={cn("size-3.5", look[s.id].text)} />
                {s.label}
                <span className={cn("size-1.5 rounded-full", s.state === "backoff" ? "bg-amber-400" : "animate-pulse bg-emerald-400")} />
                <span className="text-muted-foreground">{s.state === "live" ? "live" : `${s.state} · ${s.every}`}</span>
              </button>
            );
          })}
          <span className="ml-auto text-xs text-muted-foreground">
            {pinned ? "Click again or on empty space to release" : "Hover or click to trace · click a source to filter"}
          </span>
        </header>

        <form
          onSubmit={send}
          onClick={e => e.stopPropagation()}
          className="flex items-center gap-3 rounded-lg border border-sky-400/40 bg-card px-3 py-1.5 focus-within:border-sky-400"
        >
          <span className="w-11 shrink-0 text-xs text-muted-foreground tabular-nums">now</span>
          <User className="size-3.5 shrink-0 text-sky-400" />
          <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">{to ? `→ ${to}` : "chat"}</span>
          <Input
            data-agent="log-composer"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={to ? `Message ${to}…` : "Tell the agents something… it routes to whoever owns what you mention"}
            className="h-7 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <kbd className="shrink-0 text-xs text-muted-foreground">↵</kbd>
        </form>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" onScroll={measure}>
          {days.map(d => (
            <div key={d} className="mb-3">
              <p className="sticky top-0 z-20 bg-background py-1 text-xs text-muted-foreground">{d}</p>
              <ol className="flex flex-col gap-1.5">
                {visible.filter(s => day(s.at) === d).map(s => {
                  const Icon = look[s.source].icon;
                  const id = `sig:${s.id}`;
                  return (
                    <li
                      key={s.id}
                      {...node(id)}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm transition-opacity",
                        dim(id) && "opacity-30",
                        focus === id && look[s.source].ring,
                        fresh === s.id && "agent-edited animate-in fade-in slide-in-from-top-2",
                      )}
                    >
                      <span className="w-11 shrink-0 text-xs text-muted-foreground tabular-nums">{when(s.at)}</span>
                      <Icon className={cn("size-3.5 shrink-0", look[s.source].text)} />
                      <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">{s.target}</span>
                      <span className="min-w-0 flex-1 truncate">{s.text}</span>
                      <span className={cn("shrink-0 text-xs", s.routedTo.length ? "text-muted-foreground" : "text-amber-400")}>
                        → {s.routedTo.length || "unrouted"}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      </section>

      <section className="relative flex min-h-0 flex-col gap-3">
        <h2 className="text-sm font-medium">Agents</h2>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto" onScroll={measure}>
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
                        {a.role === "router" ? <Network className="size-3.5 shrink-0 text-fuchsia-400" /> : <span className={cn("size-2 shrink-0 rounded-full", agentStateColor[a.state])} />}
                        <span className="shrink-0 font-mono text-xs whitespace-nowrap">{a.id}</span>
                        <span className="truncate text-xs text-muted-foreground">{a.doing}</span>
                      </Card>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
