import { Bot, ChevronLeft, ChevronRight, GitPullRequest, Hash, MessagesSquare, Network, Plus, Radar, Search, SquareArrowOutUpRight, User, Waypoints } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { routeChat } from "@/agent/route";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";
import { ChipView, SearchPalette, hits, isActive, type Filter, type NodeMeta } from "@/views/SearchPalette";
import { NOW_AT, agentStateColor, objectiveStatus, statusColor, type Agent, type Signal, type Source, type Thread } from "@/mock";
import { EventDrawer } from "@/views/EventDrawer";
import { agentStore, objectiveStore, pathOf, signalStore, sourceStore, splitRouter, taskStore, threadStore } from "@/store";
import { Rich } from "@/threads/Rich";

const look: Record<Source, { icon: typeof User; text: string; ring: string }> = {
  isaac: { icon: User, text: "text-link", ring: "border-link/60" },
  gh: { icon: GitPullRequest, text: "text-ok", ring: "border-ok/60" },
  slack: { icon: Hash, text: "text-command", ring: "border-command/60" },
  agent: { icon: Bot, text: "text-agent", ring: "border-agent/60" },
  sentry: { icon: Radar, text: "text-warn", ring: "border-warn/60" },
  maxflow: { icon: Waypoints, text: "text-muted-foreground", ring: "border-muted-foreground/60" },
};

const GAP = 160;
const VIEWS = 4;
/** Threads reuse the agents' slot: both views show routers on the left. */
const paneOf = (snap: number) => Math.min(snap, 2);

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

/** Everything upstream and downstream of a node along the routes signals actually took. */
function trace(focus: string, signals: Signal[], paths: Map<string, Path>, agents: Agent[]) {
  const sentries = sourceStore.get();
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
    const watched = sentries.find(x => x.id === id)?.watching.flatMap(w => w.routedTo) ?? [];
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
  return { nodes };
}

const ROW_GAP = 20;
const STACK_GAP = 6;

/**
 * Where each card in the objectives, routers and agents columns sits for a view. Each pair of columns in view
 * is laid out as rows: a parent beside its stacked children, top-aligned, so a big stack pushes the next row down.
 */
function layoutStructure(
  snap: number,
  objectives: { id: string }[],
  routers: Agent[],
  agents: Agent[],
  threads: Thread[],
  height: (id: string) => number,
  shown: (id: string) => boolean,
) {
  const y = new Map<string, number>();
  const bottom = { compact: 0, objectiveRows: 0, agentRows: 0, threadRows: 0 };

  const byObjective = () => {
    let top = 0;
    for (const o of objectives) {
      const own = routers.filter(r => r.objectiveId === o.id && shown(`router:${r.id}`));
      const showObjective = shown(`obj:${o.id}`);
      if (!showObjective && !own.length) continue;
      if (showObjective) y.set(`obj:${o.id}`, top);
      let stack = top;
      for (const r of own) {
        y.set(`router:${r.id}`, stack);
        stack += height(`router:${r.id}`) + STACK_GAP;
      }
      top = Math.max(top + (showObjective ? height(`obj:${o.id}`) : 0), stack - STACK_GAP) + ROW_GAP;
    }
    bottom.objectiveRows = top;
  };

  const byRouter = (placeRouters: boolean, stackOf: (routerId: string) => string[], into: "agentRows" | "threadRows") => {
    let top = 0;
    for (const o of objectives) {
      let any = false;
      for (const r of routers.filter(r => r.objectiveId === o.id)) {
        const showRouter = placeRouters && shown(`router:${r.id}`);
        const stackIds = stackOf(r.id);
        if (!showRouter && !stackIds.length) continue;
        any = true;
        if (showRouter) y.set(`router:${r.id}`, top);
        let stack = top;
        for (const id of stackIds) {
          y.set(id, stack);
          stack += height(id) + STACK_GAP;
        }
        top = Math.max(top + (showRouter ? height(`router:${r.id}`) : 0), stack - STACK_GAP) + STACK_GAP * 2;
      }
      if (any) top += ROW_GAP - STACK_GAP * 2;
    }
    bottom[into] = top;
  };

  byObjective();
  if (snap === 0) {
    let top = 0;
    for (const o of objectives.filter(o => shown(`obj:${o.id}`))) {
      y.set(`obj:${o.id}`, top);
      top += height(`obj:${o.id}`) + STACK_GAP * 2;
    }
    bottom.compact = top;
  }
  byRouter(snap === 2, id => crewOf(id, agents, shown), "agentRows");
  byRouter(snap === 3, id => threadsOf(id, threads, shown), "threadRows");

  const inView = [bottom.compact, bottom.objectiveRows, bottom.agentRows, bottom.threadRows][snap]!;
  return { y, height: inView };
}

/** The cards in a router's agent stack: its shown agents, or a placeholder when it has none at all. */
function crewOf(routerId: string, agents: Agent[], shown: (id: string) => boolean) {
  const all = agents.filter(w => w.parent === routerId);
  if (!all.length) return shown(`empty:${routerId}`) ? [`empty:${routerId}`] : [];
  return all.map(w => `agent:${w.id}`).filter(shown);
}

/** A thread sits beside the first router that posts to it. */
function threadsOf(routerId: string, threads: Thread[], shown: (id: string) => boolean) {
  const own = threads.filter(t => t.routerIds[0] === routerId);
  if (!own.length) return shown(`nothreads:${routerId}`) ? [`nothreads:${routerId}`] : [];
  return own.map(t => `thread:${t.id}`).filter(shown);
}

export function RoutingView({ snap, onSnap: go }: { snap: number; onSnap: (n: number) => void }) {
  const threads = threadStore.use();
  const signals = signalStore.use();
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const tasks = taskStore.use();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const sentries = sourceStore.use();
  const [shown, setShown] = useState<Set<Source>>(new Set(["isaac", "gh", "slack", "agent", "sentry", "maxflow"]));
  const [draft, setDraft] = usePersistentDraft("log-composer");
  const [fresh, setFresh] = useState<string>();
  const [reading, setReading] = useState<string>();
  const closeReading = useCallback(() => setReading(undefined), []);
  const [splitting, setSplitting] = useState<string>();
  const [scope, setScope] = useState("");

  const col = Math.max(320, (width - GAP) / 2);

  const [filter, setFilter] = useState<Filter>({ chips: [], text: "" });
  const [palette, setPalette] = useState(false);

  const paths = new Map(signals.map(s => [s.id, pathOf(s, agents)]));
  const statusOfTask = new Map(tasks.map(t => [t.id, t.status]));
  const objectiveOfAgent = new Map(agents.map(a => [a.id, a.objectiveId]));
  const nodes: NodeMeta[] = [
    ...signals.map(s => ({
      id: `sig:${s.id}`,
      kind: "event" as const,
      label: s.target,
      detail: s.text,
      text: `${s.text} ${s.target}`,
      source: s.source,
      objectives: paths.get(s.id)!.objectives,
    })),
    ...objectives.map(o => {
      const vision = o.page.find(b => b.kind === "vision");
      const goal = vision?.kind === "vision" ? vision.goal : "";
      return {
        id: `obj:${o.id}`,
        kind: "objective" as const,
        label: o.id,
        detail: o.title,
        text: `${o.title} ${o.id} ${goal}`,
        status: objectiveStatus(o.taskIds.map(t => statusOfTask.get(t)!).filter(Boolean)),
        objectives: [o.id],
      };
    }),
    ...agents.map(a => {
      const task = tasks.find(t => a.taskIds.includes(t.id));
      return {
        id: `${a.role === "router" ? "router" : "agent"}:${a.id}`,
        kind: a.role === "router" ? ("router" as const) : ("agent" as const),
        label: a.name ?? a.id,
        detail: a.role === "router" ? `${a.scope} · ${a.doing}` : `${a.doing}${task ? ` · ${task.title}` : ""}`,
        text: `${a.id} ${a.name ?? ""} ${a.scope ?? ""} ${a.doing} ${task?.title ?? ""} ${task?.pr ?? ""}`,
        state: a.state,
        status: task?.status,
        objectives: [objectiveOfAgent.get(a.id)!],
      };
    }),
    ...threads.map(t => ({
      id: `thread:${t.id}`,
      kind: "thread" as const,
      label: t.routerIds.join(", "),
      detail: t.title,
      text: `${t.title} ${t.messages.map(m => m.text).join(" ")}`,
      objectives: [t.objectiveId],
    })),
  ];

  // A filter keeps each hit plus everything wired to it, so whole routes survive.
  const filterHits = isActive(filter) ? hits(nodes, filter) : undefined;
  const kept =
    filterHits &&
    new Set(
      filterHits.flatMap(n => {
        if (n.kind !== "thread") return [n.id, ...trace(n.id, signals, paths, agents).nodes];
        const t = threads.find(x => `thread:${x.id}` === n.id)!;
        return [n.id, `obj:${t.objectiveId}`, ...t.routerIds.map(r => `router:${r}`)];
      }),
    );
  const shownNode = (id: string) => {
    if (!kept || kept.has(id)) return true;
    const t = id.startsWith("thread:") && threads.find(x => `thread:${x.id}` === id);
    return !!t && t.routerIds.some(r => kept.has(`router:${r}`));
  };

  const visible = signals.filter(s => shown.has(s.source) && shownNode(`sig:${s.id}`));

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setWidth(viewportRef.current!.clientWidth));
    ro.observe(viewportRef.current!);
    return () => ro.disconnect();
  }, []);

  const snapRef = useRef(snap);
  snapRef.current = snap;
  const goRef = useRef(go);
  goRef.current = go;

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
      goRef.current(snapRef.current + Math.sign(pushed));
      spent = true;
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "/") {
        e.preventDefault();
        setPalette(true);
      }
      if (e.key === "ArrowRight") go(snap + 1);
      if (e.key === "ArrowLeft") go(snap - 1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [go, snap]);

  const node = (id: string) => ({ "data-node": id });
  const open = (hash: string) => () => (location.hash = hash);

  // One type at a time, like a dropdown: a type shows only its events, and clicking it again shows them all.
  const toggle = (source: Source) =>
    setShown(prev => (prev.size === 1 && prev.has(source) ? new Set(sentries.map(s => s.id)) : new Set([source])));

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setShown(prev => new Set([...prev, "isaac"]));
    setFresh(routeChat(text));
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

  const pane = paneOf(snap);
  const faded = (index: number) => index !== pane && index !== pane + 1;
  const capture = (index: number) => (e: React.MouseEvent) => {
    if (!faded(index)) return;
    e.stopPropagation();
    e.preventDefault();
    go(index > pane ? index - 1 : index);
  };

  const heights = useRef(new Map<string, number>());
  const [, setHeightsVersion] = useState(0);
  const sizer = useRef<ResizeObserver>(undefined);
  sizer.current ??= new ResizeObserver(entries => {
    let changed = false;
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.place!;
      const h = Math.round(entry.contentRect.height);
      if (heights.current.get(id) !== h) {
        heights.current.set(id, h);
        changed = true;
      }
    }
    if (changed) setHeightsVersion(v => v + 1);
  });

  const placed = layoutStructure(snap, objectives, routers, agents, threads, id => heights.current.get(id) ?? 96, shownNode);

  const place = (id: string, column: number, card: React.ReactNode, only?: "agents" | "threads") => {
    const away = (only === "threads" && snap !== 3) || (only === "agents" && snap === 3);
    return (
    <div
      key={id}
      data-place={id}
      ref={el => {
        if (el) sizer.current!.observe(el);
      }}
      onClickCapture={capture(1 + column)}
      className={cn(
        "absolute top-0 transition-[transform,opacity] duration-500 ease-in-out",
        away ? "pointer-events-none opacity-0" : faded(1 + column) && "opacity-35",
      )}
      style={{ width: col, left: column * (col + GAP), transform: `translateY(${placed.y.get(id) ?? 0}px)` }}
    >
      {card}
    </div>
    );
  };

  const threadCard = (t: Thread) => {
    const last = t.messages.at(-1);
    return (
      <Card {...node(`thread:${t.id}`)} onClick={open(`thread/${t.id}`)} className="cursor-pointer gap-1.5 px-3 py-2.5 hover:border-ring">
        <div className="flex items-center gap-2">
          <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{t.title}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t.messages.length}</span>
        </div>
        {last && <Rich text={last.text} className="line-clamp-2 text-xs text-muted-foreground" />}
        {t.routerIds.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {t.routerIds.map(r => (
              <span key={r} className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                <Network className="size-2.5 text-router" />
                {r}
              </span>
            ))}
          </div>
        )}
      </Card>
    );
  };

  const objectiveCard = (o: (typeof objectives)[number]) => {
    const id = `obj:${o.id}`;
    const own = tasks.filter(t => o.taskIds.includes(t.id));
    const status = objectiveStatus(own.map(t => t.status));
    const count = routers.filter(r => r.objectiveId === o.id).length;
    return (
      <Card {...node(id)} data-agent={`objective:${o.id}`} onClick={open(`objective/${o.id}`)} className="cursor-pointer gap-2 px-4 py-3 hover:border-ring">
        <div className="flex items-center gap-2">
          <Waypoints className="size-4 shrink-0 text-agent" />
          <span className="truncate font-medium">{o.title}</span>
          <SquareArrowOutUpRight className="ml-auto size-3.5 text-muted-foreground" />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", statusColor[status])} />
          {status} · {own.filter(t => t.status === "done").length}/{own.length} tasks
          <Badge variant="outline" className="ml-auto text-[10px]">
            {count} {count === 1 ? "router" : "routers"}
          </Badge>
        </div>
        {splitting === o.id ? (
          <form onSubmit={e => split(e, o.id)} onClick={e => e.stopPropagation()}>
            <Input
              autoFocus
              value={scope}
              onChange={e => setScope(e.target.value)}
              onKeyDown={e => e.key === "Escape" && setSplitting(undefined)}
              placeholder="Scope"
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
  };

  const routerCard = (r: Agent) => {
    const id = `router:${r.id}`;
    const crew = agents.filter(w => w.parent === r.id).length;
    return (
      <Card
        {...node(id)}
        onClick={open(`agent/${r.id}`)}
        className={cn(
          "cursor-pointer gap-1 border-router/30 px-3 py-2.5 hover:border-router",
          fresh === r.id && "agent-edited animate-in fade-in zoom-in-95",
        )}
      >
        <div className="flex items-center gap-2">
          <Network className="size-3.5 text-router" />
          <span className={cn("truncate text-xs", !r.name && "font-mono")}>{r.name ?? r.id}</span>
          <span className={cn("size-1.5 rounded-full", agentStateColor[r.state])} />
          <span className="ml-auto text-xs text-muted-foreground">{crew} {crew === 1 ? "agent" : "agents"}</span>
        </div>
        <p className="text-sm">{r.scope}</p>
      </Card>
    );
  };

  const agentCard = (w: Agent) => {
    const id = `agent:${w.id}`;
    const task = tasks.find(t => w.taskIds.includes(t.id) && t.status !== "done") ?? tasks.find(t => t.id === w.taskIds.at(-1));
    return (
      <Card {...node(id)} onClick={open(`agent/${w.id}`)} className="cursor-pointer gap-1 px-3 py-2.5 hover:border-ring">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", agentStateColor[w.state], w.state === "working" && "animate-pulse")} />
          <span className={cn("truncate text-xs", !w.name && "font-mono")}>{w.name ?? w.id}</span>
          <span className="ml-auto text-xs text-muted-foreground">{w.state}</span>
        </div>
        {task && (
          <a href={`#task/${task.id}`} onClick={e => e.stopPropagation()} className="flex items-center gap-1.5 truncate text-xs hover:underline">
            <span className={cn("size-1.5 shrink-0 rounded-full", statusColor[task.status])} />
            {task.title}
          </a>
        )}
      </Card>
    );
  };

  const emptyCard = (r: Agent) => (
    <p className={cn("rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground transition-opacity")}>
      No agents
    </p>
  );

  const pick = (n: NodeMeta) => {
    setPalette(false);
    go({ event: 0, objective: 1, router: 1, agent: 2, thread: 3 }[n.kind]);
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-node="${n.id}"]`);
      const scroller = el?.closest<HTMLElement>(".overflow-y-auto");
      if (!el || !scroller) return;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
    }, 560);
  };

  const counted = (shownCount: number, total: number) => (shownCount === total ? `${total}` : `${shownCount}/${total}`);

  const column = (index: number, title: string, count: number, children: React.ReactNode) => {
    return (
      <section
        className={cn("relative flex min-h-0 shrink-0 flex-col gap-3 transition-opacity duration-500", faded(index) && "opacity-35")}
        style={{ width: col }}
        onClickCapture={capture(index)}
      >
        <h2 className="flex h-7 items-center gap-2 text-sm font-medium">
          {title}
          <span className="text-xs text-muted-foreground">{counted(count, signals.length)}</span>
        </h2>
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
          {children}
        </div>
      </section>
    );
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {isActive(filter) && (
      <div className="flex items-center gap-4">
        {isActive(filter) && (
          <div
            role="button"
            onClick={e => {
              e.stopPropagation();
              setPalette(true);
            }}
            className="flex cursor-pointer flex-wrap items-center gap-1 text-sm"
          >
            <Search className="mr-1 size-3.5 text-muted-foreground" />
            {filter.chips.map((c, i) => (
              <ChipView key={i} chip={c} onRemove={() => setFilter(f => ({ ...f, chips: f.chips.filter((_, j) => j !== i) }))} />
            ))}
            {filter.text && <span>{filter.text}</span>}
          </div>
        )}
        {filterHits && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {filterHits.length}
            <button onClick={() => setFilter({ chips: [], text: "" })} className="underline hover:text-foreground">
              clear
            </button>
          </span>
        )}
      </div>
      )}

      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute top-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 gap-1" style={{ left: col + GAP / 2 }}>
          {[
            [-1, ChevronLeft, "Previous view"],
            [1, ChevronRight, "Next view"],
          ].map(([step, Icon, label]) => {
            const Chevron = Icon as typeof ChevronLeft;
            const to = snap + (step as number);
            return (
              <button
                key={label as string}
                aria-label={label as string}
                data-agent={`pan:${step}`}
                disabled={to < 0 || to >= VIEWS}
                onClick={e => {
                  e.stopPropagation();
                  go(to);
                }}
                className="flex size-8 items-center justify-center border bg-background text-muted-foreground hover:border-ring hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
              >
                <Chevron className="size-4" />
              </button>
            );
          })}
        </div>
        <div
          className="relative flex h-full transition-transform duration-500 ease-in-out"
          style={{ gap: GAP, width: col * 4 + GAP * 3, transform: `translateX(${-pane * (col + GAP)}px)` }}
        >
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
                      )}
                    >
                      <Icon className={cn("size-3.5", look[s.id].text)} />
                      {s.label}
                      <span className={cn("size-1.5 rounded-full", s.state === "backoff" ? "bg-warn" : "animate-pulse bg-ok")} />
                      <span className="text-muted-foreground">{s.state === "live" ? "live" : `${s.state} · ${s.every}`}</span>
                    </button>
                  );
                })}
              </div>
              <form
                onSubmit={send}
                onClick={e => e.stopPropagation()}
                className="flex items-center gap-3 rounded-lg border border-link/40 bg-card px-3 py-1.5 focus-within:border-link"
              >
                <User className="size-3.5 shrink-0 text-link" />
                <span className="max-w-28 shrink-0 truncate font-mono text-xs text-muted-foreground">chat</span>
                <Input
                  data-agent="log-composer"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  placeholder="Message"
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
                          onClick={() => setReading(s.id)}
                          className={cn(
                            "flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm hover:border-ring",
                            reading === s.id && "border-ring",
                            fresh === s.id && "agent-edited animate-in fade-in slide-in-from-top-2",
                          )}
                        >
                          <span className="w-11 shrink-0 text-xs text-muted-foreground tabular-nums">{when(s.at)}</span>
                          <Icon className={cn("size-3.5 shrink-0", look[s.source].text)} />
                          <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">{s.target}</span>
                          <span className="min-w-0 flex-1 truncate">{s.text}</span>
                          {s.routedTo.length === 0 && <span className="shrink-0 text-xs text-warn">unrouted</span>}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))}
            </>,
          )}

          <section className="relative flex min-h-0 shrink-0 flex-col gap-3" style={{ width: col * 3 + GAP * 2 }}>
            <div className="flex" style={{ gap: GAP }}>
              {(
                [
                  ["Objectives", "obj", objectives.map(o => `obj:${o.id}`)],
                  ["Routers", "router", routers.map(r => `router:${r.id}`)],
                  snap === 3
                    ? ["Threads", "thread", threads.map(t => `thread:${t.id}`)]
                    : ["Agents", "agent", agents.filter(a => a.role === "worker").map(a => `agent:${a.id}`)],
                ] as const
              ).map(([title, , ids], k) => (
                <h2 key={title} className={cn("flex h-7 items-center gap-2 text-sm font-medium transition-opacity duration-500", faded(1 + k) && "opacity-35")} style={{ width: col }}>
                  {title}
                  <span className="text-xs text-muted-foreground">{counted(ids.filter(shownNode).length, ids.length)}</span>
                </h2>
              ))}
            </div>
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              <div data-structure className="relative overflow-hidden" style={{ height: placed.height }}>
                {objectives.filter(o => shownNode(`obj:${o.id}`)).map(o => place(`obj:${o.id}`, 0, objectiveCard(o)))}
                {routers.filter(r => shownNode(`router:${r.id}`)).map(r => place(`router:${r.id}`, 1, routerCard(r)))}
                {routers.flatMap(r =>
                  crewOf(r.id, agents, shownNode).map(id =>
                    id.startsWith("empty:") ? place(id, 2, emptyCard(r), "agents") : place(id, 2, agentCard(agents.find(a => `agent:${a.id}` === id)!), "agents"),
                  ),
                )}
                {routers.flatMap(r =>
                  threadsOf(r.id, threads, shownNode).map(id =>
                    id.startsWith("nothreads:")
                      ? place(id, 2, <p className="border border-dashed px-3 py-2 text-xs text-muted-foreground">No threads</p>, "threads")
                      : place(id, 2, threadCard(threads.find(t => `thread:${t.id}` === id)!), "threads"),
                  ),
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
      <div onClick={e => e.stopPropagation()}>
        <EventDrawer signal={signals.find(x => x.id === reading)} onClose={closeReading} />
      </div>
      <div onClick={e => e.stopPropagation()}>
        <SearchPalette
        open={palette}
        onOpenChange={setPalette}
        nodes={nodes}
        objectiveIds={objectives.map(o => o.id)}
        filter={filter}
        onFilter={setFilter}
        onPick={pick}
        />
      </div>
    </div>
  );
}
