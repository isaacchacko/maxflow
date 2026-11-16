import { GitPullRequest, Hash, Network, Plus, SquareArrowOutUpRight, User, Waypoints } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { routeChat } from "@/agent/plan";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { NOW_AT, agentStateColor, objectiveStatus, sentries, statusColor, type Agent, type Signal, type Source } from "@/mock";
import { agentStore, objectiveStore, pathOf, signalStore, splitRouter, taskStore } from "@/store";

const look: Record<Source, { icon: typeof User; text: string; stroke: string; ring: string }> = {
  isaac: { icon: User, text: "text-sky-400", stroke: "stroke-sky-400", ring: "border-sky-400/60" },
  gh: { icon: GitPullRequest, text: "text-emerald-400", stroke: "stroke-emerald-400", ring: "border-emerald-400/60" },
  slack: { icon: Hash, text: "text-amber-400", stroke: "stroke-amber-400", ring: "border-amber-400/60" },
};

const GAP = 160;
const snaps = ["Events → Objectives", "Objectives → Routers", "Routers → Agents"];

type Edge = { key: string; from: string; to: string; stroke: string; watch?: boolean };
type Pos = Record<string, { l: number; r: number; y: number }>;
type Path = ReturnType<typeof pathOf>;

function when(at: string) {
  const d = new Date(at);
  return at.slice(0, 10) === NOW_AT.slice(0, 10)
    ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function day(at: string) {
  if (at.slice(0, 10) === NOW_AT.slice(0, 10)) return "Today";
  return new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function buildEdges(signals: Signal[], paths: Map<string, Path>, agents: Agent[]) {
  const edges: Edge[] = [];
  for (const s of signals)
    for (const o of paths.get(s.id)!.objectives)
      edges.push({ key: `sig:${s.id}>obj:${o}`, from: `sig:${s.id}`, to: `obj:${o}`, stroke: look[s.source].stroke });
  for (const a of agents) {
    if (a.role === "router") edges.push({ key: `obj:${a.objectiveId}>router:${a.id}`, from: `obj:${a.objectiveId}`, to: `router:${a.id}`, stroke: "stroke-fuchsia-400" });
    else edges.push({ key: `router:${a.parent}>agent:${a.id}`, from: `router:${a.parent}`, to: `agent:${a.id}`, stroke: "stroke-agent" });
  }
  const objectiveOf = new Map(agents.map(a => [a.id, a.objectiveId]));
  for (const sentry of sentries)
    for (const o of new Set(sentry.watching.flatMap(w => w.routedTo).map(id => objectiveOf.get(id)!).filter(Boolean)))
      edges.push({ key: `src:${sentry.id}~obj:${o}`, from: `src:${sentry.id}`, to: `obj:${o}`, stroke: look[sentry.id].stroke, watch: true });
  return edges;
}

/** Light everything upstream and downstream of the focused node along the routes signals actually took. */
function trace(focus: string, signals: Signal[], paths: Map<string, Path>, agents: Agent[]) {
  const lit = new Set<string>();
  const byId = new Map(agents.map(a => [a.id, a]));
  const routerEdge = (r: string) => lit.add(`obj:${byId.get(r)!.objectiveId}>router:${r}`);
  const agentEdge = (a: string) => lit.add(`router:${byId.get(a)!.parent}>agent:${a}`);
  const fullPath = (s: Signal) => {
    const p = paths.get(s.id)!;
    p.objectives.forEach(o => lit.add(`sig:${s.id}>obj:${o}`));
    p.routers.forEach(routerEdge);
    p.agents.forEach(agentEdge);
  };
  const into = (s: Signal, o: string) => lit.add(`sig:${s.id}>obj:${o}`);

  const [kind, id] = [focus.slice(0, focus.indexOf(":")), focus.slice(focus.indexOf(":") + 1)];
  if (kind === "sig") fullPath(signals.find(s => s.id === id)!);
  if (kind === "src") {
    signals.filter(s => s.source === id).forEach(fullPath);
    const watched = sentries.find(x => x.id === id)!.watching.flatMap(w => w.routedTo);
    for (const o of new Set(watched.map(a => byId.get(a)?.objectiveId).filter(Boolean))) lit.add(`src:${id}~obj:${o}`);
  }
  if (kind === "obj") {
    agents.filter(a => a.objectiveId === id).forEach(a => (a.role === "router" ? routerEdge(a.id) : agentEdge(a.id)));
    signals.filter(s => paths.get(s.id)!.objectives.includes(id)).forEach(s => into(s, id));
  }
  if (kind === "router" || kind === "agent") {
    const agent = byId.get(id)!;
    const router = agent.role === "router" ? agent : byId.get(agent.parent!)!;
    routerEdge(router.id);
    if (agent.role === "router") agents.filter(w => w.parent === id).forEach(w => agentEdge(w.id));
    else agentEdge(id);
    const list = kind === "router" ? "routers" : "agents";
    signals.filter(s => paths.get(s.id)![list].includes(id)).forEach(s => into(s, router.objectiveId));
  }
  const nodes = new Set([focus, ...[...lit].flatMap(k => k.split(/[>~]/))]);
  return { lit, nodes };
}

function lastSnap() {
  try {
    return Number(sessionStorage.getItem("routing-snap") ?? 0);
  } catch {
    return 0;
  }
}

export function RoutingView() {
  const signals = signalStore.use();
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const tasks = taskStore.use();
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [snap, setSnap] = useState(lastSnap);
  const [pos, setPos] = useState<Pos>({});
  const [pinned, setPinned] = useState<string>();
  const [hover, setHover] = useState<string>();
  const [shown, setShown] = useState<Set<Source>>(new Set(["isaac", "gh", "slack"]));
  const [draft, setDraft] = useState("");
  const [fresh, setFresh] = useState<string>();
  const [splitting, setSplitting] = useState<string>();
  const [scope, setScope] = useState("");

  const col = Math.max(320, (width - GAP) / 2);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const base = canvas.getBoundingClientRect();
    const next: Pos = {};
    canvas.querySelectorAll<HTMLElement>("[data-node]").forEach(el => {
      const r = el.getBoundingClientRect();
      next[el.dataset.node!] = { l: r.left - base.left, r: r.right - base.left, y: r.top - base.top + r.height / 2 };
    });
    setPos(next);
  }, []);

  const visible = signals.filter(s => shown.has(s.source));

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => {
      setWidth(viewportRef.current!.clientWidth);
      measure();
    });
    ro.observe(viewportRef.current!);
    return () => ro.disconnect();
  }, [measure]);

  useLayoutEffect(measure, [measure, visible.length, agents.length, col, splitting]);

  const go = useCallback((n: number) => {
    const next = Math.max(0, Math.min(snaps.length - 1, n));
    setSnap(next);
    try {
      sessionStorage.setItem("routing-snap", String(next));
    } catch {}
  }, []);

  const snapRef = useRef(snap);
  snapRef.current = snap;

  /** One sideways swipe moves one view; trackpad momentum after it is swallowed until the swipe goes quiet. */
  useEffect(() => {
    const viewport = viewportRef.current!;
    let pushed = 0;
    let spent = false;
    let lastAt = 0;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastAt > 200) {
        pushed = 0;
        spent = false;
      }
      lastAt = now;
      if (spent) return;
      pushed += e.deltaX;
      if (Math.abs(pushed) < 60) return;
      go(snapRef.current + Math.sign(pushed));
      spent = true;
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight") go(snap + 1);
      if (e.key === "ArrowLeft") go(snap - 1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [go, snap]);

  const paths = new Map(signals.map(s => [s.id, pathOf(s, agents)]));
  const edges = buildEdges(visible, paths, agents).filter(e => !e.watch || shown.has(e.from.slice(4) as Source));
  const focus = hover ?? pinned;
  const traced = focus ? trace(focus, visible, paths, agents) : undefined;
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

  const pinnedAgent = pinned?.match(/^(router|agent):(.+)$/)?.[2];
  const pinnedObjective = pinned?.startsWith("obj:") ? pinned.slice(4) : undefined;
  const to = pinnedAgent ?? agents.find(a => a.role === "router" && a.objectiveId === pinnedObjective)?.id;

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setShown(prev => new Set([...prev, "isaac"]));
    setFresh(routeChat(text, to));
    setDraft("");
  }

  function split(e: React.FormEvent, objectiveId: string) {
    e.preventDefault();
    if (!scope.trim()) return;
    setFresh(splitRouter(objectiveId, scope.trim()));
    setSplitting(undefined);
    setScope("");
    go(1);
  }

  const days = [...new Set(visible.map(s => day(s.at)))];
  const routers = agents.filter(a => a.role === "router");

  const faded = (index: number) => index !== snap && index !== snap + 1;
  const capture = (index: number) => (e: React.MouseEvent) => {
    if (!faded(index)) return;
    e.stopPropagation();
    e.preventDefault();
    go(index > snap ? index - 1 : index);
  };

  const column = (index: number, title: string, count: number, children: React.ReactNode, onScroll = true) => {
    return (
      <section
        className={cn("relative flex min-h-0 shrink-0 flex-col gap-3 transition-opacity duration-500", faded(index) && "opacity-35")}
        style={{ width: col }}
        onClickCapture={capture(index)}
      >
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          {title}
          <span className="text-xs text-muted-foreground">{count}</span>
        </h2>
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1" onScroll={onScroll ? measure : undefined}>
          {children}
        </div>
      </section>
    );
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4" onClick={() => setPinned(undefined)}>
      <div className="flex items-center gap-4">
        <Tabs value={String(snap)} onValueChange={v => go(Number(v))}>
          <TabsList>
            {snaps.map((label, i) => (
              <TabsTrigger key={label} value={String(i)} data-agent={`snap:${i}`} onClick={e => e.stopPropagation()}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">swipe sideways or ← → to pan · hover or click to trace · click a source to filter</span>
      </div>

      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={canvasRef}
          className="relative flex h-full transition-transform duration-500 ease-in-out"
          style={{ gap: GAP, width: col * 4 + GAP * 3, transform: `translateX(${-snap * (col + GAP)}px)` }}
        >
          <svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
            {edges.map(e => {
              if (e.from.startsWith("router:")) return null;
              const a = e.watch ? pos.log : pos[e.from];
              const b = pos[e.to];
              if (!a || !b) return null;
              const on = traced?.lit.has(e.key);
              if (e.watch && !on) return null;
              const x1 = a.r, x2 = b.l, mid = (x1 + x2) / 2;
              return (
                <path
                  key={e.key}
                  d={`M${x1},${a.y} C${mid},${a.y} ${mid},${b.y} ${x2},${b.y}`}
                  className={cn("fill-none transition-opacity", e.stroke, on ? "opacity-90" : traced ? "opacity-5" : "opacity-30")}
                  strokeWidth={on ? 1.75 : 1}
                  strokeDasharray={e.watch ? "4 4" : undefined}
                />
              );
            })}
          </svg>

          {column(
            0,
            "Event log",
            visible.length,
            <>
              <div data-node="log" className="flex flex-wrap items-center gap-2">
                {sentries.map(s => {
                  const Icon = look[s.id].icon;
                  const id = `src:${s.id}`;
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
                        shown.has(s.id) ? look[s.id].ring : "opacity-40",
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
              </div>
              <form
                onSubmit={send}
                onClick={e => e.stopPropagation()}
                className="flex items-center gap-3 rounded-lg border border-sky-400/40 bg-card px-3 py-1.5 focus-within:border-sky-400"
              >
                <User className="size-3.5 shrink-0 text-sky-400" />
                <span className="max-w-28 shrink-0 truncate font-mono text-xs text-muted-foreground">{to ? `→ ${to}` : "chat"}</span>
                <Input
                  data-agent="log-composer"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  placeholder={to ? `Message ${to}…` : "Tell the agents something…"}
                  className="h-7 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
                />
                <kbd className="shrink-0 text-xs text-muted-foreground">↵</kbd>
              </form>
              {days.map(d => (
                <div key={d}>
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
                          {s.routedTo.length === 0 && <span className="shrink-0 text-xs text-amber-400">unrouted</span>}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))}
            </>,
          )}

          {column(
            1,
            "Objectives",
            objectives.length,
            objectives.map(o => {
              const id = `obj:${o.id}`;
              const own = tasks.filter(t => o.taskIds.includes(t.id));
              const status = objectiveStatus(own.map(t => t.status));
              const vision = o.page.find(b => b.kind === "vision");
              const count = routers.filter(r => r.objectiveId === o.id).length;
              return (
                <Card key={o.id} {...node(id)} className={cn("cursor-pointer gap-2 px-4 py-3 transition-opacity", dim(id) && "opacity-30", focus === id && "border-agent")}>
                  <div className="flex items-center gap-2">
                    <Waypoints className="size-4 shrink-0 text-agent" />
                    <span className="truncate font-medium">{o.title}</span>
                    <a href={`#objective/${o.id}`} data-agent={`objective:${o.id}`} onClick={e => e.stopPropagation()} className="ml-auto text-muted-foreground hover:text-foreground">
                      <SquareArrowOutUpRight className="size-3.5" />
                    </a>
                  </div>
                  {vision?.kind === "vision" && <p className="line-clamp-2 text-xs text-muted-foreground">{vision.goal}</p>}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className={cn("size-1.5 rounded-full", statusColor[status])} />
                    {status} · {own.filter(t => t.status === "done").length}/{own.length} tasks
                    <Badge variant="outline" className="ml-auto text-[10px]">
                      {count === 1 ? "1 router" : `split · ${count} routers`}
                    </Badge>
                  </div>
                  {splitting === o.id ? (
                    <form onSubmit={e => split(e, o.id)} onClick={e => e.stopPropagation()}>
                      <Input
                        autoFocus
                        value={scope}
                        onChange={e => setScope(e.target.value)}
                        onKeyDown={e => e.key === "Escape" && setSplitting(undefined)}
                        placeholder="Subcomponent the new router owns…"
                        className="h-7 text-xs"
                      />
                    </form>
                  ) : (
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        setSplitting(o.id);
                      }}
                      className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Plus className="size-3" /> Split router
                    </button>
                  )}
                </Card>
              );
            }),
          )}

          <section className="relative flex min-h-0 shrink-0 flex-col gap-3" style={{ width: col * 2 + GAP }}>
            <div className="flex" style={{ gap: GAP }}>
              {(["Routers", "Agents"] as const).map((title, k) => (
                <h2 key={title} className={cn("flex items-baseline gap-2 text-sm font-medium transition-opacity duration-500", faded(2 + k) && "opacity-35")} style={{ width: col }}>
                  {title}
                  <span className="text-xs text-muted-foreground">{k === 0 ? routers.length : agents.length - routers.length}</span>
                </h2>
              ))}
            </div>
            <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1" onScroll={measure}>
              {objectives.map(o => (
                <div key={o.id} className="flex flex-col gap-1.5">
                  <p className={cn("flex items-center gap-1.5 px-1 text-xs text-muted-foreground transition-opacity duration-500", faded(2) && "opacity-35")} style={{ width: col }}>
                    <Waypoints className="size-3 text-agent" />
                    {o.title}
                  </p>
                  {routers.filter(r => r.objectiveId === o.id).map(r => {
                    const id = `router:${r.id}`;
                    const crew = agents.filter(w => w.parent === r.id);
                    return (
                      <div key={r.id} className="flex items-start" style={{ gap: GAP }}>
                        <div className={cn("shrink-0 transition-opacity duration-500", faded(2) && "opacity-35")} style={{ width: col }} onClickCapture={capture(2)}>
                          <Card
                            {...node(id)}
                            className={cn(
                              "cursor-pointer gap-1 border-fuchsia-400/30 px-3 py-2.5 transition-opacity",
                              dim(id) && "opacity-30",
                              focus === id && "border-fuchsia-400",
                              fresh === r.id && "agent-edited animate-in fade-in zoom-in-95",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <Network className="size-3.5 text-fuchsia-400" />
                              <span className="font-mono text-xs">{r.id}</span>
                              <span className={cn("size-1.5 rounded-full", agentStateColor[r.state])} />
                              <span className="ml-auto text-xs text-muted-foreground">{crew.length} {crew.length === 1 ? "agent" : "agents"}</span>
                            </div>
                            <p className="text-sm">{r.scope}</p>
                            <p className="truncate text-xs text-muted-foreground">{r.doing}</p>
                          </Card>
                        </div>
                        <div className={cn("flex shrink-0 flex-col gap-1.5 transition-opacity duration-500", faded(3) && "opacity-35")} style={{ width: col }} onClickCapture={capture(3)}>
                          {crew.length === 0 && (
                            <p className={cn("rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground transition-opacity", dim(id) && "opacity-30")}>
                              No agents yet. {r.id} spawns them when work is ready.
                            </p>
                          )}
                          {crew.map(w => {
                            const wid = `agent:${w.id}`;
                            const task = tasks.find(t => w.taskIds.includes(t.id) && t.status !== "done") ?? tasks.find(t => t.id === w.taskIds.at(-1));
                            return (
                              <Card key={w.id} {...node(wid)} className={cn("cursor-pointer gap-1 px-3 py-2.5 transition-opacity", dim(wid) && "opacity-30", focus === wid && "border-agent")}>
                                <div className="flex items-center gap-2">
                                  <span className={cn("size-2 rounded-full", agentStateColor[w.state], w.state === "working" && "animate-pulse")} />
                                  <span className="font-mono text-xs">{w.id}</span>
                                  <span className="ml-auto text-xs text-muted-foreground">{w.state}</span>
                                </div>
                                <p className="truncate text-xs text-muted-foreground">{w.doing}</p>
                                {task && (
                                  <a href={`#task/${task.id}`} onClick={e => e.stopPropagation()} className="flex items-center gap-1.5 truncate text-xs hover:underline">
                                    <span className={cn("size-1.5 shrink-0 rounded-full", statusColor[task.status])} />
                                    {task.title}
                                  </a>
                                )}
                              </Card>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
