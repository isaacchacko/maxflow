import { ExternalLink, GitPullRequest, MessageSquareQuote, MessagesSquare, Network, Radar, SquareKanban, Waypoints } from "lucide-react";
import { useContext, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentFace, expressionOf } from "@/components/AgentFace";
import { cn } from "@/lib/utils";
import { agentStateColor, statusColor } from "@/mock";
import { agentStore, nameStore, objectiveStore, prStore, sentryStore, taskStore, threadStore } from "@/store";
import { goToMessage } from "./jump";
import { openViewer, ShotScope } from "./Viewer";

// A msg ref is <thread id>/<message id>: a quote's link back to where it came from.
export type Ref = { kind: "agent" | "router" | "task" | "objective" | "thread" | "msg"; id: string };
type Part = { text: string } | { ref: Ref } | { url: string; label: string } | { image: string };

// An image is markdown pointing at its file in the server's uploads dir, which the server serves by name.
const TOKEN = /\[\[(agent|router|task|objective|thread|msg):([^\]]+)\]\]|!\[[^\]]*\]\(\S*\/uploads\/([\w.-]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

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

/**
 * A link to a maxflow entity, opened in place; one that no longer exists is struck through and says so on hover. `still`
 * draws it as plain text in the same look, for a chip inside something that is itself a link or button.
 */
/**
 * A chip is one line whatever it names: its label ends in an ellipsis past min(100%, 28ch) inline in text (the whole width of a
 * list it sits in, `wide`), with the full label in its tooltip; its icon never shrinks. The label carries the baseline, so its text
 * sits on the line's with the words around it; the icon is centred beside it.
 */
const pill = (wide?: boolean) => cn("inline-flex items-baseline gap-1 rounded-full border border-transparent bg-muted px-1.5 align-baseline whitespace-nowrap hover:border-ring [&>:first-child]:shrink-0 [&>:first-child]:self-center", wide ? "max-w-full" : "max-w-[min(100%,28ch)]");

export function RefChip({ r, still, wide }: { r: Ref; still?: boolean; wide?: boolean }) {
  const agents = agentStore.use();
  const tasks = taskStore.use();
  const objectives = objectiveStore.use();
  const threads = threadStore.use();
  const sentries = sentryStore.use();

  const Tag = still ? "span" : "a";
  const chip = (href: string, found: boolean, icon: React.ReactNode, label: string, mono = false) => (
    <Tag
      href={still ? undefined : href}
      onClick={e => e.stopPropagation()}
      title={found ? label : `No ${r.kind} ${r.id} in yarn now`}
      className={cn(pill(wide), mono ? "font-mono text-[0.85em]" : "text-[0.92em]", !found && "border-dashed border-border bg-transparent text-muted-foreground line-through")}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </Tag>
  );

  if (r.kind === "task") {
    const t = tasks.find(x => x.id === r.id);
    return chip(`#task/${r.id}`, !!t, <span className={cn("size-1.5 rounded-full", t ? statusColor[t.status] : "bg-muted-foreground")} />, t?.title ?? r.id);
  }
  if (r.kind === "objective") {
    const o = objectives.find(x => x.id === r.id);
    return chip(`#objective/${r.id}`, !!o, <Waypoints className="size-3 text-agent" />, o?.title ?? r.id);
  }
  if (r.kind === "msg") {
    const [threadId, messageId] = r.id.split("/");
    const m = threads.find(x => x.id === threadId)?.messages.find(x => x.id === messageId);
    const who = m && (m.from === "isaac" ? "you" : (agents.find(x => x.id === m.from)?.name ?? sentries.find(x => x.id === m.from)?.name ?? m.from));
    return (
      <Tag
        href={still ? undefined : `#thread/${threadId}`}
        onClick={e => (e.stopPropagation(), !still && (e.preventDefault(), goToMessage(threadId!, messageId)))}
        title={m ? `${who} · ${m.at.slice(11, 16)}` : `No message ${r.id} in yarn now`}
        className={cn(pill(wide), "text-[0.92em] not-italic", !m && "border-dashed border-border bg-transparent text-muted-foreground line-through")}
      >
        <MessageSquareQuote className="size-3 text-link" />
        <span className="min-w-0 truncate">{m ? `${who} · ${m.at.slice(11, 16)}` : messageId}</span>
      </Tag>
    );
  }
  if (r.kind === "thread") {
    const t = threads.find(x => x.id === r.id);
    return chip(`#thread/${r.id}`, !!t, <MessagesSquare className="size-3 text-link" />, t?.title ?? r.id);
  }
  const a = agents.find(x => x.id === r.id);
  const sentry = sentries.find(x => x.id === r.id);
  return chip(
    `#agent/${r.id}`,
    !!(a ?? sentry),
    a?.role === "router" || r.kind === "router" ? <Network className="size-3 text-router" /> : sentry ? <Radar className="size-3 text-muted-foreground" /> : <span className={cn("size-1.5 rounded-full", a ? agentStateColor[a.state] : "bg-muted-foreground")} />,
    a?.name ?? sentry?.name ?? r.id,
    true,
  );
}

/** Agent-written text on one line: chips, links, code and emphasis as in a message, but no paragraphs, lists or headings. */
export function Rich({ text, className, still }: { text: string; className?: string; still?: boolean }) {
  return (
    <span className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkChips]} components={still ? inlineStill : inline} allowedElements={INLINE} unwrapDisallowed urlTransform={keepRefs}>
        {asLinks(text.replace(/\s*\n\s*/g, " "))}
      </ReactMarkdown>
    </span>
  );
}

// In markdown a chip is a link to ref:<kind>/<id>, so the link renderer draws it and refs never get parsed twice.
// A file in the uploads dir draws like his pasted images even when an agent names it as a bare path on its own line or a file:// src.
const showUploads = (text: string) =>
  text.replace(/^(?:file:\/\/)?(\S*\/uploads\/[\w.-]+\.(?:png|jpe?g|gif|webp))$/gim, "![image]($1)").replace(/\]\(file:\/\/(\S*\/uploads\/)/g, "]($1");
/** The uploaded images in a message, in order, as the URLs the server serves them at. */
export const uploadsIn = (text: string) => [...showUploads(text).matchAll(/!\[[^\]]*\]\(\S*\/uploads\/([\w.-]+)\)/g)].map(m => `/api/uploads/${m[1]}`);
const asLinks = (text: string) => text.replace(/\[\[(agent|router|task|objective|thread|msg):([^\]]+)\]\]/g, (_, kind, id) => `[ref](ref:${kind}/${encodeURIComponent(id)})`);

// A PR or Linear issue named in plain text becomes a link to pr:<owner/repo>/<n> or linear:<key>, so it draws as a chip.
// Code and existing links are other node types, so nothing inside them changes.
const LINEAR = "https://linear.app/dryftai/issue";
const REPO = "dryft-ai/app";
const NAMED = /(?<![\w/&#-])(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d{3,})|((?:PRO|DRY|TI)-\d+)|(th-[0-9a-f]{6})|(t\d+))\b/g;
type Node = { type: string; value?: string; url?: string; children?: Node[] };
function chipNamed(node: Node) {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap(child => {
    if (child.type !== "text") return chipNamed(child), [child];
    const out: Node[] = [];
    let last = 0;
    for (const m of child.value!.matchAll(NAMED)) {
      // A bare tN is a task only when one has that id; otherwise it stays text.
      if (m[6] && !taskStore.get().some(t => t.id === m[6])) continue;
      if (m.index > last) out.push({ type: "text", value: child.value!.slice(last, m.index) });
      out.push({ type: "link", url: m[5] ? `ref:thread/${m[5]}` : m[6] ? `ref:task/${m[6]}` : m[4] ? `linear:${m[4]}` : `pr:${(m[1] ?? REPO).toLowerCase()}/${m[2] ?? m[3]}`, children: [{ type: "text", value: m[0] }] });
      last = m.index + m[0].length;
    }
    if (last < child.value!.length) out.push({ type: "text", value: child.value!.slice(last) });
    return out;
  });
}
const remarkChips = () => chipNamed;

// A line break he typed (Shift+Enter) stays one, as in a chat, instead of markdown joining the lines; code keeps its own.
function breakLines(node: Node) {
  node.children = node.children?.flatMap(child => {
    if (child.type !== "text") return breakLines(child), [child];
    return child.value!.split("\n").flatMap((value, i) => (i ? [{ type: "break" }, { type: "text", value }] : [{ type: "text", value }]));
  });
}
const remarkBreaks = () => breakLines;

const prColor = { open: "text-ok", merged: "text-merged", closed: "text-destructive" } as const;
function PrChip({ repo, n }: { repo: string; n: string }) {
  const pr = prStore.use()[`${repo}#${n}`];
  return (
    <a href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} title={pr ? `${repo}#${n} ${pr.title}` : `${repo}#${n}`} className={cn(pill(), "text-[0.92em]")}>
      <GitPullRequest className={cn("size-3 shrink-0", pr ? prColor[pr.state] : "text-muted-foreground")} />
      <span className="shrink-0 tabular-nums">{repo === REPO ? "" : repo}#{n}</span>
      {pr && <span className="truncate text-muted-foreground">{pr.title}</span>}
    </a>
  );
}

function LinearChip({ issue }: { issue: string }) {
  return (
    <a href={`${LINEAR}/${issue}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} title={issue} className={cn(pill(), "text-[0.92em] tabular-nums")}>
      <SquareKanban className="size-3 text-link" />
      <span className="min-w-0 truncate">{issue}</span>
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
  code: ({ children, className }) => <code className={cn("rounded-md bg-muted px-1 font-mono text-[0.88em]", className)}>{children}</code>,
  pre: ({ children }) => <pre className="my-1.5 overflow-x-auto rounded-lg bg-muted p-2.5 text-xs [&>code]:bg-transparent [&>code]:p-0">{children}</pre>,
  table: ({ children }) => <table className="my-1.5 border-collapse text-xs">{children}</table>,
  th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
  hr: () => <hr className="my-3" />,
  a: ({ href = "", children }) => {
    // [[kind:id]] and bare ids arrive as ref: links; a link to this app (#thread/th-…, or a localhost URL to one) opens in place.
    const ref = href.match(/^ref:(agent|router|task|objective|thread|msg)\/(.+)$/) ?? href.match(/^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?)?#(agent|task|objective|thread)\/([^/?#]+)$/);
    if (ref) return <RefChip r={{ kind: ref[1] as Ref["kind"], id: decodeURIComponent(ref[2]!) }} />;
    const pr = href.match(/^pr:([\w.-]+\/[\w.-]+)\/(\d+)$/) ?? href.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/i);
    if (pr) return <PrChip repo={pr[1]!.toLowerCase()} n={pr[2]!} />;
    const issue = href.match(/^linear:([A-Z]+-\d+)$/) ?? href.match(/^https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z]+-\d+)/);
    if (issue) return <LinearChip issue={issue[1]!} />;
    return (
      <a href={href} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-link hover:underline">
        {children}
        <ExternalLink className="size-3" />
      </a>
    );
  },
  img: ({ src = "" }) => {
    const name = typeof src === "string" && src.match(/\/uploads\/([\w.-]+)$/)?.[1];
    if (!name) return null;
    return (
      <Upload name={name} className="my-1 block w-fit">
        <img src={`/api/uploads/${name}`} alt="" className="max-h-80 max-w-full border" />
      </Upload>
    );
  },
};

/** An uploaded image: inside a thread it opens the viewer over that thread's images; a modified click, or one outside, opens a tab. */
function Upload({ name, className, children }: { name: string; className: string; children: React.ReactNode }) {
  const shots = useContext(ShotScope);
  const url = `/api/uploads/${name}`;
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (shots?.length && !e.metaKey && !e.ctrlKey && !e.shiftKey) e.preventDefault(), openViewer(shots, url);
  };
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={onClick} className={className}>
      {children}
    </a>
  );
}

const INLINE = ["p", "a", "code", "strong", "em", "del", "img"];
const inline: Components = {
  ...md,
  p: ({ children }) => <>{children}</>,
  img: ({ src = "" }) => {
    const name = typeof src === "string" && src.match(/\/uploads\/([\w.-]+)$/)?.[1];
    return name ? (
      <Upload name={name} className="text-link hover:underline">
        [image]
      </Upload>
    ) : null;
  },
};
// Inside a link or button: entity chips keep their look without being links, and other links are just their text.
const inlineStill: Components = {
  ...inline,
  a: ({ href = "", children }) => {
    const ref = href.match(/^ref:(agent|router|task|objective|thread|msg)\/(.+)$/);
    return ref ? <RefChip r={{ kind: ref[1] as Ref["kind"], id: decodeURIComponent(ref[2]!) }} still /> : <span className="text-link">{children}</span>;
  },
  img: () => <span className="text-link">[image]</span>,
};
const keepRefs = (url: string) => (/^(ref|pr|linear):/.test(url) ? url : defaultUrlTransform(url));

/** A whole message as GitHub-flavored markdown, with Rich's chips, links and pasted images inside it. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkChips, remarkBreaks]} components={md} urlTransform={keepRefs}>
        {asLinks(showUploads(text))}
      </ReactMarkdown>
    </div>
  );
}

const GITHUB_LOGIN = "isaacchacko";

/** A message's sender as a 36px square, Slack-style: Isaac's GitHub picture, and agents in the sidebar's role and state language. */
export function Avatar({ from, small }: { from: string; small?: boolean }) {
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const sentries = sentryStore.use();
  const names = nameStore.use();
  const [broken, setBroken] = useState(false);
  // Small is the 20px face in a replies line, where a worker's state dot would crowd it.
  const tile = cn("relative flex shrink-0 items-center justify-center rounded-full font-semibold", small ? "size-5 text-[10px] [&>svg]:size-3" : "size-9 text-sm");
  if (from === "isaac")
    return broken ? (
      <span className={cn(tile, "bg-tile-1 text-tile-ink")}>IC</span>
    ) : (
      <img src={`https://avatars.githubusercontent.com/${GITHUB_LOGIN}?s=72`} alt="" onError={() => setBroken(true)} className={cn("shrink-0 rounded-full object-cover", small ? "size-5" : "size-9")} />
    );
  if (objectives.some(o => o.id === from))
    return (
      <span className={cn(tile, "bg-agent/10")}>
        <Waypoints className="size-4 text-agent" />
      </span>
    );
  if (sentries.some(x => x.id === from))
    return (
      <span className={cn(tile, "bg-muted")}>
        <Radar className="size-4 text-muted-foreground" />
      </span>
    );
  // An agent's own face, its expression following its state; a list of them stays still, so a long inbox doesn't repaint.
  const a = agents.find(x => x.id === from);
  return (
    <span title={a?.name ?? names[from] ?? from} className={cn("relative flex shrink-0", small ? "size-5" : "size-9")}>
      <AgentFace id={from} expression={expressionOf(a?.state)} small={small} still className="size-full" />
      {!small && a?.role === "router" && (
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-card shadow-card">
          <Network className="size-2.5 text-router" />
        </span>
      )}
    </span>
  );
}

export function Author({ from }: { from: string }) {
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const sentries = sentryStore.use();
  const names = nameStore.use();
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
      {agents.find(x => x.id === from)?.name ?? sentries.find(x => x.id === from)?.name ?? names[from] ?? from}
    </a>
  );
}
