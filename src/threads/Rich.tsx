import { ExternalLink, Network, User, Waypoints } from "lucide-react";
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
