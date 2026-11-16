import { ExternalLink, GitPullRequest, Network, Radar, SquareKanban, Waypoints } from "lucide-react";
import { useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { agentStateColor, statusColor } from "@/mock";
import { agentStore, objectiveStore, prStore, sentryStore, taskStore } from "@/store";

export type Ref = { kind: "agent" | "router" | "task" | "objective"; id: string };
type Part = { text: string } | { ref: Ref } | { url: string; label: string } | { image: string };

// An image is markdown pointing at its file in the server's uploads dir, which the server serves by name.
const TOKEN = /\[\[(agent|router|task|objective):([^\]]+)\]\]|!\[[^\]]*\]\(\S*\/uploads\/([\w.-]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

export function parse(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push(m[1] ? { ref: { kind: m[1] as Ref["kind"], id: m[2]! } } : m[3] ? { image: `/api/uploads/${m[3]}` } : { url: m[5]!, label: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function refsIn(text: string) {
  return parse(text).flatMap(p => ("ref" in p ? [p.ref] : []));
}

export function urlsIn(text: string) {
  return parse(text).flatMap(p => ("url" in p ? [p] : []));
}

export function RefChip({ r }: { r: Ref }) {
  const agents = agentStore.use();
  const tasks = taskStore.use();
  const objectives = objectiveStore.use();

  if (r.kind === "task") {
    const t = tasks.find(x => x.id === r.id);
    return (
      <a href={`#task/${r.id}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 border px-1 align-baseline text-[0.92em] hover:border-ring">
        <span className={cn("size-1.5", t ? statusColor[t.status] : "bg-muted-foreground")} />
        {t?.title ?? r.id}
      </a>
    );
  }
  if (r.kind === "objective") {
    const o = objectives.find(x => x.id === r.id);
    return (
      <a href={`#objective/${r.id}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 border px-1 align-baseline text-[0.92em] hover:border-ring">
        <Waypoints className="size-3 text-agent" />
        {o?.title ?? r.id}
      </a>
    );
  }
  const a = agents.find(x => x.id === r.id);
  return (
    <a href={`#agent/${r.id}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 border px-1 align-baseline font-mono text-[0.85em] hover:border-ring">
      {a?.role === "router" || r.kind === "router" ? <Network className="size-3 text-fuchsia-400" /> : <span className={cn("size-1.5", a ? agentStateColor[a.state] : "bg-muted-foreground")} />}
      {a?.name ?? r.id}
    </a>
  );
}

export function Rich({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {parse(text).map((p, i) =>
        "text" in p ? (
          <span key={i}>{p.text}</span>
        ) : "ref" in p ? (
          <RefChip key={i} r={p.ref} />
        ) : "image" in p ? (
          <a key={i} href={p.image} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="my-1 block w-fit">
            <img src={p.image} alt="" className="max-h-80 max-w-full border" />
          </a>
        ) : (
          <a key={i} href={p.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-sky-400 hover:underline">
            {p.label}
            <ExternalLink className="size-3" />
          </a>
        ),
      )}
    </span>
  );
}

// In markdown a chip is a link to ref:<kind>/<id>, so the link renderer draws it and refs never get parsed twice.
const asLinks = (text: string) => text.replace(/\[\[(agent|router|task|objective):([^\]]+)\]\]/g, (_, kind, id) => `[ref](ref:${kind}/${encodeURIComponent(id)})`);

// A PR or Linear issue named in plain text becomes a link to pr:<owner/repo>/<n> or linear:<key>, so it draws as a chip.
// Code and existing links are other node types, so nothing inside them changes.
const LINEAR = "https://linear.app/dryftai/issue";
const REPO = "dryft-ai/app";
const NAMED = /(?<![\w/&#-])(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d{3,})|((?:PRO|DRY|TI)-\d+))\b/g;
type Node = { type: string; value?: string; url?: string; children?: Node[] };
function chipNamed(node: Node) {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap(child => {
    if (child.type !== "text") return chipNamed(child), [child];
    const out: Node[] = [];
    let last = 0;
    for (const m of child.value!.matchAll(NAMED)) {
      if (m.index > last) out.push({ type: "text", value: child.value!.slice(last, m.index) });
      out.push({ type: "link", url: m[4] ? `linear:${m[4]}` : `pr:${(m[1] ?? REPO).toLowerCase()}/${m[2] ?? m[3]}`, children: [{ type: "text", value: m[0] }] });
      last = m.index + m[0].length;
    }
    if (last < child.value!.length) out.push({ type: "text", value: child.value!.slice(last) });
    return out;
  });
}
const remarkChips = () => chipNamed;

const prColor = { open: "text-emerald-400", merged: "text-violet-400", closed: "text-red-400" } as const;
function PrChip({ repo, n }: { repo: string; n: string }) {
  const pr = prStore.use()[`${repo}#${n}`];
  return (
    <a href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} title={pr?.title} className="inline-flex max-w-96 items-center gap-1 border px-1 align-baseline text-[0.92em] hover:border-ring">
      <GitPullRequest className={cn("size-3 shrink-0", pr ? prColor[pr.state] : "text-muted-foreground")} />
      <span className="shrink-0 tabular-nums">{repo === REPO ? "" : repo}#{n}</span>
      {pr && <span className="truncate text-muted-foreground">{pr.title}</span>}
    </a>
  );
}

function LinearChip({ issue }: { issue: string }) {
  return (
    <a href={`${LINEAR}/${issue}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 border px-1 align-baseline text-[0.92em] tabular-nums hover:border-ring">
      <SquareKanban className="size-3 text-indigo-400" />
      {issue}
    </a>
  );
}

const md: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
  ol: ({ children, start }) => <ol start={start} className="my-1.5 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-0.5 pl-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  code: ({ children, className }) => <code className={cn("bg-muted px-1 font-mono text-[0.9em]", className)}>{children}</code>,
  pre: ({ children }) => <pre className="my-1.5 overflow-x-auto bg-muted p-2.5 text-xs [&>code]:bg-transparent [&>code]:p-0">{children}</pre>,
  table: ({ children }) => <table className="my-1.5 border-collapse text-xs">{children}</table>,
  th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
  hr: () => <hr className="my-3" />,
  a: ({ href = "", children }) => {
    const ref = href.match(/^ref:(agent|router|task|objective)\/(.+)$/);
    if (ref) return <RefChip r={{ kind: ref[1] as Ref["kind"], id: decodeURIComponent(ref[2]!) }} />;
    const pr = href.match(/^pr:([\w.-]+\/[\w.-]+)\/(\d+)$/) ?? href.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/i);
    if (pr) return <PrChip repo={pr[1]!.toLowerCase()} n={pr[2]!} />;
    const issue = href.match(/^linear:([A-Z]+-\d+)$/) ?? href.match(/^https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z]+-\d+)/);
    if (issue) return <LinearChip issue={issue[1]!} />;
    return (
      <a href={href} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-sky-400 hover:underline">
        {children}
        <ExternalLink className="size-3" />
      </a>
    );
  },
  img: ({ src = "" }) => {
    const name = typeof src === "string" && src.match(/\/uploads\/([\w.-]+)$/)?.[1];
    if (!name) return null;
    const url = `/api/uploads/${name}`;
    return (
      <a href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="my-1 block w-fit">
        <img src={url} alt="" className="max-h-80 max-w-full border" />
      </a>
    );
  },
};

/** A whole message as GitHub-flavored markdown, with Rich's chips, links and pasted images inside it. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkChips]} components={md} urlTransform={url => (/^(ref|pr|linear):/.test(url) ? url : defaultUrlTransform(url))}>
        {asLinks(text)}
      </ReactMarkdown>
    </div>
  );
}

// A worker's tile keeps one color for its whole life, picked from its session id.
const TILE = ["bg-sky-600", "bg-emerald-600", "bg-amber-600", "bg-rose-600", "bg-teal-600", "bg-indigo-600", "bg-orange-600", "bg-cyan-700"];
const tileOf = (id: string) => TILE[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TILE.length]!;
const GITHUB_LOGIN = "isaacchacko";

/** A message's sender as a 36px square, Slack-style: Isaac's GitHub picture, and agents in the sidebar's role and state language. */
export function Avatar({ from }: { from: string }) {
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const sentries = sentryStore.use();
  const [broken, setBroken] = useState(false);
  const tile = "relative flex size-9 shrink-0 items-center justify-center text-sm font-semibold";
  if (from === "isaac")
    return broken ? (
      <span className={cn(tile, "bg-sky-600 text-white")}>IC</span>
    ) : (
      <img src={`https://github.com/${GITHUB_LOGIN}.png?size=72`} alt="" onError={() => setBroken(true)} className="size-9 shrink-0 object-cover" />
    );
  if (objectives.some(o => o.id === from))
    return (
      <span className={cn(tile, "border bg-agent/15")}>
        <Waypoints className="size-4 text-agent" />
      </span>
    );
  if (sentries.some(x => x.id === from))
    return (
      <span className={cn(tile, "border bg-muted")}>
        <Radar className="size-4 text-muted-foreground" />
      </span>
    );
  const a = agents.find(x => x.id === from);
  if (a?.role !== "worker")
    return (
      <span className={cn(tile, "border border-fuchsia-400/30 bg-fuchsia-500/15")}>
        <Network className="size-4 text-fuchsia-400" />
      </span>
    );
  return (
    <span className={cn(tile, tileOf(from), "text-white")}>
      {(a.name ?? from).match(/[a-z0-9]/i)?.[0]?.toUpperCase()}
      <span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 ring-2 ring-background", agentStateColor[a.state])} />
    </span>
  );
}

export function Author({ from }: { from: string }) {
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const sentries = sentryStore.use();
  if (from === "isaac") return <span className="text-sm font-semibold">you</span>;
  const o = objectives.find(x => x.id === from);
  if (o)
    return (
      <a href={`#objective/${o.id}`} className="text-sm font-semibold hover:underline">
        {o.title}
      </a>
    );
  return (
    <a href={`#agent/${from}`} className="text-sm font-semibold hover:underline">
      {agents.find(x => x.id === from)?.name ?? sentries.find(x => x.id === from)?.name ?? from}
    </a>
  );
}
