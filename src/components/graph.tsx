import { useEffect, useRef, useState } from "react";
import { GraphRenderer } from "@isaacchacko/graph";
import { Bot, ChevronDown, ChevronUp, Link2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ago, api, displayName, home, isBusy, isSentry, isWaiting, kindOf, store, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/sidebar";

type Edge = { source: string; target: string; label: string };
type Mode = "select" | "edit";
type Draft = { x: number; y: number; world: { x: number; y: number } };

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const edgeKey = (a: string, b: string) => [a, b].sort().join("|");
// Color says what a node is; whether it is working or waiting on you is drawn inside it by drawPixels.
// A URL a session mentioned is a node of its own, shared by every session that mentioned it.
const URL_NODE = "url:";
const isUrlNode = (id: string) => id.startsWith(URL_NODE);
const shortUrl = (u: string) => {
  const t = u.replace(/^https?:\/\/(www\.)?/, "");
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
};
// sentry:graph groups sessions by shared work; every pair in a group is joined by a hidden link that pulls them together.
const groupPulls = (sessions: Session[]) => {
  const byGroup = Map.groupBy(sessions.filter((s) => s.group), (s) => s.group!);
  return [...byGroup.values()].flatMap((g) => g.flatMap((a, i) => g.slice(i + 1).map((b) => ({ source: a.id, target: b.id, length: 1, hidden: true }))));
};
const sessionColor = (s: Session) => (!s.running ? "#484f58" : isSentry(s) ? css("--sentry") : s.agent ? css("--chat") : css("--foreground"));

// Pixel art clipped to a node's circle: water rising from the bottom in a sine wave while it works, three dots ticking in turn while it waits on you.
function drawPixels(ctx: CanvasRenderingContext2D, box: { x: number; y: number; r: number }, t: number, working: boolean, ink: string) {
  const cols = box.r >= 12 ? 15 : 11, mid = (cols - 1) / 2;
  const cell = (box.r * 2) / cols, x0 = box.x - box.r, y0 = box.y - box.r;
  const edge = (o: number, i: number) => Math.round((o + i * cell) * devicePixelRatio) / devicePixelRatio;
  const px = (c: number, r: number) => ctx.fillRect(edge(x0, c), edge(y0, r), edge(x0, c + 1) - edge(x0, c), edge(y0, r + 1) - edge(y0, r));
  ctx.save();
  ctx.beginPath();
  ctx.arc(box.x, box.y, box.r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = ink;
  if (working)
    for (let c = 0; c < cols; c++) {
      const surface = Math.round(cols * 0.55 + Math.sin(t / 260 - c * 0.55) * cols * 0.12);
      for (let r = surface; r < cols; r++) px(c, r);
    }
  else for (let i = 0; i < 3; i++) if (Math.floor(t / 450) % 4 > i) px(mid - 2 + 2 * i, mid);
  ctx.restore();
}

// One node per session, linked by edges drawn by hand; drawing one introduces the two ends, and edges live in this browser and go when either session does.
export function GraphView({ sessions, visible, current, onOpen, onCreated }: { sessions: Session[]; visible: boolean; current: string | null; onOpen: (id: string) => void; onCreated: () => Promise<unknown> }) {
  const el = useRef<HTMLDivElement>(null);
  const graph = useRef<GraphRenderer | null>(null);
  const [edges, setEdgesState] = useState<Edge[]>(() => { try { return JSON.parse(store.get("mf.edges") || "[]"); } catch { return []; } });
  const [mode, setMode] = useState<Mode>("select");
  const [showUrls, setShowUrls] = useState(() => store.get("mf.urls") !== "0");
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<Edge | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Sessions the new agent will be linked with; clicking nodes while drafting toggles them.
  const [picked, setPicked] = useState<string[]>([]);
  // ⌘F: null while the find bar is closed.
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<string | null>(null);
  // Where a just-created agent should first appear: the spot that was double-clicked.
  const placeAt = useRef(new Map<string, { x: number; y: number }>());
  const fitted = useRef(false);
  const tip = useRef<HTMLDivElement>(null), editor = useRef<HTMLDivElement>(null), waves = useRef<HTMLCanvasElement>(null);
  const live = useRef({ edges, mode, onOpen, newAgentHere: () => {}, toggleUrls: () => {}, drafting: false, togglePick: (_id: string) => {} });

  const setEdges = (next: Edge[]) => {
    setEdgesState(next);
    store.set("mf.edges", JSON.stringify(next));
  };

  useEffect(() => {
    if (!visible || graph.current) return;
    const g = new GraphRenderer(el.current!, {
      theme: { background: css("--background"), node: "#7d8590", link: css("--border"), text: css("--foreground"), accent: css("--primary"), fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    } as never);
    g.on("nodeHover", ({ id }) => setHover(id));
    g.on("nodeClick", ({ id }) => {
      if (isUrlNode(id)) {
        if (!live.current.drafting) open(id.slice(URL_NODE.length), "_blank", "noopener");
      } else if (live.current.drafting) live.current.togglePick(id);
      else if (live.current.mode === "select") live.current.onOpen(id);
    });
    g.on("connect", ({ source, target }) => {
      const { edges } = live.current;
      if (source === target || isUrlNode(source) || isUrlNode(target) || edges.some((e) => edgeKey(e.source, e.target) === edgeKey(source, target))) return;
      setEdges([...edges, { source, target, label: "" }]);
      api.link(source, target);
    });
    g.on("linkClick", ({ source, target }) => setEditing(live.current.edges.find((e) => edgeKey(e.source, e.target) === edgeKey(source, target)) ?? null));
    g.on("linkContextMenu", ({ source, target, event }) => {
      event.preventDefault();
      setEditing(null);
      setEdges(live.current.edges.filter((e) => edgeKey(e.source, e.target) !== edgeKey(source, target)));
    });
    g.on("backgroundClick", () => (setEditing(null), setDraft(null)));
    g.on("backgroundDoubleClick", ({ world, event }) => {
      const r = el.current!.getBoundingClientRect();
      setEditing(null);
      setDraft({ x: event.clientX - r.left, y: event.clientY - r.top, world });
    });
    graph.current = g;
  }, [visible]);

  useEffect(() => () => graph.current?.destroy(), []);

  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    const ids = new Set(sessions.map((s) => s.id));
    const kept = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    if (sessions.length && kept.length !== edges.length) return setEdges(kept);
    const urls = showUrls ? [...new Set(sessions.flatMap((s) => s.links))] : [];
    g.setData({
      nodes: [
        ...sessions.map((s) => {
          const at = placeAt.current.get(s.id);
          placeAt.current.delete(s.id);
          return { id: s.id, label: s.name, color: sessionColor(s), size: (s.agent ? 2.4 : 1.8) * (isBusy(s) || isWaiting(s) ? 1.6 : 1), ...at };
        }),
        ...urls.map((u) => ({ id: URL_NODE + u, label: shortUrl(u), color: css("--url"), size: 1 })),
      ],
      links: [
        ...edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
        ...groupPulls(sessions),
        ...(showUrls ? sessions.flatMap((s) => s.links.map((u) => ({ source: s.id, target: URL_NODE + u, length: 0.6 }))) : []),
      ],
    } as never);
    if (!fitted.current && sessions.length) (fitted.current = true), g.zoomToFit();
  }, [sessions, edges, visible, showUrls]);

  useEffect(() => graph.current?.setOptions({ mode } as never), [mode, visible]);
  useEffect(() => {
    if (!graph.current || !visible) return;
    const node = found ?? current;
    graph.current.setSelection(editing ? { kind: "link", source: editing.source, target: editing.target } : node ? { kind: "node", id: node } : null);
  }, [editing, found, current, visible]);
  useEffect(() => {
    if (!visible) (setHover(null), setEditing(null), setDraft(null), setQuery(null));
    else (document.activeElement as HTMLElement | null)?.blur(); // the hidden terminal would otherwise keep the keyboard and swallow S/E
  }, [visible]);
  useEffect(() => setEditing(null), [mode]);

  // Tooltip and edge editor follow the layout as it moves.
  const active = sessions.filter((s) => isBusy(s) || isWaiting(s));
  const activeKey = active.map((s) => `${s.id}:${s.status}`).join();
  useEffect(() => {
    const canvas = waves.current!, ctx = canvas.getContext("2d")!;
    const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!visible || !active.length) return clear();
    const ink = css("--background");
    let frame = 0;
    const draw = (t: number) => {
      const dpr = devicePixelRatio, w = el.current!.offsetWidth, h = el.current!.offsetHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) (canvas.width = w * dpr), (canvas.height = h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      clear();
      for (const s of active) {
        const box = graph.current?.getNodeScreenBox(s.id);
        if (box && box.r >= 4) drawPixels(ctx, box, t, isBusy(s), ink);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => (cancelAnimationFrame(frame), clear());
  }, [visible, activeKey]);

  useEffect(() => {
    let frame = 0;
    const follow = () => {
      const g = graph.current;
      if (g && hover && tip.current) {
        const box = g.getNodeScreenBox(hover);
        if (box) {
          const right = box.x + box.r + 14;
          const fits = right + tip.current.offsetWidth < el.current!.offsetWidth;
          tip.current.style.left = `${fits ? right : box.x - box.r - 14 - tip.current.offsetWidth}px`;
          tip.current.style.top = `${Math.max(0, box.y - tip.current.offsetHeight / 2)}px`;
        }
      }
      if (g && editing && editor.current) {
        const p = g.getLinkScreenMidpoint(editing.source, editing.target) ?? g.getLinkScreenMidpoint(editing.target, editing.source);
        if (p) (editor.current.style.left = `${p.x}px`), (editor.current.style.top = `${p.y}px`);
      }
      frame = requestAnimationFrame(follow);
    };
    if (hover || editing) follow();
    return () => cancelAnimationFrame(frame);
  }, [hover, editing]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "f") {
        e.preventDefault();
        setQuery((q) => q ?? "");
        document.querySelector<HTMLInputElement>("[data-find]")?.select();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest?.("input, [contenteditable=true]")) return;
      if (e.key === "s") setMode("select");
      else if (e.key === "e") setMode("edit");
      else if (e.key === "n") live.current.newAgentHere();
      else if (e.key === "l") live.current.toggleUrls();
      else if (e.key === "Escape") (setEditing(null), setDraft(null));
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [visible]);

  const hovered = sessions.find((s) => s.id === hover);
  const hoveredUrl = hover && isUrlNode(hover) ? hover.slice(URL_NODE.length) : null;
  const newAgentHere = () => {
    const r = el.current!.getBoundingClientRect();
    setEditing(null);
    setDraft({ x: r.width / 2, y: r.height / 2, world: graph.current!.screenToWorld({ x: r.width / 2, y: r.height / 2 }) });
  };
  const togglePick = (id: string) => {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    document.querySelector<HTMLInputElement>("[data-agent-prompt]")?.focus();
  };
  const toggleUrls = () => {
    store.set("mf.urls", showUrls ? "0" : "1");
    setShowUrls(!showUrls);
  };
  live.current = { edges, mode, onOpen, newAgentHere, toggleUrls, drafting: !!draft, togglePick };
  useEffect(() => { if (!draft) setPicked([]); }, [draft]);
  const needle = query?.trim().toLowerCase();
  const matches = needle
    ? [
        ...sessions.filter((s) => displayName(s).toLowerCase().includes(needle)).map((s) => s.id),
        ...(showUrls ? [...new Set(sessions.flatMap((s) => s.links))].filter((u) => u.toLowerCase().includes(needle)).map((u) => URL_NODE + u) : []),
      ]
    : [];
  const matchKey = matches.join();
  useEffect(() => {
    if (found && !matches.includes(found)) setFound(null);
  }, [matchKey]);
  const findStep = (by: 1 | -1) => {
    if (!matches.length) return;
    const i = found ? matches.indexOf(found) : -1;
    const next = matches[i === -1 ? (by === 1 ? 0 : matches.length - 1) : (i + by + matches.length) % matches.length];
    setFound(next);
    graph.current?.panTo(next);
  };
  const closeFind = () => (setQuery(null), setFound(null));
  useEffect(
    () => graph.current?.setHighlighted(draft ? (picked.length ? picked : null) : matches.length ? matches : null),
    [draft, picked, matchKey],
  );

  // With links, claude starts empty and gets the prompt and the introductions as one first message from its inbox.
  const startAgent = async (prompt: string, cwd: string, jump: boolean) => {
    const at = draft!.world, peers = picked;
    prompt = prompt.trim();
    setDraft(null);
    store.set("mf.agentCwd", cwd);
    const s = await api.agent(peers.length ? "" : prompt, cwd.trim() || "~", store.get("mf.bypass") !== "0", prompt);
    placeAt.current.set(s.id, at);
    if (prompt && peers.length) await api.notify(s.id, prompt);
    for (const p of peers) await api.link(s.id, p);
    await onCreated();
    if (peers.length) setEdges([...live.current.edges, ...peers.map((p) => ({ source: s.id, target: p, label: "" }))]);
    if (jump) onOpen(s.id);
  };
  const deleteEditing = () => {
    if (!editing) return;
    setEdges(edges.filter((e) => edgeKey(e.source, e.target) !== edgeKey(editing.source, editing.target)));
    setEditing(null);
  };

  // Hidden by visibility, not display: a collapsed canvas makes the renderer refit the camera to a 1x1 box.
  return (
    // Children inherit visibility, and a transition on it (shadcn's transition-all) would keep them on screen for its duration.
    <div className={cn("absolute inset-0", !visible && "[&_*]:transition-none")} style={{ visibility: visible ? "visible" : "hidden" }}>
      <div ref={el} className="absolute inset-0" />
      <canvas ref={waves} className="pointer-events-none absolute inset-0 size-full" />
      <div className="absolute top-3 left-3 z-10 flex items-center gap-3">
        <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setMode(v as Mode)} className="bg-card shadow-sm">
          <ToggleGroupItem value="select" className="px-3">Select <Kbd className="ml-1">S</Kbd></ToggleGroupItem>
          <ToggleGroupItem value="edit" className="px-3">Edges <Kbd className="ml-1">E</Kbd></ToggleGroupItem>
        </ToggleGroup>
        <Button variant="outline" size="sm" className="bg-card shadow-sm" title="New agent (or double-click the canvas)" onClick={newAgentHere}>
          <Bot /> New agent <Kbd className="ml-1">N</Kbd>
        </Button>
        <Button variant="outline" size="sm" className={cn("bg-card shadow-sm", !showUrls && "text-muted-foreground")} title="Show the URLs each session mentioned" onClick={toggleUrls}>
          <Link2 /> {showUrls ? "Hide links" : "Show links"} <Kbd className="ml-1">L</Kbd>
        </Button>
        {mode === "edit" && <span className="text-xs text-muted-foreground">drag node → node · click an edge to label · right-click to delete</span>}
      </div>
      {query !== null && <FindBar query={query} onQuery={(q) => (setQuery(q), setFound(null))} count={matches.length} at={found ? matches.indexOf(found) : -1} onStep={findStep} onClose={closeFind} />}
      {editing && (
        <div ref={editor} className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 gap-1 rounded-lg border bg-popover p-1 shadow-lg">
          <Input
            autoFocus
            placeholder="label"
            defaultValue={editing.label}
            className="h-7 w-44"
            onChange={(e) => {
              editing.label = e.target.value.trim();
              setEdges([...edges]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") (e.preventDefault(), setEditing(null));
              else if (e.key === "Backspace" && !e.currentTarget.value) (e.preventDefault(), deleteEditing());
            }}
          />
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" title="Delete edge (⌫)" onClick={deleteEditing}>
            <Trash2 />
          </Button>
        </div>
      )}
      {draft && (
        <AgentDraft
          draft={draft}
          folders={[...new Set(sessions.map((s) => s.cwd))]}
          peers={sessions.filter((s) => s.running)}
          picked={picked}
          onToggle={togglePick}
          onStart={startAgent}
          onCancel={() => setDraft(null)}
        />
      )}
      {hovered && !draft && <NodeCard s={hovered} ref={tip} />}
      {hoveredUrl && !draft && <UrlCard url={hoveredUrl} from={sessions.filter((s) => s.links.includes(hoveredUrl))} ref={tip} />}
    </div>
  );
}

// A prompt (blank starts claude idle), who it should talk to, and a folder; opened where the canvas was double-clicked.
function AgentDraft({ draft, folders, peers, picked, onToggle, onStart, onCancel }: {
  draft: Draft;
  folders: string[];
  peers: Session[];
  picked: string[];
  onToggle: (id: string) => void;
  onStart: (prompt: string, cwd: string, jump: boolean) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(() => store.get("mf.agentCwd") || "~");
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") (e.preventDefault(), onStart(prompt, cwd, e.shiftKey));
    else if (e.key === "Escape") (e.preventDefault(), onCancel());
  };
  return (
    <div className="absolute z-30 flex w-80 -translate-x-1/2 -translate-y-1/2 flex-col gap-1.5 rounded-lg border bg-popover p-2 shadow-xl" style={{ left: draft.x, top: draft.y }}>
      <Input autoFocus data-agent-prompt placeholder="What should the agent do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={keys} className="h-8" />
      {peers.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Talks to <span className="opacity-70">(click chips or nodes)</span></span>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
            {peers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onToggle(s.id)}
                className={cn(
                  "flex max-w-full items-center gap-1.5 truncate rounded-md border px-1.5 py-0.5 text-[11px]",
                  picked.includes(s.id) ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <StatusDot s={s} />
                <span className="truncate">{displayName(s)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <Input placeholder="folder" list="mf-folders" value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={keys} className="h-7 font-mono text-xs" />
      <datalist id="mf-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span><Kbd>↵</Kbd> start · <Kbd>⇧↵</Kbd> start &amp; open · <Kbd>Esc</Kbd></span>
        <Button size="sm" className="h-6" onClick={(e) => onStart(prompt, cwd, e.shiftKey)}>Start</Button>
      </div>
    </div>
  );
}

// ↵ and ⇧↵ step through the matching nodes, selecting and centring each; Esc closes.
function FindBar({ query, onQuery, count, at, onStep, onClose }: {
  query: string;
  onQuery: (q: string) => void;
  count: number;
  at: number;
  onStep: (by: 1 | -1) => void;
  onClose: () => void;
}) {
  const status = !query.trim() ? "" : !count ? "No matches" : at === -1 ? String(count) : `${at + 1}/${count}`;
  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-md border bg-card p-1 shadow-sm">
      <Input
        autoFocus
        data-find
        placeholder="Find a session or link"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onStep(e.shiftKey ? -1 : 1);
          else if (e.key === "Escape") onClose();
          else return;
          e.preventDefault();
        }}
        className="h-7 w-52 text-xs"
      />
      <span className="min-w-14 text-center text-[11px] text-muted-foreground tabular-nums">{status}</span>
      <Button variant="ghost" size="icon" className="size-7" title="Previous match (⇧↵)" disabled={!count} onClick={() => onStep(-1)}><ChevronUp /></Button>
      <Button variant="ghost" size="icon" className="size-7" title="Next match (↵)" disabled={!count} onClick={() => onStep(1)}><ChevronDown /></Button>
      <Button variant="ghost" size="icon" className="size-7" title="Close (Esc)" onClick={onClose}><X /></Button>
    </div>
  );
}

function UrlCard({ url, from, ref }: { url: string; from: Session[]; ref: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={ref} className="pointer-events-none absolute z-20 w-max max-w-sm rounded-lg border bg-popover p-3 text-xs shadow-xl">
      <div className="mb-2 font-mono break-all text-foreground">{url}</div>
      <div className="flex flex-col gap-0.5 text-muted-foreground">
        {from.map((s) => (
          <div key={s.id} className="flex items-center gap-1.5">
            <StatusDot s={s} />
            <span className="truncate">{displayName(s)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 border-t pt-2 text-muted-foreground">click to open</p>
    </div>
  );
}

const chatInfo = new Map<string, { title: string; prompt: string } | null>();

function NodeCard({ s, ref }: { s: Session; ref: React.RefObject<HTMLDivElement | null> }) {
  const [, rerender] = useState(0);
  if (s.chatId && !chatInfo.has(s.chatId)) {
    chatInfo.set(s.chatId, null);
    api.chats(s.chatId, 1).then(([c]) => (chatInfo.set(s.chatId!, c ?? { title: "", prompt: "" }), rerender((n) => n + 1)));
  }
  const chat = s.chatId ? chatInfo.get(s.chatId) : null;
  const rows: [string, string][] = [
    ["status", !s.running ? `exited ${s.exitCode ?? "?"}` : isBusy(s) ? "working" : isWaiting(s) ? "waiting on you" : `idle ${ago(s.lastOutputAt)}`],
    ["kind", kindOf(s)],
    ...(s.group ? [["group", s.group] as [string, string]] : []),
    ["command", s.cmd.join(" ")],
    ["folder", home(s.cwd)],
    ["started", `${ago(s.createdAt)} ago`],
    ["viewers", String(s.clients)],
    ["session", s.id],
    ...(s.chatId ? [["chat", s.chatId] as [string, string]] : []),
  ];
  return (
    <div ref={ref} className="pointer-events-none absolute z-20 w-max max-w-sm rounded-lg border bg-popover p-3 text-xs shadow-xl">
      <div className="mb-2 flex items-center gap-2 font-medium break-all text-foreground">
        <StatusDot s={s} />
        {s.name}
      </div>
      <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-mono break-all">{v}</dd>
          </div>
        ))}
      </dl>
      {chat && (chat.prompt || chat.title) && <p className="mt-2 line-clamp-3 border-t pt-2 text-muted-foreground">{chat.prompt || chat.title}</p>}
    </div>
  );
}
