import { ChevronDown, ChevronRight, Folder, History, Search } from "lucide-react";
import { useState } from "react";
import { useResource, useSettled } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { ago } from "@/threads/Replies";
import { Markdown } from "@/threads/Rich";
import { eventsKey, findEvents, type Hit, INDEX_KEY, loadEvents, loadIndex, showing, type Timeline, type TimelineEvent } from "./timelines/api";

type Node = { name: string; path: string; timeline?: Timeline; children: Node[] };

const SEARCH_SETTLE_MS = 250;
const BARE_THREAD_ID = /(^|[^\w:[/-])(th-[0-9a-f]{6})\b/g;
const AUTHOR_WITH_ID = /^(.*) \(([0-9a-f]{8})\)$/;

const goTo = (path: string) => `#timelines/${encodeURI(path)}`;
const parentOf = (file: string) => file.split("/").slice(0, -1).join("/");
const withChips = (text: string) => text.replaceAll(BARE_THREAD_ID, "$1[[thread:$2]]");
const firstLine = (text: string | undefined) => (text ?? "").trim().split("\n", 1)[0] ?? "";

function nodeAt(root: Node, path: string): Node {
  let node = root;
  for (const name of path.split("/")) {
    const at = node.path === "" ? name : `${node.path}/${name}`;
    let child = node.children.find(c => c.name === name);
    if (!child) {
      child = { name, path: at, children: [] };
      node.children.push(child);
    }
    node = child;
  }
  return node;
}

function treeOf(timelines: Timeline[]) {
  const root: Node = { name: "", path: "", children: [] };
  for (const t of timelines) nodeAt(root, t.path).timeline = t;
  return root;
}

function TimelineEntry({ node, depth, selected }: { node: Node; depth: number; selected: string | undefined }) {
  const t = node.timeline;
  if (!t) return null;
  return (
    <a
      href={goTo(node.path)}
      data-agent={`timelines:open:${node.path}`}
      style={{ paddingLeft: depth * 12 + 8 }}
      className={cn("flex flex-col rounded-md py-1 pr-2 hover:bg-muted", selected === node.path && "bg-muted")}
    >
      <span className="flex items-baseline gap-2 text-sm">
        <History className="size-3.5 shrink-0 self-center text-muted-foreground" />
        <span className="truncate">{node.name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{t.events}</span>
      </span>
      {hasText(t.now) && <span className="truncate pl-5.5 text-xs text-muted-foreground" title={t.now}>{firstLine(t.now)}</span>}
    </a>
  );
}

function TreeNode({ node, depth, selected }: { node: Node; depth: number; selected: string | undefined }) {
  const [isOpen, setOpen] = useState(true);
  const folders = node.children.filter(c => c.children.length > 0);
  if (node.children.length === 0) return <TimelineEntry node={node} depth={depth} selected={selected} />;
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <div>
      <TimelineEntry node={node} depth={depth} selected={selected} />
      <button type="button" onClick={() => setOpen(!isOpen)} style={{ paddingLeft: depth * 12 + 4 }} className="flex w-full items-center gap-1.5 rounded-md py-1 text-sm text-muted-foreground hover:bg-muted">
        <Chevron className="size-3.5 shrink-0" />
        <Folder className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {isOpen && (
        <>
          {folders.map(c => <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} />)}
          {node.children.filter(c => c.children.length === 0).map(c => <TimelineEntry key={c.path} node={c} depth={depth + 1} selected={selected} />)}
        </>
      )}
    </div>
  );
}

function Author({ author }: { author: string | null }) {
  if (author === null) return null;
  const [, name = author, id] = AUTHOR_WITH_ID.exec(author) ?? [];
  if (id === undefined) return <span>{name}</span>;
  return <a href={`#agent/${id}`} className="hover:underline">{name}</a>;
}

function EventCard({ e }: { e: TimelineEvent }) {
  const at = e.at === null ? NaN : Date.parse(e.at);
  return (
    <li className="space-y-1.5 border-b px-4 py-3 last:border-b-0" data-agent={`timelines:event:${e.file}`}>
      <div className="flex items-baseline gap-3">
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={Number.isNaN(at) ? "" : new Date(at).toLocaleString()}>
          {Number.isNaN(at) ? "" : new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium">{e.title}</span>
        <span className="shrink-0 truncate text-xs text-muted-foreground"><Author author={e.author} />{at <= Date.now() && ` · ${ago(at)} ago`}</span>
      </div>
      <Markdown text={withChips(e.text)} className="text-sm leading-relaxed" />
    </li>
  );
}

function TimelinePane({ path }: { path: string }) {
  showing(path);
  const loaded = useResource(eventsKey(path), async () => loadEvents(path));
  const t = loaded.value;
  return (
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4" data-agent="timelines:pane">
      <h1 className="font-mono text-sm">{path}</h1>
      {loaded.error && <p className="text-sm text-destructive">{loaded.error.message}</p>}
      {t && (
        <>
          <section className="rounded-md border bg-muted/30 px-4 py-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">now</p>
            {t.now === null ? <p className="text-sm text-muted-foreground">No now.txt yet.</p> : <Markdown text={withChips(t.now)} className="text-sm leading-relaxed" />}
          </section>
          <ol className="rounded-md border">
            {t.events.map(e => <EventCard key={e.file} e={e} />)}
            {t.events.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No events yet.</li>}
          </ol>
        </>
      )}
    </div>
  );
}

function Hits({ q }: { q: string }) {
  const found = useResource(`timelines-find:${q}`, async () => findEvents(q));
  const hits: Hit[] = found.value ?? [];
  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-4" data-agent="timelines:hits">
      <p className="mb-3 text-sm text-muted-foreground">{found.value === undefined ? "Searching…" : `${hits.length} event(s) with every word of “${q}”`}</p>
      <ol className="rounded-md border">
        {hits.map(h => (
          <li key={h.file} className="border-b last:border-b-0">
            <a href={goTo(parentOf(h.file))} className="block px-4 py-2 hover:bg-muted">
              <p className="truncate font-mono text-xs text-muted-foreground">{h.file}</p>
              <p className="truncate text-sm">{h.line}</p>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Main({ path, q }: { path: string | undefined; q: string }) {
  if (q !== "") return <Hits q={q} />;
  if (hasText(path)) return <TimelinePane key={path} path={path} />;
  return <p className="flex-1 p-4 text-sm text-muted-foreground">Pick a timeline, or search across all of them.</p>;
}

export function TimelinesView({ path }: { path: string | undefined }) {
  const index = useResource(INDEX_KEY, loadIndex);
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim(), SEARCH_SETTLE_MS);
  const timelines = index.value?.timelines ?? [];
  return (
    <div className="flex h-full min-h-0" data-agent="timelines">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <span className="text-sm font-semibold">Timelines</span>
          <span className="ml-auto truncate font-mono text-xs text-muted-foreground" title={index.value?.dir}>{timelines.length}</span>
        </div>
        <label className="m-2 flex h-8 items-center gap-2 rounded-md border px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Search every event" data-agent="timelines:search" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </label>
        <nav className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {index.error && <p className="px-2 text-sm text-destructive">{index.error.message}</p>}
          {treeOf(timelines).children.map(n => <TreeNode key={n.path} node={n} depth={0} selected={path} />)}
        </nav>
      </aside>
      <Main path={path} q={q} />
    </div>
  );
}
