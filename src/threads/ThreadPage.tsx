import { ArrowLeft, ExternalLink, MessagesSquare, Network, Waypoints } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { NOW_AT } from "@/mock";
import { agentStore, objectiveStore, postToThread, threadStore } from "@/store";
import { Author, RefChip, Rich, refsIn, urlsIn, type Ref } from "./Rich";

function when(at: string) {
  return at.slice(0, 10) === NOW_AT.slice(0, 10)
    ? at.slice(11, 16)
    : new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function ThreadPage({ id, back }: { id: string; back: string }) {
  const thread = threadStore.use().find(t => t.id === id);
  const agents = agentStore.use();
  const objective = objectiveStore.use().find(o => o.id === thread?.objectiveId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.messages.length]);

  if (!thread) return <p className="p-6 text-muted-foreground">No thread {id}.</p>;

  const mentioned = new Map<string, Ref>();
  for (const m of thread.messages) for (const r of refsIn(m.text)) mentioned.set(`${r.kind}:${r.id}`, r);
  const links = new Map(thread.messages.flatMap(m => urlsIn(m.text)).map(l => [l.url, l]));

  function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    postToThread(thread!.id, "isaac", draft.trim());
    setDraft("");
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href={`#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        <MessagesSquare className="size-4 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{thread.title}</h1>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col border">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {thread.messages.map((m, i) => (
              <article key={i} className="mb-5">
                <div className="mb-1 flex items-baseline gap-2">
                  <Author from={m.from} />
                  <span className="text-xs text-muted-foreground tabular-nums">{when(m.at)}</span>
                </div>
                <Rich text={m.text} className="text-sm leading-relaxed" />
              </article>
            ))}
          </div>
          <form onSubmit={send} className="border-t px-4 py-2.5">
            <input
              data-agent="thread-input"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="Message"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </form>
        </section>

        <aside className="flex w-1/4 min-w-72 shrink-0 flex-col gap-5 overflow-y-auto pr-1">
          {objective && (
            <Section title="Objective">
              <a href={`#objective/${objective.id}`} className="flex items-center gap-1.5 px-1 py-1 text-sm hover:bg-muted">
                <Waypoints className="size-3.5 text-agent" />
                {objective.title}
              </a>
            </Section>
          )}
          <Separator />
          <Section title={`Routers · ${thread.routerIds.length}`}>
            {thread.routerIds.map(rid => {
              const r = agents.find(a => a.id === rid);
              return (
                <a key={rid} href={`#agent/${rid}`} className="flex flex-col px-1 py-1 hover:bg-muted">
                  <span className="flex items-center gap-1.5 text-xs">
                    <Network className="size-3 text-fuchsia-400" />
                    {r?.name ?? rid}
                  </span>
                  {r?.scope && <span className="truncate text-xs text-muted-foreground">{r.scope}</span>}
                </a>
              );
            })}
          </Section>
          <Separator />
          <Section title={`Mentioned · ${mentioned.size}`}>
            {mentioned.size === 0 && <p className="text-xs text-muted-foreground">None</p>}
            <div className="flex flex-wrap gap-1.5 text-sm">
              {[...mentioned.values()].map(r => (
                <RefChip key={`${r.kind}:${r.id}`} r={r} />
              ))}
            </div>
          </Section>
          <Separator />
          <Section title={`Links · ${links.size}`}>
            {links.size === 0 && <p className="text-xs text-muted-foreground">None</p>}
            {[...links.values()].map(l => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{l.label}</span>
                <span className="truncate text-xs text-muted-foreground">{new URL(l.url).hostname}</span>
              </a>
            ))}
          </Section>
        </aside>
      </div>
    </div>
  );
}
