import { ArrowLeft, Check, ExternalLink, MessagesSquare, Network, RotateCcw, Waypoints } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { agentStore, objectiveStore, postToThread, setResolved, threadStore } from "@/store";
import { Composer } from "./Composer";
import { MessageRow, when } from "./MessageRow";
import { markSeen } from "./seen";
import { RefChip, refsIn, urlsIn, type Ref } from "./Rich";

// Slack's grouping: a sender's next message within this long drops its picture and name.
const GROUP_MS = 5 * 60_000;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

// The router's acknowledgement: one line while Isaac's last message waits on an answer, gone when it lands.
export function Pending({ pending, names }: { pending: NonNullable<Thread["pending"]>; names: string[] }) {
  const who = `${names.length > 1 ? "routers" : "router"} ${names.join(", ")}`;
  if (pending.stale)
    return (
      <p data-agent="thread-pending" className="text-xs text-muted-foreground">
        {who} stopped without answering · since {when(pending.since)}
      </p>
    );
  return (
    <p data-agent="thread-pending" className="flex items-center gap-2 text-xs text-agent">
      <span className="inline-block animate-spin">✻</span>
      <span className="animate-pulse">{pending.status ? `${names[0]}: ${pending.status}` : `${who} ${names.length > 1 ? "are" : "is"} working on a response`}…</span>
      <span className="text-muted-foreground tabular-nums">since {when(pending.since)}</span>
    </p>
  );
}

export function ThreadPage({ id, back }: { id: string; back: string }) {
  const thread = threadStore.use().find(t => t.id === id);
  const agents = agentStore.use();
  const objective = objectiveStore.use().find(o => o.id === thread?.objectiveId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.messages.length, !!thread?.pending]);

  useEffect(() => {
    if (thread) markSeen(thread.id, thread.messages.length);
  }, [thread?.id, thread?.messages.length]);

  if (!thread) return <p className="p-6 text-muted-foreground">No thread {id}.</p>;

  const mentioned = new Map<string, Ref>();
  for (const m of thread.messages) for (const r of refsIn(m.text)) mentioned.set(`${r.kind}:${r.id}`, r);
  const links = new Map(thread.messages.flatMap(m => urlsIn(m.text)).map(l => [l.url, l]));

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href={`#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        <MessagesSquare className="size-4 text-muted-foreground" />
        <h1 className={cn("text-lg font-semibold", thread.resolved && "text-muted-foreground")}>{thread.title}</h1>
        {thread.resolved && <span className="text-xs text-muted-foreground">resolved {when(thread.resolved.at)}</span>}
        <Button variant="outline" size="sm" className="ml-auto" data-agent="thread-resolve" onClick={() => setResolved(thread.id, !thread.resolved)}>
          {thread.resolved ? <RotateCcw /> : <Check />}
          {thread.resolved ? "Reopen" : "Resolve"}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col border">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {thread.messages.map((m, i) => {
              const prev = thread.messages[i - 1];
              const grouped = prev?.from === m.from && Date.parse(m.at) - Date.parse(prev.at) <= GROUP_MS;
              // What agents posted after he resolved it sits below a line saying so.
              const resolvedHere = thread.resolved && m.at > thread.resolved.at && !(prev && prev.at > thread.resolved.at);
              return (
                <Fragment key={i}>
                {resolvedHere && <p className="my-2 border-t pt-1 text-center text-xs text-muted-foreground">new since resolved</p>}
                <MessageRow from={m.from} at={m.at} text={m.text} grouped={grouped} className={cn(!grouped && i > 0 && "mt-2.5")} />
                </Fragment>
              );
            })}
            {thread.pending && <Pending pending={thread.pending} names={thread.pending.routerIds.map(rid => agents.find(a => a.id === rid)?.name ?? rid)} />}
          </div>
          <Composer agent="thread-input" draftKey={`thread:${thread.id}`} onSend={text => postToThread(thread.id, "isaac", text)} className="border-t px-4 py-2.5" />
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
