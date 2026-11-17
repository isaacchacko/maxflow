import { Activity, Bot, Inbox, MessagesSquare, Plus, Radar, SquareKanban, Waypoints, X, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentFace, expressionOf } from "@/components/AgentFace";
import { cn } from "@/lib/utils";
import { agentStore, nameStore, objectiveStore, taskStore, threadStore } from "@/store";
import { closeTab, cycleTab, moveTab, openTab, placeOf, switchTab, switchToIndex, tabStore, type Tab } from "@/tabs";
import { unseenDeep, useSeen } from "@/threads/seen";

const VIEWS: Record<string, [string, LucideIcon]> = {
  inbox: ["Inbox", Inbox],
  events: ["Events", Activity],
  objectives: ["Objectives", Waypoints],
  agents: ["Agents", Bot],
  threads: ["Threads", MessagesSquare],
  sentries: ["Sentries", Radar],
};

/** What a tab shows: the page's icon (an agent's own face) and its title, and whether there is something he hasn't seen there. */
function useLabel(place: string) {
  const threads = threadStore.use();
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const tasks = taskStore.use();
  const names = nameStore.use();
  const [kind, id = ""] = place.split("/");
  if (kind === "thread") {
    const t = threads.find(x => x.id === id);
    return { icon: <MessagesSquare className="size-3.5 shrink-0" />, text: t?.title ?? "Thread", unread: !!t && unseenDeep(t, threads) > 0 };
  }
  if (kind === "agent") {
    const a = agents.find(x => x.id === id);
    return { icon: <AgentFace id={id} expression={expressionOf(a?.state)} small still className="size-4.5" />, text: a?.name ?? names[id] ?? id, unread: false };
  }
  if (kind === "objective") return { icon: <Waypoints className="size-3.5 shrink-0" />, text: objectives.find(o => o.id === id)?.title ?? id, unread: false };
  if (kind === "task") return { icon: <SquareKanban className="size-3.5 shrink-0" />, text: tasks.find(t => t.id === id)?.title ?? id, unread: false };
  const [text, Icon] = VIEWS[kind!] ?? VIEWS.inbox!;
  return { icon: <Icon className="size-3.5 shrink-0" />, text, unread: false };
}

function TabItem({ tab, active, only, onDrop }: { tab: Tab; active: boolean; only: boolean; onDrop(dragged: string): void }) {
  const label = useLabel(placeOf(tab));
  const [over, setOver] = useState(false);
  return (
    <div
      role="tab"
      aria-selected={active}
      data-agent={`tab:${tab.id}`}
      title={label.text}
      draggable
      onDragStart={e => e.dataTransfer.setData("text/yarn-tab", tab.id)}
      onDragOver={e => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={e => (e.preventDefault(), setOver(false), onDrop(e.dataTransfer.getData("text/yarn-tab")))}
      onClick={() => switchTab(tab.id)}
      // A middle click closes it, as in a browser.
      onAuxClick={e => e.button === 1 && (e.preventDefault(), closeTab(tab.id))}
      className={cn(
        "group relative flex h-8 max-w-56 min-w-10 shrink-1 basis-auto cursor-default items-center gap-1.5 overflow-hidden rounded-lg px-3 text-[13px] select-none",
        active ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        over && "ring-2 ring-link/40",
      )}
    >
      {label.icon}
      <span className="min-w-0 truncate">{label.text}</span>
      {label.unread && !active && <span aria-label="unread" className="size-1.5 shrink-0 rounded-full bg-new" />}
      {!only && (
        <button
          aria-label="Close tab"
          data-agent={`tab-close:${tab.id}`}
          onClick={e => (e.stopPropagation(), closeTab(tab.id))}
          className="-mr-1.5 hidden shrink-0 rounded-md p-0.5 group-hover:block hover:bg-muted"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/** Where a ⌘-click or middle click would go: a link inside the app, an inbox row, or a card on the routing canvas. */
function placeAt(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  const link = el?.closest<HTMLAnchorElement>("a[href^='#']");
  if (link) return link.getAttribute("href")!.slice(1);
  const card = el?.closest<HTMLElement>("[data-node]")?.dataset.node;
  if (card && /^(thread|agent|objective):/.test(card)) return card.replace(":", "/");
  const row = el?.closest<HTMLElement>("main [data-vim]")?.dataset.vim;
  if (row && (location.hash.slice(1) || "inbox") === "inbox") return `thread/${row}`;
}

/** The keys and clicks that make and move between tabs. ⌥ works as well as ⌘, for browsers that keep ⌘T and ⌘W to themselves. */
function useTabKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.altKey;
      const key = e.code.startsWith("Digit") ? e.code.slice(5) : e.key.toLowerCase();
      const act =
        mod && !e.shiftKey && key === "t" ? () => openTab()
        : mod && !e.shiftKey && key === "w" ? () => closeTab(tabStore.get().active)
        : mod && /^[1-9]$/.test(key) ? () => switchToIndex(Number(key) - 1)
        : e.ctrlKey && e.key === "Tab" ? () => cycleTab(e.shiftKey ? -1 : 1)
        : undefined;
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    };
    // ⌘-click (or Ctrl-click) or a middle click on anything that opens a page opens it in a new tab behind this one; with ⇧, in front.
    const onClick = (e: MouseEvent) => {
      const middle = e.type === "auxclick" && e.button === 1;
      if (!middle && !(e.type === "click" && (e.metaKey || e.ctrlKey))) return;
      const place = placeAt(e.target);
      if (!place) return;
      e.preventDefault();
      e.stopPropagation();
      openTab(place, !e.shiftKey);
    };
    // A middle press would otherwise start the browser's autoscroll.
    const onDown = (e: MouseEvent) => e.button === 1 && placeAt(e.target) && e.preventDefault();
    addEventListener("keydown", onKey, true);
    addEventListener("click", onClick, true);
    addEventListener("auxclick", onClick, true);
    addEventListener("mousedown", onDown, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("click", onClick, true);
      removeEventListener("auxclick", onClick, true);
      removeEventListener("mousedown", onDown, true);
    };
  }, []);
}

/** The top bar's tabs: one per place he keeps open, each starting at the inbox, and + for another. */
export function TabBar() {
  const { tabs, active } = tabStore.use();
  useSeen();
  useTabKeys();
  return (
    <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-xl bg-muted/70 p-1 [scrollbar-width:none]">
      {tabs.map((t, i) => (
        <TabItem key={t.id} tab={t} active={t.id === active} only={tabs.length === 1} onDrop={dragged => dragged && moveTab(dragged, i)} />
      ))}
      <button aria-label="New tab" title="New tab (⌘T or ⌥T)" data-agent="tab-new" onClick={() => openTab()} className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-card hover:text-foreground">
        <Plus className="size-4" />
      </button>
    </div>
  );
}
