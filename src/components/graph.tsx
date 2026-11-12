import { useEffect, useRef, useState } from "react";
import { GraphRenderer } from "@isaacchacko/graph";
import { renderToStaticMarkup } from "react-dom/server";
import { Archive, Bot, ChevronDown, ChevronUp, Copy, ExternalLink, GitMerge, GitPullRequest, GitPullRequestDraft, Gauge, Hammer, Hash, HeartPulse, Link2, MemoryStick, MessageCircleQuestion, Radar, Route, ScanEye, Shapes, Tag, Trash2, Waypoints, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ago, api, displayName, home, isBusy, isSentry, isWaiting, kindOf, store, type QueuedPr, type ReviewBoard, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/sidebar";

type Edge = { source: string; target: string; label: string };
type Mode = "select" | "edit";
// A group's router starts from a draft filled in for it: its name, brief and folder.
type Draft = { x: number; y: number; world: { x: number; y: number }; name?: string; prompt?: string; cwd?: string };

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const edgeKey = (a: string, b: string) => [a, b].sort().join("|");
// Color says what a node is; whether it is working or waiting on you is drawn inside it by drawPixels.
// A URL a session mentioned is a node of its own under its domain's node, "url:<hub id> <url>".
const URL_NODE = "url:";
const isUrlNode = (id: string) => id.startsWith(URL_NODE);
// Its domain's node already names the host, so a URL is labeled by the rest.
const shortUrl = (u: string) => {
  const pr = u.match(/^https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/);
  if (pr) return `${pr[1]}#${pr[2]}`;
  const t = u.replace(/^https?:\/\/[^/?#]+/, "") || "/";
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
};
// Each group's sessions link to one node per host they mentioned, "domain:<host> <group>", drawn with the site's favicon.
// Clicking it shows or hides its URLs; a host with one URL in the group is that URL's node and opens it.
const DOMAIN_NODE = "domain:";
const isDomainNode = (id: string) => id.startsWith(DOMAIN_NODE);
const hostOf = (u: string) => new URL(u).host.replace(/^www\./, "");
const hubOf = (s: Session, u: string) => `${DOMAIN_NODE}${hostOf(u)} ${s.group ?? s.id}`;
const hostOfHub = (hub: string) => hub.slice(DOMAIN_NODE.length).split(" ")[0];
const urlOfNode = (id: string) => id.slice(id.lastIndexOf(" ") + 1);
const urlNode = (hub: string, u: string) => `${URL_NODE}${hub} ${u}`;
function hubsOf(sessions: Session[]) {
  const hubs = new Map<string, string[]>();
  for (const s of sessions) for (const u of s.links) {
    const urls = hubs.get(hubOf(s, u)) ?? hubs.set(hubOf(s, u), []).get(hubOf(s, u))!;
    if (!urls.includes(u)) urls.push(u);
  }
  return hubs;
}
// A PR's node is colored by whether it is open, closed or merged.
const prColors = (sessions: Session[]) => new Map(sessions.flatMap((s) => Object.entries(s.prs)).map(([u, state]) => [u, css(`--pr-${state}`)]));
// Served by maxflow from the site or Google so it is same-origin; the graph keeps a plain dot if neither loads.
const favicon = (host: string) => `/api/favicon?host=${encodeURIComponent(host)}`;
// A sentry's node shows what it watches, drawn in the sentry color; an agent's shows the role sentry:graph gave it.
const SENTRY_ICONS: Record<string, LucideIcon> = { gh: GitPullRequest, slack: Hash, rename: Tag, health: HeartPulse, graph: Waypoints, review: GitPullRequestDraft, funnel: Route, meta: Gauge, ram: MemoryStick, questions: MessageCircleQuestion };
const ROLE_ICONS: Record<string, LucideIcon> = { review: ScanEye, implement: Hammer, conflicts: GitMerge };
const nodeIcon = (s: Session, color: string) => {
  const Icon = isSentry(s) ? (SENTRY_ICONS[displayName(s)] ?? Radar) : s.role && ROLE_ICONS[s.role];
  if (!Icon) return undefined;
  return `data:image/svg+xml,${encodeURIComponent(renderToStaticMarkup(<Icon color={color} size={48} strokeWidth={2.25} />))}`;
};
// sentry:review's PR queue hangs off its node, drawn with how many PRs on its board need the user; clicking it opens the board.
const QUEUE_NODE = "pr-queue";
const isReviewSentry = (s: Session) => isSentry(s) && s.name === "sentry:review";
const boardCount = (b: ReviewBoard) => b.sections.reduce((n, s) => n + s.items.length, 0);
// What a sleeping agent waits on, as it declared it with `maxflow wait`.
const WAIT_NAMES: Record<string, string> = { q: "the user's answer", approval: "approval", ci: "CI", agent: "an agent", done: "done" };
const waitLabel = (w: NonNullable<Session["wait"]>) => (w.kind === "done" ? "done" : `${w.kind}:${w.kind === "approval" || w.kind === "ci" ? `#${w.ref.split("#")[1]}` : w.ref}`);

const countIcon = (n: number, color: string) =>
  `data:image/svg+xml,${encodeURIComponent(renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><text x="24" y="25" textAnchor="middle" dominantBaseline="central" fill={color} fontFamily="Inter, ui-sans-serif, system-ui, sans-serif" fontWeight={700} fontSize={n > 99 ? 20 : n > 9 ? 28 : 34}>{n}</text></svg>,
  ))}`;
// sentry:graph groups sessions by shared work; every pair in a group is joined by a hidden link that pulls them together.
const groupPulls = (sessions: Session[]) => {
  const byGroup = Map.groupBy(sessions.filter((s) => s.group), (s) => s.group!);
  return [...byGroup.values()].flatMap((g) => g.flatMap((a, i) => g.slice(i + 1).map((b) => ({ source: a.id, target: b.id, length: 1, hidden: true }))));
};
// Each group's outline: the convex hull of a ring of points around each member, so one node gives a circle and two a capsule.
function convexHull(points: [number, number][]) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: [number, number][]) =>
    pts.reduce<[number, number][]>((h, p) => {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      return h.push(p), h;
    }, []);
  const lower = half(points), upper = half([...points].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
const groupHue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
function drawGroups(ctx: CanvasRenderingContext2D, graph: GraphRenderer, sessions: Session[], numbers?: Map<string, number>) {
  for (const [name, members] of Map.groupBy(sessions.filter((s) => s.group), (s) => s.group!)) {
    const ring: [number, number][] = [];
    for (const s of members) {
      const box = graph.getNodeScreenBox(s.id);
      if (!box) continue;
      const r = box.r + 22;
      for (let i = 0; i < 24; i++) ring.push([box.x + r * Math.cos((i / 24) * Math.PI * 2), box.y + r * Math.sin((i / 24) * Math.PI * 2)]);
    }
    if (!ring.length) continue;
    const hull = convexHull(ring), hue = groupHue(name);
    ctx.beginPath();
    hull.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = `hsl(${hue} 70% 65% / 0.07)`;
    ctx.strokeStyle = `hsl(${hue} 70% 65% / 0.45)`;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.fill();
    ctx.stroke();
    // The title sits above the outline, or below it when the toolbar would cover it.
    const top = hull.reduce((a, b) => (b[1] < a[1] ? b : a)), bottom = hull.reduce((a, b) => (b[1] > a[1] ? b : a));
    const above = top[1] - 6 > 60;
    ctx.font = "600 12px Inter, ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = above ? "bottom" : "top";
    ctx.fillStyle = `hsl(${hue} 70% 72%)`;
    const title = numbers?.has(name) ? `${numbers.get(name)} · ${name}` : name;
    ctx.fillText(title, above ? top[0] : bottom[0], above ? top[1] - 6 : bottom[1] + 6);
  }
}
const ARCHIVED = "#484f58";
const sessionColor = (s: Session) => (!s.running || s.archived ? ARCHIVED : isSentry(s) ? css("--sentry") : s.agent ? css("--chat") : css("--foreground"));

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

// One session reading or writing another, from the server's touch/<from>/<to> events; end is null while a wait still watches.
type Touch = { from: string; to: string; kind: "read" | "write"; start: number; end: number | null };
type Box = { x: number; y: number; r: number };
const FLY = 650, ACT = 1200, FADE = 450, HELD_LIMIT = 15 * 60_000;
const actingUntil = (t: Touch) => (t.end === null ? Infinity : Math.max(t.start + FLY + ACT, t.end));
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
// The cursor flies along an arc, so it doesn't hide under a hand-drawn edge between the same two nodes.
function arc(a: Box, b: Box) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const c = { x: (a.x + b.x) / 2 - dy * 0.25, y: (a.y + b.y) / 2 + dx * 0.25 };
  const rim = (n: Box) => {
    const d = Math.hypot(c.x - n.x, c.y - n.y) || 1;
    return { x: n.x + ((c.x - n.x) / d) * n.r, y: n.y + ((c.y - n.y) / d) * n.r };
  };
  const p0 = rim(a), p1 = rim(b);
  const at = (u: number) => ({ x: (1 - u) ** 2 * p0.x + 2 * (1 - u) * u * c.x + u * u * p1.x, y: (1 - u) ** 2 * p0.y + 2 * (1 - u) * u * c.y + u * u * p1.y });
  const heading = (u: number) => Math.atan2(2 * (1 - u) * (c.y - p0.y) + 2 * u * (p1.y - c.y), 2 * (1 - u) * (c.x - p0.x) + 2 * u * (p1.x - c.x));
  return { at, heading };
}
// A pointer flies from the reader to the node it touches, then scans it top to bottom (read) or streams packets into it (write).
function drawTouch(ctx: CanvasRenderingContext2D, t: Touch, a: Box, b: Box, now: number, color: string, ink: string) {
  const elapsed = now - t.start, flown = ease(Math.min(1, elapsed / FLY)), acting = elapsed - FLY;
  const path = arc(a, b);
  ctx.save();
  ctx.globalAlpha = now <= actingUntil(t) ? 1 : Math.max(0, 1 - (now - actingUntil(t)) / FADE);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.25;
  const faded = (alpha: number, paint: () => void) => {
    ctx.save();
    ctx.globalAlpha *= alpha;
    paint();
    ctx.restore();
  };
  faded(0.45, () => {
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let i = 0; i <= 32; i++) {
      const p = path.at((i / 32) * flown);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
  });
  // A small node gets a lens wider than itself, or the scan line would be a few pixels long.
  const lens = Math.max(b.r + 1, 12);
  if (acting > 0) {
    if (t.kind === "read") {
      ctx.save();
      ctx.beginPath();
      ctx.arc(b.x, b.y, lens, 0, Math.PI * 2);
      ctx.clip();
      const y = b.y - lens + ((acting % 900) / 900) * 2 * lens;
      const glow = ctx.createLinearGradient(0, y - lens * 0.7, 0, y);
      glow.addColorStop(0, "transparent");
      glow.addColorStop(1, color);
      faded(0.4, () => ((ctx.fillStyle = glow), ctx.fillRect(b.x - lens, y - lens * 0.7, lens * 2, lens * 0.7)));
      ctx.fillRect(b.x - lens, y - 0.75, lens * 2, 1.5);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(b.x, b.y, lens + 2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      for (let k = 0; k < 3; k++) {
        const p = path.at((acting / 700 + k / 3) % 1);
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      }
      const pulse = (acting % 700) / 700;
      faded(1 - pulse, () => (ctx.beginPath(), ctx.arc(b.x, b.y, lens + 2 + 10 * pulse, 0, Math.PI * 2), ctx.stroke()));
    }
  }
  const tip = path.at(flown), angle = path.heading(Math.max(flown, 0.001));
  const hover = acting > 0 ? Math.sin(acting / 160) * 1.5 : 0;
  ctx.translate(tip.x + Math.cos(angle + Math.PI / 2) * hover, tip.y + Math.sin(angle + Math.PI / 2) * hover);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-16, -7);
  ctx.lineTo(-11, 0);
  ctx.lineTo(-16, 7);
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ink;
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

// One node per session, linked by edges drawn by hand; drawing one asks why, then introduces the two ends with that reason, and edges live in this browser and go when either session does.
export function GraphView({ sessions: all, visible, current, hideArchived, onOpen, onCreated, onArchive, onArchiveLinks, onToggleArchived }: {
  sessions: Session[];
  visible: boolean;
  current: string | null;
  hideArchived: boolean;
  onOpen: (id: string) => void;
  onCreated: () => Promise<unknown>;
  onArchive: (id: string, archived: boolean) => void;
  onArchiveLinks: (urls: string[], archived: boolean) => void;
  onToggleArchived: () => void;
}) {
  // Edges to a hidden archived session are kept, so they come back when it is shown again; archived links hide along with them.
  const archivedUrls = new Set(all.flatMap((s) => s.archivedLinks));
  const sessions = hideArchived ? all.filter((s) => !s.archived).map((s) => ({ ...s, links: s.links.filter((u) => !archivedUrls.has(u)) })) : all;
  const allArchived = (urls: string[]) => urls.every((u) => archivedUrls.has(u));
  const prs = prColors(sessions);
  const el = useRef<HTMLDivElement>(null);
  const graph = useRef<GraphRenderer | null>(null);
  const [edges, setEdgesState] = useState<Edge[]>(() => { try { return JSON.parse(store.get("mf.edges") || "[]"); } catch { return []; } });
  const [mode, setMode] = useState<Mode>("select");
  const [showUrls, setShowUrls] = useState(() => store.get("mf.urls") !== "0");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [showTitles, setShowTitles] = useState(() => store.get("mf.titles") !== "0");
  const [showGroups, setShowGroups] = useState(() => store.get("mf.groups") === "1");
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<Edge | null>(null);
  const [review, setReview] = useState<{ board: ReviewBoard | null; queue: QueuedPr[] }>({ board: null, queue: [] });
  const [showQueue, setShowQueue] = useState(false);
  // A just-drawn edge waiting for its reason; nobody is introduced until it gets one.
  const unsent = useRef<Edge | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Sessions the new agent will be linked with; clicking nodes while drafting toggles them.
  const [picked, setPicked] = useState<string[]>([]);
  // ⌘F: null while the find bar is closed.
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<string | null>(null);
  // Where a just-created agent should first appear: the spot that was double-clicked.
  const placeAt = useRef(new Map<string, { x: number; y: number }>());
  const fitted = useRef(false);
  const pending = useRef("");
  const [pendingKeys, setPendingKeys] = useState("");
  // While a G chord is pending, every group is outlined with the number that picks it.
  const pickingGroup = pendingKeys.startsWith("G");
  const tip = useRef<HTMLDivElement>(null), editor = useRef<HTMLDivElement>(null), waves = useRef<HTMLCanvasElement>(null), hulls = useRef<HTMLCanvasElement>(null), cursors = useRef<HTMLCanvasElement>(null);
  const touches = useRef(new Map<string, Touch>());
  const [touched, setTouched] = useState(0);
  const live = useRef({ edges, mode, onOpen, onArchive, onArchiveLinks, archivedUrls, onToggleArchived, newAgentHere: () => {}, toggleQueue: () => {}, toggleHub: (_hub: string) => {}, toggleUrls: () => {}, toggleGroups: () => {}, toggleTitles: () => {}, sessions, drafting: false, togglePick: (_id: string) => {}, groupChords: {} as Record<string, () => void>, groupNumbers: new Map<string, number>() });

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
      if (id === QUEUE_NODE) {
        if (!live.current.drafting) live.current.toggleQueue();
      } else if (isDomainNode(id) || isUrlNode(id)) {
        const urls = isDomainNode(id) ? (hubsOf(live.current.sessions).get(id) ?? []) : [urlOfNode(id)];
        if (live.current.drafting) return;
        if (urls.length === 1) open(urls[0], "_blank", "noopener");
        else live.current.toggleHub(id);
      } else if (live.current.drafting) live.current.togglePick(id);
      else if (live.current.mode === "select") live.current.onOpen(id);
    });
    g.on("nodeContextMenu", ({ id, event }) => {
      event.preventDefault();
      if (id === QUEUE_NODE) return;
      if (isDomainNode(id) || isUrlNode(id)) {
        const urls = isDomainNode(id) ? (hubsOf(live.current.sessions).get(id) ?? []) : [urlOfNode(id)];
        return live.current.onArchiveLinks(urls, !urls.every((u) => live.current.archivedUrls.has(u)));
      }
      const s = live.current.sessions.find((s) => s.id === id);
      if (s) live.current.onArchive(id, !s.archived);
    });
    g.on("connect", ({ source, target }) => {
      const { edges } = live.current;
      if (source === target || [source, target].some((id) => id === QUEUE_NODE || isUrlNode(id) || isDomainNode(id)) || edges.some((e) => edgeKey(e.source, e.target) === edgeKey(source, target))) return;
      const edge = { source, target, label: "" };
      setEdges([...edges, edge]);
      unsent.current = edge;
      setEditing(edge);
    });
    g.on("linkClick", ({ source, target }) => setEditing(live.current.edges.find((e) => edgeKey(e.source, e.target) === edgeKey(source, target)) ?? null));
    g.on("linkContextMenu", ({ source, target, event }) => {
      event.preventDefault();
      setEditing(null);
      setEdges(live.current.edges.filter((e) => edgeKey(e.source, e.target) !== edgeKey(source, target)));
    });
    g.on("backgroundClick", () => (setEditing(null), setDraft(null), setShowQueue(false)));
    g.on("backgroundDoubleClick", ({ world, event }) => {
      const r = el.current!.getBoundingClientRect();
      setEditing(null);
      setDraft({ x: event.clientX - r.left, y: event.clientY - r.top, world });
    });
    graph.current = g;
  }, [visible]);

  // Fast Refresh reruns every effect, so a destroyed renderer must be dropped for the effect above to build a new one.
  useEffect(() => () => {
    graph.current?.destroy();
    graph.current = null;
  }, []);

  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    const ids = new Set(all.map((s) => s.id)), shown = new Set(sessions.map((s) => s.id));
    const kept = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    if (all.length && kept.length !== edges.length) return setEdges(kept);
    const hubs = showUrls ? hubsOf(sessions) : new Map<string, string[]>();
    const reviewer = review.board && sessions.find(isReviewSentry);
    const children = [...hubs].filter(([hub, urls]) => urls.length > 1 && !collapsed.includes(hub)).flatMap(([hub, urls]) => urls.map((u) => urlNode(hub, u)));
    g.setData({
      nodes: [
        ...sessions.map((s) => {
          const at = placeAt.current.get(s.id);
          placeAt.current.delete(s.id);
          return { id: s.id, label: showTitles ? `${s.name}${s.wait ? ` · ⏸ ${waitLabel(s.wait)}` : ""}` : "", color: sessionColor(s), icon: nodeIcon(s, sessionColor(s)), size: (s.agent || isSentry(s) ? 2.4 : 1.8) * (isBusy(s) || isWaiting(s) ? 1.6 : 1), ...at };
        }),
        ...children.map((id) => ({ id, label: "", color: archivedUrls.has(urlOfNode(id)) ? ARCHIVED : (prs.get(urlOfNode(id)) ?? css("--url")), size: 1 })),
        ...[...hubs].map(([hub, urls]) => ({ id: hub, label: showTitles ? hostOfHub(hub) : "", color: allArchived(urls) ? ARCHIVED : (urls.length === 1 && prs.get(urls[0])) || css("--url"), icon: favicon(hostOfHub(hub)), size: 3 })),
        ...(reviewer ? [{ id: QUEUE_NODE, label: showTitles ? "PR queue" : "", color: css("--sentry"), icon: countIcon(boardCount(review.board!), css("--sentry")), size: 3 }] : []),
      ],
      links: [
        ...edges.filter((e) => shown.has(e.source) && shown.has(e.target)).map((e) => ({ source: e.source, target: e.target, label: e.label })),
        ...sessions.flatMap((s) => (s.ties ?? []).filter((t) => shown.has(t.session)).map((t) => ({ source: s.id, target: t.session, label: t.label }))),
        ...groupPulls(sessions),
        ...(showUrls ? sessions.flatMap((s) => [...new Set(s.links.map((u) => hubOf(s, u)))].map((hub) => ({ source: s.id, target: hub, length: 0.6 }))) : []),
        ...children.map((id) => ({ source: id.slice(URL_NODE.length, id.lastIndexOf(" ")), target: id, length: 0.4 })),
        ...(reviewer ? [{ source: reviewer.id, target: QUEUE_NODE, length: 0.6 }] : []),
      ],
    } as never);
    if (!fitted.current && sessions.length) (fitted.current = true), g.zoomToFit();
  }, [all, hideArchived, edges, visible, showUrls, showTitles, collapsed, review]);

  useEffect(() => graph.current?.setOptions({ mode } as never), [mode, visible]);
  useEffect(() => {
    if (!graph.current || !visible) return;
    const node = found ?? (showQueue ? QUEUE_NODE : current);
    graph.current.setSelection(editing ? { kind: "link", source: editing.source, target: editing.target } : node ? { kind: "node", id: node } : null);
  }, [editing, found, current, visible, showQueue]);
  useEffect(() => {
    if (!visible) (setHover(null), setEditing(null), setDraft(null), setQuery(null), setShowQueue(false));
    else (document.activeElement as HTMLElement | null)?.blur(); // the hidden terminal would otherwise keep the keyboard and swallow S/E
  }, [visible]);
  useEffect(() => setEditing(null), [mode]);

  // Group outlines are redrawn every frame so they follow the layout as it moves.
  useEffect(() => {
    const canvas = hulls.current!, ctx = canvas.getContext("2d")!;
    const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!visible || (!showGroups && !pickingGroup)) return clear();
    let frame = 0;
    const draw = () => {
      const dpr = devicePixelRatio, w = el.current!.offsetWidth, h = el.current!.offsetHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) (canvas.width = w * dpr), (canvas.height = h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      clear();
      if (graph.current) drawGroups(ctx, graph.current, live.current.sessions, pickingGroup ? live.current.groupNumbers : undefined);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => (cancelAnimationFrame(frame), clear());
  }, [visible, showGroups, pickingGroup]);

  useEffect(() => {
    if (!visible) return;
    const load = () => api.review().then(setReview, () => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const stop = new AbortController();
    (async () => {
      let after = "now";
      while (!stop.signal.aborted) {
        try {
          const res = await fetch(`/api/events?topic=touch/**&after=${after}&wait=60000`, { signal: stop.signal });
          const events: { seq: number; data: { from: string; to: string; kind: Touch["kind"]; held: boolean } }[] = await res.json();
          after = String(events.at(-1)?.seq ?? res.headers.get("x-maxflow-seq"));
          const now = performance.now();
          for (const { data: d } of events) {
            const key = `${d.from}>${d.to}>${d.kind}`, prev = touches.current.get(key);
            const ongoing = prev && now < actingUntil(prev);
            if (d.held) touches.current.set(key, { ...d, start: ongoing ? prev.start : now, end: null });
            else if (ongoing) prev.end = now;
            else touches.current.set(key, { ...d, start: now, end: now });
          }
          if (events.length) setTouched((n) => n + 1);
        } catch {
          if (!stop.signal.aborted) await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    return () => stop.abort();
  }, [visible]);

  useEffect(() => {
    const canvas = cursors.current!, ctx = canvas.getContext("2d")!;
    const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!visible) return clear();
    const ink = css("--background"), colors = { read: css("--read"), write: css("--write") };
    let frame = 0;
    const draw = (now: number) => {
      const dpr = devicePixelRatio, w = el.current!.offsetWidth, h = el.current!.offsetHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) (canvas.width = w * dpr), (canvas.height = h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      clear();
      for (const [key, t] of touches.current) {
        if (now > actingUntil(t) + FADE || now - t.start > HELD_LIMIT) {
          touches.current.delete(key);
          continue;
        }
        const a = graph.current?.getNodeScreenBox(t.from), b = graph.current?.getNodeScreenBox(t.to);
        if (a && b) drawTouch(ctx, t, a, b, now, colors[t.kind], ink);
      }
      if (touches.current.size) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => (cancelAnimationFrame(frame), clear());
  }, [visible, touched]);

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
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Shift") return;
      clearTimeout(chordTimer);
      if (e.key === "Escape") {
        e.preventDefault();
        if (pending.current) return setChord("");
        return setEditing(null), setDraft(null), setShowQueue(false);
      }
      const seq = pending.current + e.key;
      const all = { ...chords, ...live.current.groupChords };
      const action = all[seq];
      if (action) (e.preventDefault(), setChord(""), action());
      else if (Object.keys(all).some((c) => c.startsWith(seq))) {
        e.preventDefault();
        setChord(seq);
        chordTimer = setTimeout(() => setChord(""), seq.startsWith("G") ? 4000 : 1000);
      } else setChord("");
    };
    // Vim-style: a prefix key waits up to a second for the rest of its chord.
    const chords: Record<string, () => void> = {
      s: () => setMode("select"),
      e: () => setMode("edit"),
      n: () => live.current.newAgentHere(),
      hl: () => live.current.toggleUrls(),
      hg: () => live.current.toggleGroups(),
      ha: () => live.current.onToggleArchived(),
      ht: () => live.current.toggleTitles(),
    };
    const setChord = (seq: string) => ((pending.current = seq), setPendingKeys(seq));
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    addEventListener("keydown", onKey);
    return () => (removeEventListener("keydown", onKey), clearTimeout(chordTimer), setChord(""));
  }, [visible]);

  // What the pending-chord panel lists; keys must match the chords table above.
  const chordLabels: Record<string, string> = {
    s: "select",
    e: "edges",
    n: "new agent",
    hl: showUrls ? "hide links" : "show links",
    hg: showGroups ? "hide groups" : "show groups",
    ha: hideArchived ? "show archived" : "hide archived",
    ht: showTitles ? "hide node titles" : "show node titles",
  };
  // G<n> picks a group (numbered in its outline), then a key acts on all of it: r starts a router for it.
  const groups = Map.groupBy(sessions.filter((s) => s.group && s.running && !s.archived && !isSentry(s)), (s) => s.group!);
  const groupNames = [...groups.keys()].sort().slice(0, 9);
  const groupNumbers = new Map(groupNames.map((name, i) => [name, i + 1]));
  const groupChords: Record<string, () => void> = {};
  groupNames.forEach((name, i) => {
    groupChords[`G${i + 1}r`] = () => routerFor(name);
    chordLabels[`G${i + 1}r`] = `router for ${name}`;
  });
  // The new-agent draft, filled in for a router: every running member picked, so each is introduced to it.
  const routerFor = (name: string) => {
    const members = groups.get(name) ?? [];
    const r = el.current!.getBoundingClientRect();
    const boxes = members.flatMap((s) => graph.current!.getNodeScreenBox(s.id) ?? []);
    const mid = (k: "x" | "y", size: number) =>
      Math.min(Math.max(boxes.length ? boxes.reduce((a, b) => a + b[k], 0) / boxes.length : size / 2, 170), size - 170);
    const x = mid("x", r.width), y = mid("y", r.height);
    const cwds = Map.groupBy(members, (s) => s.cwd);
    const cwd = [...cwds.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
    setEditing(null);
    setDraft({
      x,
      y,
      world: graph.current!.screenToWorld({ x, y }),
      name: `router: ${name}`,
      cwd: cwd && home(cwd),
      prompt: `You're the router for "${name}", the ${members.length === 1 ? "session" : `${members.length} sessions`} sentry:graph grouped as that work; you've been introduced to each below. Find out what each is doing, keep them from duplicating or colliding with each other's work, pass along what one needs from another, and tell me only what needs me.`,
    });
    setPicked(members.map((s) => s.id));
  };
  const hovered = sessions.find((s) => s.id === hover);
  const hoveredUrl = hover && isUrlNode(hover) ? urlOfNode(hover) : null;
  const hoveredHub = hover && isDomainNode(hover) ? hover : null;
  const hubUrls = hoveredHub ? (hubsOf(sessions).get(hoveredHub) ?? []) : [];
  const toggleQueue = () => setShowQueue((q) => !q);
  const toggleHub = (hub: string) => setCollapsed((e) => (e.includes(hub) ? e.filter((h) => h !== hub) : [...e, hub]));
  const newAgentHere = () => {
    const r = el.current!.getBoundingClientRect();
    setEditing(null);
    setDraft({ x: r.width / 2, y: r.height / 2, world: graph.current!.screenToWorld({ x: r.width / 2, y: r.height / 2 }) });
  };
  const togglePick = (id: string) => {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    document.querySelector<HTMLInputElement>("[data-agent-prompt]")?.focus();
  };
  const toggleGroups = () => {
    store.set("mf.groups", showGroups ? "0" : "1");
    setShowGroups(!showGroups);
  };
  const toggleTitles = () => {
    store.set("mf.titles", showTitles ? "0" : "1");
    setShowTitles(!showTitles);
  };
  const toggleUrls = () => {
    store.set("mf.urls", showUrls ? "0" : "1");
    setShowUrls(!showUrls);
  };
  live.current = { edges, mode, onOpen, onArchive, onArchiveLinks, archivedUrls, onToggleArchived, newAgentHere, toggleQueue, toggleHub, toggleUrls, toggleGroups, toggleTitles, sessions, drafting: !!draft, togglePick, groupChords, groupNumbers };
  useEffect(() => { if (!draft) setPicked([]); }, [draft]);
  const needle = query?.trim().toLowerCase();
  const matches = needle
    ? [
        ...sessions.filter((s) => displayName(s).toLowerCase().includes(needle)).map((s) => s.id),
        ...(showUrls ? [...hubsOf(sessions)].flatMap(([hub, urls]) => urls.filter((u) => u.toLowerCase().includes(needle)).map((u) => (!collapsed.includes(hub) && urls.length > 1 ? urlNode(hub, u) : hub))).filter((id, i, a) => a.indexOf(id) === i) : []),
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
  const startAgent = async (prompt: string, cwd: string, jump: boolean, route: boolean) => {
    const at = draft!.world, name = draft!.name, peers = picked;
    prompt = prompt.trim();
    setDraft(null);
    // A bare request goes to the funnel sentry, which hands it to the agent that owns it or starts one.
    const funnel = all.find((s) => isSentry(s) && s.name === "sentry:funnel" && s.running);
    if (route && funnel && prompt && !peers.length) return void api.notify(funnel.id, prompt);
    store.set("mf.agentCwd", cwd);
    const s = await api.agent(peers.length ? "" : prompt, cwd.trim() || "~", store.get("mf.bypass") !== "0", name ?? prompt);
    placeAt.current.set(s.id, at);
    if (prompt && peers.length) await api.notify(s.id, prompt);
    for (const p of peers) await api.link(s.id, p);
    await onCreated();
    if (peers.length) setEdges([...live.current.edges, ...peers.map((p) => ({ source: s.id, target: p, label: "" }))]);
    if (jump) onOpen(s.id);
  };
  // Closing a drawn edge's box without a reason drops the edge.
  useEffect(() => {
    const u = unsent.current;
    if (u && editing !== u) (unsent.current = null), setEdges(live.current.edges.filter((e) => e !== u));
  }, [editing]);
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
      <canvas ref={hulls} className="pointer-events-none absolute inset-0 size-full" />
      <canvas ref={waves} className="pointer-events-none absolute inset-0 size-full" />
      <canvas ref={cursors} className="pointer-events-none absolute inset-0 size-full" />
      <div className="absolute top-3 left-3 z-10 flex items-center gap-3">
        <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setMode(v as Mode)} className="bg-card shadow-sm">
          <ToggleGroupItem value="select" className="px-3">Select <Kbd className="ml-1">S</Kbd></ToggleGroupItem>
          <ToggleGroupItem value="edit" className="px-3">Edges <Kbd className="ml-1">E</Kbd></ToggleGroupItem>
        </ToggleGroup>
        <Button variant="outline" size="sm" className="bg-card shadow-sm" title="New agent (or double-click the canvas)" onClick={newAgentHere}>
          <Bot /> New agent <Kbd className="ml-1">N</Kbd>
        </Button>
        <Button variant="outline" size="sm" className={cn("bg-card shadow-sm", !showUrls && "text-muted-foreground")} title="Show the URLs each session mentioned" onClick={toggleUrls}>
          <Link2 /> {showUrls ? "Hide links" : "Show links"} <Kbd className="ml-1">hl</Kbd>
        </Button>
        <Button variant="outline" size="sm" className={cn("bg-card shadow-sm", !showGroups && "text-muted-foreground")} title="Outline the groups sentry:graph sorted sessions into" onClick={toggleGroups}>
          <Shapes /> {showGroups ? "Hide groups" : "Show groups"} <Kbd className="ml-1">hg</Kbd>
        </Button>
        <Button variant="outline" size="sm" className={cn("bg-card shadow-sm", hideArchived && "text-muted-foreground")} title="Right-click a node or link to archive or unarchive it" onClick={onToggleArchived}>
          <Archive /> {hideArchived ? "Show archived" : "Hide archived"} <Kbd className="ml-1">ha</Kbd>
        </Button>
        <WaitCounts sessions={all} />
        {mode === "edit" && <span className="text-xs text-muted-foreground">drag node → node and say why · click an edge to relabel · right-click to delete</span>}
      </div>
      {pendingKeys && (
        <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1.5 rounded-lg border bg-popover p-2.5 text-sm shadow-lg">
          <Kbd className="h-6 w-fit px-2 font-mono text-sm text-foreground">{pendingKeys}</Kbd>
          {Object.entries(chordLabels).filter(([keys]) => keys.startsWith(pendingKeys)).map(([keys, label]) => (
            <div key={keys} className="flex items-center gap-2">
              <Kbd className="font-mono">{keys.slice(pendingKeys.length)}</Kbd>
              <span className="text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      )}
      {query !== null && <FindBar query={query} onQuery={(q) => (setQuery(q), setFound(null))} count={matches.length} at={found ? matches.indexOf(found) : -1} onStep={findStep} onClose={closeFind} />}
      {editing && (
        <div ref={editor} className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 gap-1 rounded-lg border bg-popover p-1 shadow-lg">
          <Input
            autoFocus
            placeholder={unsent.current === editing ? "why link these?" : "label"}
            defaultValue={editing.label}
            className={cn("h-7", unsent.current === editing ? "w-72" : "w-44")}
            onChange={(e) => {
              editing.label = e.target.value.trim();
              setEdges([...edges]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && unsent.current === editing) {
                e.preventDefault();
                if (!editing.label) return;
                unsent.current = null;
                api.link(editing.source, editing.target, editing.label);
                setEditing(null);
              } else if (e.key === "Enter" || e.key === "Escape") (e.preventDefault(), setEditing(null));
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
          peers={sessions.filter((s) => s.running && !s.archived)}
          picked={picked}
          onToggle={togglePick}
          onStart={startAgent}
          onCancel={() => setDraft(null)}
        />
      )}
      {showQueue && review.board && <QueuePanel board={review.board} queue={review.queue} onOpen={onOpen} onClose={() => setShowQueue(false)} />}
      {hovered && !draft && <NodeCard s={hovered} ref={tip} />}
      {hoveredUrl && !draft && <UrlCard url={hoveredUrl} from={sessions.filter((s) => s.links.includes(hoveredUrl))} archived={archivedUrls.has(hoveredUrl)} ref={tip} />}
      {hoveredHub && !draft && (hubUrls.length === 1
        ? <UrlCard url={hubUrls[0]} from={sessions.filter((s) => s.links.includes(hubUrls[0]))} archived={archivedUrls.has(hubUrls[0])} ref={tip} />
        : <DomainCard host={hostOfHub(hoveredHub)} urls={hubUrls} archived={archivedUrls} expanded={!collapsed.includes(hoveredHub)} ref={tip} />)}
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
  onStart: (prompt: string, cwd: string, jump: boolean, route: boolean) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState(draft.prompt ?? "");
  const [cwd, setCwd] = useState(() => draft.cwd || store.get("mf.agentCwd") || "~");
  const [cwdTouched, setCwdTouched] = useState(false);
  // ↵ routes through the funnel unless the folder or peers say where the work goes; ⇧↵ always starts a new agent.
  const start = (shift: boolean) => onStart(prompt, cwd, shift, !shift && !cwdTouched && !draft.cwd && !draft.name);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") (e.preventDefault(), start(e.shiftKey));
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
      <Input placeholder="folder" list="mf-folders" value={cwd} onChange={(e) => (setCwd(e.target.value), setCwdTouched(true))} onKeyDown={keys} className="h-7 font-mono text-xs" />
      <datalist id="mf-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span><Kbd>↵</Kbd> {picked.length || cwdTouched ? "start" : "route"} · <Kbd>⇧↵</Kbd> new &amp; open · <Kbd>Esc</Kbd></span>
        <Button size="sm" className="h-6" onClick={(e) => start(e.shiftKey)}>Start</Button>
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

// The bottleneck as a count: how many agents sleep on each kind of wait, the user's answers and approvals first.
function WaitCounts({ sessions }: { sessions: Session[] }) {
  const asleep = sessions.filter((s) => s.running && s.wait);
  if (!asleep.length) return null;
  const byKind = Map.groupBy(asleep, (s): string => s.wait!.kind);
  const kinds = Object.keys(WAIT_NAMES).filter((k) => byKind.has(k));
  return (
    <span className="rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground shadow-sm" title={asleep.map((s) => `${s.name}: ${waitLabel(s.wait!)}`).join("\n")}>
      asleep on {kinds.map((k) => `${byKind.get(k)!.length} ${WAIT_NAMES[k]}`).join(" · ")}
    </span>
  );
}

// Stages of an open PR, nearest prod first, as sentries/review.ts names them.
const STAGES = ["merging", "approved", "needs reviewer", "in review", "ci running", "changes requested", "ci failing", "conflict", "draft"];
const stageRank = (stage: string) => (STAGES.includes(stage) ? STAGES.indexOf(stage) : STAGES.length);

// sentry:review's board: the one thing to do next, its sections of PRs that need the user, then every open PR by stage.
function QueuePanel({ board, queue, onOpen, onClose }: { board: ReviewBoard; queue: QueuedPr[]; onOpen: (id: string) => void; onClose: () => void }) {
  const byStage = [...Map.groupBy(queue, (p) => p.stage)].sort(([a], [b]) => stageRank(a) - stageRank(b));
  return (
    <div className="absolute top-14 right-3 bottom-3 z-20 flex w-[26rem] max-w-[calc(100%-1.5rem)] flex-col rounded-lg border bg-popover text-xs shadow-xl">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <GitPullRequestDraft className="size-4 text-sentry" />
        <span className="font-medium text-foreground">PR queue</span>
        <span className="text-muted-foreground">updated {ago(Date.parse(board.updated))} ago</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" title="Close (Esc)" onClick={onClose}><X /></Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {board.request && (
          <section className="flex flex-col gap-1.5 rounded-md border p-2.5">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-foreground">Review request</h3>
              <span className="text-muted-foreground">paste to a teammate</span>
              <Button variant="outline" size="sm" className="ml-auto h-6" onClick={() => navigator.clipboard.writeText(board.request!)}><Copy /> Copy</Button>
            </div>
            <pre className="max-h-40 overflow-y-auto font-sans whitespace-pre-wrap text-muted-foreground">{board.request}</pre>
          </section>
        )}
        {board.next && <p className="rounded-md border border-sentry/40 bg-sentry/10 p-2.5 text-sm text-foreground">{board.next}</p>}
        {board.sections.map((section) => (
          <section key={section.title} className="flex flex-col gap-1">
            <h3 className="font-medium text-foreground">{section.title} <span className="text-muted-foreground">{section.items.length}</span></h3>
            {section.items.map((item) => (
              <div key={item.url} className="flex items-baseline gap-2">
                <PrLink url={item.url} label={item.pr} />
                <span className="text-muted-foreground">{item.note}</span>
              </div>
            ))}
          </section>
        ))}
        <section className="flex flex-col gap-3 border-t pt-3">
          <h3 className="font-medium text-foreground">Every open PR <span className="text-muted-foreground">{queue.length}</span></h3>
          {byStage.map(([stage, prs]) => (
            <div key={stage} className="flex flex-col gap-1">
              <h4 className="text-[11px] tracking-wide text-muted-foreground uppercase">{stage} · {prs.length}</h4>
              {prs.map((p) => (
                <div key={p.url} className="flex flex-col">
                  <div className="flex items-baseline gap-2">
                    <PrLink url={p.url} label={p.pr.replace(/^[\w.-]+\//, "")} />
                    <span className="truncate text-foreground" title={p.title}>{p.title}</span>
                  </div>
                  {p.sessions.length > 0 && (
                    <div className="flex flex-wrap gap-x-2 pl-1 text-muted-foreground">
                      {p.sessions.map((s) => <button key={s.id} type="button" className="truncate hover:text-foreground hover:underline" onClick={() => onOpen(s.id)}>{s.name}</button>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function PrLink({ url, label }: { url: string; label: string }) {
  return (
    <a href={url} target="_blank" rel="noopener" className="inline-flex shrink-0 items-center gap-1 font-mono text-url hover:underline">
      {label}
      <ExternalLink className="size-3" />
    </a>
  );
}

function UrlCard({ url, from, archived, ref }: { url: string; from: Session[]; archived: boolean; ref: React.RefObject<HTMLDivElement | null> }) {
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
      <p className="mt-2 border-t pt-2 text-muted-foreground">click to open · right-click to {archived ? "unarchive" : "archive"}</p>
    </div>
  );
}

function DomainCard({ host, urls, archived, expanded, ref }: { host: string; urls: string[]; archived: Set<string>; expanded: boolean; ref: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={ref} className="pointer-events-none absolute z-20 w-max max-w-sm rounded-lg border bg-popover p-3 text-xs shadow-xl">
      <div className="mb-2 font-mono text-foreground">{host}</div>
      <div className="flex flex-col gap-0.5 font-mono text-muted-foreground">
        {urls.map((u) => <span key={u} className={cn("truncate", archived.has(u) && "line-through opacity-60")}>{shortUrl(u)}</span>)}
      </div>
      <p className="mt-2 border-t pt-2 text-muted-foreground">click to {expanded ? "hide" : "show"} links · right-click to {urls.every((u) => archived.has(u)) ? "unarchive" : "archive"} all</p>
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
    ["status", `${!s.running ? `exited ${s.exitCode ?? "?"}` : isBusy(s) ? "working" : isWaiting(s) ? "waiting on you" : `idle ${ago(s.lastOutputAt)}`}${s.archived ? " · archived" : ""}`],
    ["kind", kindOf(s)],
    ...(s.wait ? [["waits on", `${waitLabel(s.wait)}, since ${ago(s.wait.at)} ago`] as [string, string]] : []),
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
      <p className="mt-2 border-t pt-2 text-muted-foreground">right-click to {s.archived ? "unarchive" : "archive"}</p>
    </div>
  );
}
