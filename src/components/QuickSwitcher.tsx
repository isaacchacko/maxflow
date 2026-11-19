import { LayoutGrid, Waypoints } from "lucide-react";
import { useMemo, useState } from "react";
import { useEventListener } from "@/lib/effects";
import { useKeyedState } from "@/lib/useKeyedState";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { slackPlain } from "@/lib/slack";
import { cn, hasText, scrollIntoReach } from "@/lib/utils";
import { statusColor, type Thread } from "@/mock";
import { agentStore, objectiveStore, sentryStore, taskStore, threadStore } from "@/store";
import { Avatar, Rich } from "@/threads/Rich";
import { isNextKey, isPreviousKey } from "@/threads/picker-keys";
import { unseen } from "@/threads/seen";

export type Item = { kind: Kind; href: string; label: string; detail?: string | undefined; icon: React.ReactNode; text: string; rank: number };
type Kind = "Unread" | "Recent" | "Threads" | "Agents" | "Objectives" | "Tasks" | "Views";
type Scored = Item & { s: number };
type Opened = { recents: string[]; here: string };
const ORDER: Kind[] = ["Unread", "Recent", "Threads", "Agents", "Objectives", "Tasks", "Views"];
const PER_KIND = 6;
const UNREAD_LIFT = 1e13;

const RECENTLY_VISITED = "switcher:recent";
function recent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTLY_VISITED) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((h: unknown) => typeof h === "string") : [];
  } catch {
    return [];
  }
}
function visited(hash: string) {
  try {
    localStorage.setItem(RECENTLY_VISITED, JSON.stringify([hash, ...recent().filter(h => h !== hash)].slice(0, 20)));
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the visit is then not remembered
  }
}

export const plain = (text: string) =>
  slackPlain(text)
    .replaceAll(/!\[[^\]]*\]\([^)]+\)/g, "[image]")
    .replaceAll(/\[\[\w+:([^\]]+)\]\]/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replaceAll(/\s+/g, " ");

function lettersInOrder(q: string, t: string) {
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] !== q[i]) continue;
    gaps += last < 0 ? 0 : j - last - 1;
    last = j;
    i += 1;
  }
  return i === q.length && gaps <= q.length * 2 ? 500 - gaps : null;
}

export function score(query: string, text: string, isLoose: boolean) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at !== -1) return 1000 - Math.min(at, 300) + (at === 0 || /\W/.test(t.charAt(at - 1)) ? 200 : 0);
  return isLoose ? lettersInOrder(q, t) : null;
}

function titlesAbove(t: Thread, threads: Thread[]) {
  const up: string[] = [];
  let p = threads.find(x => x.id === t.parentId);
  while (p) {
    up.unshift(p.title);
    const parentId = p.parentId;
    p = threads.find(x => x.id === parentId);
  }
  return up;
}

function threadDetail(fresh: number, opener: string, title: string) {
  if (fresh > 0) return `${fresh} new`;
  return opener.startsWith(title) ? undefined : opener;
}

const timeOr0 = (at = "") => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
};

export function useThreadItems() {
  const threads = threadStore.use();
  return useMemo<Item[]>(
    () =>
      threads.map(t => {
        const first = t.messages[0];
        const fresh = unseen(t);
        const opener = first ? plain(first.text) : "";
        return {
          kind: "Threads" as const,
          href: `#thread/${t.id}`,
          label: [...titlesAbove(t, threads), t.title].join(" › "),
          detail: threadDetail(fresh, opener, t.title),
          icon: <Avatar from={first?.from ?? t.routerIds[0] ?? ""} small />,
          text: `${t.title} ${opener}`,
          rank: (fresh > 0 ? UNREAD_LIFT : 0) + timeOr0(t.messages.at(-1)?.at),
        };
      }),
    [threads],
  );
}

const taskRank = (id: string) => {
  const n = Number(id.replaceAll(/\D/g, ""));
  return Number.isNaN(n) ? 0 : n;
};

function useItems(views: readonly { id: string; label: string }[]) {
  const thread = useThreadItems();
  const agents = agentStore.use();
  const sentries = sentryStore.use();
  const objectives = objectiveStore.use();
  const tasks = taskStore.use();
  return useMemo<Item[]>(() => {
    const agent = [...agents.map(a => ({ id: a.id, name: a.name ?? a.id, detail: a.doing })), ...sentries.map(s => ({ id: s.id, name: `sentry: ${s.name}`, detail: s.status }))].map(a => ({
      kind: "Agents" as const,
      href: `#agent/${a.id}`,
      label: a.name,
      detail: a.detail,
      icon: <Avatar from={a.id} small />,
      text: `${a.name} ${a.id}`,
      rank: 0,
    }));
    const objective = objectives.map(o => ({ kind: "Objectives" as const, href: `#objective/${o.id}`, label: o.title, icon: <Waypoints className="size-4 text-agent" />, text: o.title, rank: 0 }));
    const task = tasks.map(t => ({
      kind: "Tasks" as const,
      href: `#task/${t.id}`,
      label: t.title,
      detail: t.id,
      icon: <span className={cn("mx-1.5 size-2", statusColor[t.status])} />,
      text: `${t.id} ${t.title}`,
      rank: taskRank(t.id),
    }));
    const view = views.map(v => ({ kind: "Views" as const, href: `#${v.id}`, label: v.label, icon: <LayoutGrid className="size-4 text-muted-foreground" />, text: v.label, rank: 0 }));
    return [...thread, ...agent, ...objective, ...task, ...view];
  }, [thread, agents, sentries, objectives, tasks, views]);
}

function whereToStart(items: Item[], opened: Opened) {
  const byHref = new Map(items.map(i => [i.href, i]));
  const threads = items.filter(i => i.kind === "Threads").toSorted((a, b) => b.rank - a.rank);
  const unread = threads.filter(i => i.rank >= UNREAD_LIFT).map(i => ({ ...i, kind: "Unread" as const }));
  const listed = new Set(unread.map(i => i.href));
  const recents = opened.recents
    .filter(h => h !== opened.here && !listed.has(h))
    .map(h => byHref.get(h))
    .filter(i => i !== undefined)
    .map(i => ({ ...i, kind: "Recent" as const }))
    .slice(0, 5);
  for (const r of recents) listed.add(r.href);
  return [...unread, ...recents, ...threads.filter(i => !listed.has(i.href)).slice(0, PER_KIND), ...items.filter(i => i.kind === "Views")];
}

function byScoreThenRank(a: Scored, b: Scored) {
  const byScore = b.s - a.s;
  return byScore === 0 ? b.rank - a.rank : byScore;
}

function bestMatches(items: Item[], q: string) {
  const scored = items
    .map(i => {
      const isThread = i.kind === "Threads";
      return { i, isThread, name: score(q, i.label, true), body: score(q, i.text, !isThread) };
    })
    .filter(({ name, body }) => name !== null || body !== null)
    .map(({ i, isThread, name, body }) => ({ ...i, s: Math.max(name ?? 0, (body ?? 0) - (isThread ? 100 : 0)) }));
  const groups = ORDER.map(kind =>
    scored
      .filter(i => i.kind === kind)
      .toSorted(byScoreThenRank)
      .slice(0, PER_KIND),
  ).filter(g => g.length > 0);
  return groups.toSorted((a, b) => (b[0]?.s ?? 0) - (a[0]?.s ?? 0)).flat();
}

function SwitcherList({ shown, query, active, setActive, go }: { shown: Item[]; query: string; active: number; setActive: (n: number) => void; go: (i: Item) => void }) {
  return (
    <div className="max-h-[60vh] overflow-y-auto py-1">
      {shown.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query}”</p>}
      {shown.map((item, n) => (
        <div key={`${item.kind}:${item.href}`}>
          {item.kind !== shown[n - 1]?.kind && <p className="px-4 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{item.kind}</p>}
          <button
            data-index={n}
            ref={n === active ? scrollIntoReach : undefined}
            onMouseMove={() => setActive(n)}
            onClick={() => go(item)}
            className={cn("flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm", n === active && "bg-muted")}
          >
            <span className="flex w-5 shrink-0 justify-center">{item.icon}</span>
            <span className="max-w-[65%] shrink-0 truncate">{item.label}</span>
            {hasText(item.detail) && <Rich still text={item.kind === "Tasks" ? `\`${item.detail}\`` : item.detail} className={cn("min-w-0 truncate text-xs", /^\d+ new$/.test(item.detail) ? "text-new" : "text-muted-foreground")} />}
          </button>
        </div>
      ))}
    </div>
  );
}

export function QuickSwitcher({ views }: { views: readonly { id: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<Opened>({ recents: [], here: "" });
  const [query, setQuery] = useState("");
  const [active, setActive] = useKeyedState(`${open}:${query}`, 0);
  const items = useItems(views);

  const openSwitcher = () => {
    setOpened({ recents: recent(), here: location.hash });
    setOpen(true);
  };
  const setOpenFromDialog = (isOpen: boolean) => {
    if (isOpen) openSwitcher();
    else {
      setOpen(false);
      setQuery("");
    }
  };

  useEventListener(
    "keydown",
    e => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (open) setOpen(false);
      else openSwitcher();
    },
    { capture: true },
  );
  useEventListener("hashchange", () => visited(location.hash));
  useEventListener("quick-switcher-open", openSwitcher);

  const shown = useMemo(() => {
    const q = query.trim();
    return q ? bestMatches(items, q) : whereToStart(items, opened);
  }, [items, query, opened]);

  function go(i: Item | undefined) {
    if (!i) return;
    setOpen(false);
    setQuery("");
    location.hash = i.href;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (isNextKey(e)) setActive(a => Math.min(shown.length - 1, a + 1));
    else if (isPreviousKey(e)) setActive(a => Math.max(0, a - 1));
    else if (e.key === "Enter") go(shown[active]);
    else return;
    e.preventDefault();
  }

  return (
    <Dialog open={open} onOpenChange={setOpenFromDialog}>
      <DialogContent showCloseButton={false} className="top-[20%] translate-y-0 gap-0 overflow-hidden rounded-none p-0 sm:max-w-xl" data-agent="switcher">
        <DialogTitle className="sr-only">Jump to</DialogTitle>
        <DialogDescription className="sr-only">Search threads, agents, objectives, tasks and views</DialogDescription>
        <input
          autoFocus
          data-agent="switcher-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to a thread, agent, objective, task or view…"
          className="border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground/60"
        />
        <SwitcherList shown={shown} query={query} active={active} setActive={setActive} go={go} />
        <div className="flex items-center gap-3 border-t px-4 py-1.5 text-[11px] text-muted-foreground">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>esc</Kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
