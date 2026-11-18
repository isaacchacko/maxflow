import { LayoutGrid, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { statusColor } from "@/mock";
import { agentStore, objectiveStore, sentryStore, taskStore, threadStore } from "@/store";
import { Avatar, Rich } from "@/threads/Rich";
import { unseen } from "@/threads/seen";

export type Item = { kind: Kind; href: string; label: string; detail?: string; icon: React.ReactNode; text: string; rank: number };
type Kind = "Unread" | "Recent" | "Threads" | "Agents" | "Objectives" | "Tasks" | "Views";
const ORDER: Kind[] = ["Unread", "Recent", "Threads", "Agents", "Objectives", "Tasks", "Views"];
const PER_KIND = 6;
// A thread's rank: when it last moved, lifted above every read thread while it has replies he hasn't seen.
const UNREAD = 1e13;

// Where Isaac went last, newest first, so an empty query starts there.
const RECENT = "switcher:recent";
function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]");
  } catch {
    return [];
  }
}
function visited(hash: string) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([hash, ...recent().filter(h => h !== hash)].slice(0, 20)));
  } catch {}
}

export const plain = (text: string) => text.replace(/!\[[^\]]*\]\([^)]+\)/g, "[image]").replace(/\[\[\w+:([^\]]+)\]\]/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ");

/**
 * Higher is better; null for no match. The query as one run counts most, earlier and at a word start more. Letters in order
 * with gaps count only in a short name (`loose`), since a long message holds almost any letters in order.
 */
export function score(query: string, text: string, loose: boolean) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - Math.min(at, 300) + (at === 0 || /\W/.test(t[at - 1]!) ? 200 : 0);
  if (!loose) return null;
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) (gaps += last < 0 ? 0 : j - last - 1), (last = j), i++;
  return i === q.length && gaps <= q.length * 2 ? 500 - gaps : null;
}

/** Every thread as a switcher item: subthreads labelled with their path, unread first, then whatever moved last. The composer's @ picker lists the same. */
export function useThreadItems() {
  const threads = threadStore.use();
  return useMemo<Item[]>(
    () =>
      threads.map(t => {
        const first = t.messages[0];
        const fresh = unseen(t);
        const opener = first ? plain(first.text) : "";
        // A subthread shows the threads above it, so it reads as where it sits.
        const up: string[] = [];
        for (let p = threads.find(x => x.id === t.parentId); p; p = threads.find(x => x.id === p!.parentId)) up.unshift(p.title);
        return {
          kind: "Threads" as const,
          href: `#thread/${t.id}`,
          label: [...up, t.title].join(" › "),
          detail: fresh > 0 ? `${fresh} new` : opener.startsWith(t.title) ? undefined : opener,
          icon: <Avatar from={first?.from ?? t.routerIds[0] ?? ""} small />,
          text: `${t.title} ${opener}`,
          // Unread first, then whatever moved last.
          rank: (fresh > 0 ? UNREAD : 0) + (Date.parse(t.messages.at(-1)?.at ?? "") || 0),
        };
      }),
    [threads],
  );
}

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
      rank: Number(t.id.replace(/\D/g, "")) || 0,
    }));
    const view = views.map(v => ({ kind: "Views" as const, href: `#${v.id}`, label: v.label, icon: <LayoutGrid className="size-4 text-muted-foreground" />, text: v.label, rank: 0 }));
    return [...thread, ...agent, ...objective, ...task, ...view];
  }, [thread, agents, sentries, objectives, tasks, views]);
}

/** ⌘K / Ctrl+K from anywhere, composers included (or / outside them, as a "quick-switcher-open" event): one box that jumps to any thread, agent, objective, task or view. */
export function QuickSwitcher({ views }: { views: readonly { id: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const items = useItems(views);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // In a message box ⌘K makes a link, as in Slack.
      if ((e.target as Element | null)?.closest?.("[data-composer]")) return;
      e.preventDefault();
      setOpen(o => !o);
    };
    const onHash = () => visited(location.hash);
    const onOpen = () => setOpen(true);
    addEventListener("keydown", onKey, true);
    addEventListener("hashchange", onHash);
    addEventListener("quick-switcher-open", onOpen);
    return () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("hashchange", onHash);
      removeEventListener("quick-switcher-open", onOpen);
    };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim();
    if (!q) {
      const byHref = new Map(items.map(i => [i.href, i]));
      const here = location.hash;
      // Unread threads first, then where he went last, then the threads that moved most recently.
      const threads = items.filter(i => i.kind === "Threads").sort((a, b) => b.rank - a.rank);
      const unread = threads.filter(i => i.rank >= UNREAD).map(i => ({ ...i, kind: "Unread" as const }));
      const listed = new Set(unread.map(i => i.href));
      const recents = recent().filter(h => h !== here && !listed.has(h)).flatMap(h => (byHref.has(h) ? [{ ...byHref.get(h)!, kind: "Recent" as const }] : [])).slice(0, 5);
      for (const r of recents) listed.add(r.href);
      return [...unread, ...recents, ...threads.filter(i => !listed.has(i.href)).slice(0, PER_KIND), ...items.filter(i => i.kind === "Views")];
    }
    const scored = items.flatMap(i => {
      // A thread's opening message matches only as a run, and ranks under a match in its title.
      const thread = i.kind === "Threads";
      const name = score(q, i.label, true), body = score(q, i.text, !thread);
      return name === null && body === null ? [] : [{ ...i, s: Math.max(name ?? 0, (body ?? 0) - (thread ? 100 : 0)) }];
    });
    // Each kind keeps its best few, and the kind holding the best match comes first.
    const groups = ORDER.map(kind => scored.filter(i => i.kind === kind).sort((a, b) => b.s - a.s || b.rank - a.rank).slice(0, PER_KIND)).filter(g => g.length);
    return groups.sort((a, b) => b[0]!.s - a[0]!.s).flat();
  }, [items, query, open]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function go(i: Item | undefined) {
    if (!i) return;
    setOpen(false);
    setQuery("");
    location.hash = i.href;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) e.preventDefault(), setActive(a => Math.min(shown.length - 1, a + 1));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) e.preventDefault(), setActive(a => Math.max(0, a - 1));
    else if (e.key === "Enter") e.preventDefault(), go(shown[active]);
  }

  return (
    <Dialog open={open} onOpenChange={o => (setOpen(o), o || setQuery(""))}>
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
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {shown.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query}”</p>}
          {shown.map((item, n) => (
            <div key={`${item.kind}:${item.href}`}>
              {item.kind !== shown[n - 1]?.kind && <p className="px-4 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{item.kind}</p>}
              <button
                data-index={n}
                onMouseMove={() => setActive(n)}
                onClick={() => go(item)}
                className={cn("flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm", n === active && "bg-muted")}
              >
                <span className="flex w-5 shrink-0 justify-center">{item.icon}</span>
                <span className="max-w-[65%] shrink-0 truncate">{item.label}</span>
                {item.detail && <Rich still text={item.kind === "Tasks" ? `\`${item.detail}\`` : item.detail} className={cn("min-w-0 truncate text-xs", /^\d+ new$/.test(item.detail) ? "text-new" : "text-muted-foreground")} />}
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t px-4 py-1.5 text-[11px] text-muted-foreground">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>esc</Kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
