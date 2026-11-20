import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useCallback, useState } from "react";
import { routeChat } from "@/agent/route";
import { useEventListener } from "@/lib/effects";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn, hasText } from "@/lib/utils";
import type { Agent, Objective, Source, Task, Thread } from "@/mock";
import { agentStore, objectiveStore, pathOf, signalStore, sourceStore, splitRouter, taskStore, threadStore } from "@/store";
import { EventDrawer } from "@/views/EventDrawer";
import { ChipView, SearchPalette, hits, isActive, type Filter, type Kind, type NodeMeta } from "@/views/SearchPalette";
import { AgentCard, NoAgentsCard, NoThreadsCard, ObjectiveCard, RouterCard, ThreadCard, type Splitting } from "./routing/cards";
import { EventLog } from "./routing/EventLog";
import { crewOf, layoutStructure, threadsBesideFirstRouter } from "./routing/layout";
import { hitsWithWholeRoutes, searchNodes, shownBy } from "./routing/nodes";
import { Column, GAP, Placed, VIEWS, counted, isFadedAt, paneOfSnapSharingTheAgentsSlot, useCardHeights, useViewport, type Stage } from "./routing/stage";

const ALL_SOURCES: Source[] = ["isaac", "gh", "slack", "agent", "sentry", "yarn"];
const VIEW_OF_KIND: Record<Kind, number> = { event: 0, objective: 1, router: 1, agent: 2, thread: 3 };
const PAN = [
  { step: -1, Icon: ChevronLeft, label: "Previous view" },
  { step: 1, Icon: ChevronRight, label: "Next view" },
];
const NO_FILTER: Filter = { chips: [], text: "" };
const LANDING_AFTER_PAN_MS = 560;

function scrollToNode(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`);
  const scroller = el?.closest<HTMLElement>(".overflow-y-auto");
  if (!el || !scroller) return;
  scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
}

function FilterBar({ filter, hitCount, onFilter, onOpenPalette }: { filter: Filter; hitCount: number; onFilter: (update: (f: Filter) => Filter) => void; onOpenPalette: () => void }) {
  return (
    <div className="flex items-center gap-4">
      <div
        role="button"
        onClick={e => {
          e.stopPropagation();
          onOpenPalette();
        }}
        className="flex cursor-pointer flex-wrap items-center gap-1 text-sm"
      >
        <Search className="mr-1 size-3.5 text-muted-foreground" />
        {filter.chips.map((c, i) => (
          <ChipView key={i} chip={c} onRemove={() => onFilter(f => ({ ...f, chips: f.chips.filter((_, j) => j !== i) }))} />
        ))}
        {hasText(filter.text) && <span>{filter.text}</span>}
      </div>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {hitCount}
        <button onClick={() => onFilter(() => NO_FILTER)} className="underline hover:text-foreground">
          clear
        </button>
      </span>
    </div>
  );
}

function PanButtons({ snap, col, go }: { snap: number; col: number; go: (n: number) => void }) {
  return (
    <div className="absolute top-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 gap-1" style={{ left: col + GAP / 2 }}>
      {PAN.map(({ step, Icon, label }) => {
        const to = snap + step;
        return (
          <button
            key={label}
            aria-label={label}
            data-agent={`pan:${step}`}
            disabled={to < 0 || to >= VIEWS}
            onClick={e => {
              e.stopPropagation();
              go(to);
            }}
            className="flex size-8 items-center justify-center rounded-lg border bg-card text-muted-foreground hover:border-ring hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}

type Structure = { objectives: Objective[]; routers: Agent[]; agents: Agent[]; threads: Thread[]; tasks: Task[]; isShown: (id: string) => boolean };

function StructureHeads({ snap, stage, s }: { snap: number; stage: Stage; s: Structure }) {
  const heads = [
    { title: "Objectives", ids: s.objectives.map(o => `obj:${o.id}`) },
    { title: "Routers", ids: s.routers.map(r => `router:${r.id}`) },
    snap === 3 ? { title: "Threads", ids: s.threads.map(t => `thread:${t.id}`) } : { title: "Agents", ids: s.agents.filter(a => a.role === "worker").map(a => `agent:${a.id}`) },
  ];
  return (
    <div className="flex" style={{ gap: GAP }}>
      {heads.map(({ title, ids }, k) => (
        <h2 key={title} className={cn("flex h-7 items-center gap-2 text-sm font-medium transition-opacity duration-500", isFadedAt(stage.pane, 1 + k) && "opacity-35")} style={{ width: stage.col }}>
          {title}
          <span className="text-xs text-muted-foreground">{counted(ids.filter(s.isShown).length, ids.length)}</span>
        </h2>
      ))}
    </div>
  );
}

function StructureCards({ stage, s, fresh, splitting }: { stage: Stage; s: Structure; fresh: string | undefined; splitting: Splitting }) {
  const agentCard = (id: string) => {
    const w = s.agents.find(a => `agent:${a.id}` === id);
    return w ? <AgentCard w={w} tasks={s.tasks} /> : null;
  };
  const threadCard = (id: string) => {
    const t = s.threads.find(x => `thread:${x.id}` === id);
    return t ? <ThreadCard t={t} /> : null;
  };
  return (
    <>
      {s.objectives
        .filter(o => s.isShown(`obj:${o.id}`))
        .map(o => (
          <Placed key={`obj:${o.id}`} id={`obj:${o.id}`} column={0} stage={stage}>
            <ObjectiveCard o={o} tasks={s.tasks} routerCount={s.routers.filter(r => r.objectiveId === o.id).length} splitting={splitting} />
          </Placed>
        ))}
      {s.routers
        .filter(r => s.isShown(`router:${r.id}`))
        .map(r => (
          <Placed key={`router:${r.id}`} id={`router:${r.id}`} column={1} stage={stage}>
            <RouterCard r={r} crew={s.agents.filter(w => w.parent === r.id).length} isFresh={fresh === r.id} />
          </Placed>
        ))}
      {s.routers.flatMap(r =>
        crewOf(r.id, s.agents, s.isShown).map(id => (
          <Placed key={id} id={id} column={2} only="agents" stage={stage}>
            {id.startsWith("empty:") ? <NoAgentsCard /> : agentCard(id)}
          </Placed>
        )),
      )}
      {s.routers.flatMap(r =>
        threadsBesideFirstRouter(r.id, s.threads, s.isShown).map(id => (
          <Placed key={id} id={id} column={2} only="threads" stage={stage}>
            {id.startsWith("nothreads:") ? <NoThreadsCard /> : threadCard(id)}
          </Placed>
        )),
      )}
    </>
  );
}

function useRoutingKeys(snap: number, go: (n: number) => void, openPalette: () => void) {
  useEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "/") {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.key === "ArrowRight") {
      go(snap + 1);
      return;
    }
    if (e.key === "ArrowLeft") go(snap - 1);
  });
}

function useSplitting(go: (n: number) => void, onFresh: (id: string | undefined) => void): Splitting {
  const [objectiveId, setObjectiveId] = useState<string>();
  const [scope, setScope] = useState("");
  const onSplit = (e: React.SyntheticEvent, splitIn: string) => {
    e.preventDefault();
    if (!scope.trim()) return;
    onFresh(splitRouter(splitIn, scope.trim()));
    setObjectiveId(undefined);
    setScope("");
    go(1);
  };
  return { objectiveId, scope, onStart: setObjectiveId, onScope: setScope, onSplit, onCancel: () => setObjectiveId(undefined) };
}

function useEventLog(onFresh: (id: string | undefined) => void) {
  const sentries = sourceStore.use();
  const [shown, setShown] = useState<Set<Source>>(new Set(ALL_SOURCES));
  const [draft, setDraft] = usePersistentDraft("log-composer");
  const showOnlyOrAll = (source: Source) => setShown(prev => new Set(prev.size === 1 && prev.has(source) ? sentries.map(s => s.id) : [source]));
  const send = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setShown(prev => new Set([...prev, "isaac"]));
    onFresh(routeChat(text));
    setDraft("");
  };
  return { sentries, shown, onToggle: showOnlyOrAll, draft, onDraft: setDraft, onSend: send };
}

function useStructure(filter: Filter) {
  const threads = threadStore.use();
  const signals = signalStore.use();
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const tasks = taskStore.use();
  const paths = new Map(signals.map(s => [s.id, pathOf(s, agents)]));
  const everything = { signals, objectives, agents, threads, tasks, paths };
  const nodes = searchNodes(everything);
  const filterHits = isActive(filter) ? hits(nodes, filter) : undefined;
  const isShown = shownBy(filterHits && hitsWithWholeRoutes(filterHits, everything), threads);
  const routers = agents.filter(a => a.role === "router");
  return { signals, nodes, filterHits, structure: { objectives, routers, agents, threads, tasks, isShown } };
}

export function RoutingView({ snap, onSnap: go }: { snap: number; onSnap: (n: number) => void }) {
  const [width, setWidth] = useState(1200);
  const [fresh, setFresh] = useState<string>();
  const [reading, setReading] = useState<string>();
  const closeReading = useCallback(() => setReading(undefined), []);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [isPaletteOpen, setPaletteOpen] = useState(false);
  const { signals, nodes, filterHits, structure } = useStructure(filter);
  const log = useEventLog(setFresh);
  const splitting = useSplitting(go, setFresh);
  const cards = useCardHeights();
  const attachViewport = useViewport(snap, go, setWidth);
  useRoutingKeys(snap, go, () => setPaletteOpen(true));

  const col = Math.max(320, (width - GAP) / 2);
  const visible = signals.filter(s => log.shown.has(s.source) && structure.isShown(`sig:${s.id}`));
  const pane = paneOfSnapSharingTheAgentsSlot(snap);
  const placed = layoutStructure(snap, { ...structure, heightOf: cards.heightOf });
  const stage: Stage = { snap, col, pane, y: placed.y, observe: cards.observe, go };
  const pick = (n: NodeMeta) => {
    setPaletteOpen(false);
    go(VIEW_OF_KIND[n.kind]);
    setTimeout(() => scrollToNode(n.id), LANDING_AFTER_PAN_MS);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {filterHits && <FilterBar filter={filter} hitCount={filterHits.length} onFilter={setFilter} onOpenPalette={() => setPaletteOpen(true)} />}
      <div ref={attachViewport} className="relative min-h-0 flex-1 overflow-hidden">
        <PanButtons snap={snap} col={col} go={go} />
        <div className="relative flex h-full transition-transform duration-500 ease-in-out" style={{ gap: GAP, width: col * 4 + GAP * 3, transform: `translateX(${-pane * (col + GAP)}px)` }}>
          <Column index={0} title="Event log" count={visible.length} total={signals.length} stage={stage}>
            <EventLog {...log} visible={visible} reading={reading} fresh={fresh} onRead={setReading} />
          </Column>
          <section className="relative flex min-h-0 shrink-0 flex-col gap-3" style={{ width: col * 3 + GAP * 2 }}>
            <StructureHeads snap={snap} stage={stage} s={structure} />
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              <div data-structure className="relative overflow-hidden" style={{ height: placed.height }}>
                <StructureCards stage={stage} s={structure} fresh={fresh} splitting={splitting} />
              </div>
            </div>
          </section>
        </div>
      </div>
      <div onClick={e => e.stopPropagation()}>
        <EventDrawer signal={signals.find(x => x.id === reading)} onClose={closeReading} />
      </div>
      <div onClick={e => e.stopPropagation()}>
        <SearchPalette isOpen={isPaletteOpen} onOpenChange={setPaletteOpen} nodes={nodes} objectiveIds={structure.objectives.map(o => o.id)} filter={filter} onFilter={setFilter} onPick={pick} />
      </div>
    </div>
  );
}
