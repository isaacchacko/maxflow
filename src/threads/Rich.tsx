import { ExternalLink, Network, User, Waypoints } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { agentStateColor, statusColor } from "@/mock";
import { agentStore, objectiveStore, taskStore } from "@/store";

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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={md} urlTransform={url => (url.startsWith("ref:") ? url : defaultUrlTransform(url))}>
        {asLinks(text)}
      </ReactMarkdown>
    </div>
  );
}

export function Author({ from }: { from: string }) {
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  if (from === "isaac")
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <User className="size-3.5 text-sky-400" />
        you
      </span>
    );
  const o = objectives.find(x => x.id === from);
  if (o)
    return (
      <a href={`#objective/${o.id}`} className="flex items-center gap-1.5 text-sm font-medium hover:underline">
        <Waypoints className="size-3.5 text-agent" />
        {o.title}
      </a>
    );
  const a = agents.find(x => x.id === from);
  return (
    <a href={`#agent/${from}`} className="flex items-center gap-1.5 font-mono text-sm hover:underline">
      {a?.role === "worker" ? <span className={cn("size-2", agentStateColor[a.state])} /> : <Network className="size-3.5 text-fuchsia-400" />}
      {a?.name ?? from}
    </a>
  );
}
