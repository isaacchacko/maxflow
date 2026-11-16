import { ArrowRight, Bot, Network, X } from "lucide-react";
import { useEffect } from "react";
import type { Signal } from "@/mock";
import { cn } from "@/lib/utils";
import { agentStore, pathOf, sentryStore } from "@/store";
import { when } from "@/threads/MessageRow";
import { Markdown, RefChip } from "@/threads/Rich";

const deliveryLook = {
  queued: { label: "queued", className: "text-amber-400" },
  delivered: { label: "delivered", className: "text-emerald-400" },
  gone: { label: "session gone", className: "text-muted-foreground" },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
    </div>
  );
}

/** One event from the log, read in full: who sent it, what it said, and where it went. */
export function EventDrawer({ signal, onClose }: { signal: Signal; onClose: () => void }) {
  const agents = agentStore.use();
  const sentries = sentryStore.use();
  // Live signals carry their hops; a mock one only knows who it reached, through which objective.
  const route = signal.route ?? [{ at: signal.at, to: signal.routedTo, objective: pathOf(signal, agents).objectives[0] }];
  const funnel = sentries.find(x => x.name === "funnel")?.id;
  const hopLabel = (to: string[], objective?: string) =>
    to.length === 1 && to[0] === funnel ? "sent to the funnel to route" : objective ? "sent to its objective's routers" : "sent to";
  const from = agents.find(a => a.id === signal.from);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopImmediatePropagation(), onClose());
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const agentLink = (id: string) => {
    const a = agents.find(x => x.id === id);
    return (
      <a key={id} href={`#agent/${id}`} className="flex items-center gap-1.5 truncate hover:underline">
        {a?.role === "router" ? <Network className="size-3.5 shrink-0 text-fuchsia-400" /> : <Bot className="size-3.5 shrink-0 text-muted-foreground" />}
        {a?.name ?? id}
      </a>
    );
  };

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <aside
        data-agent="event-drawer"
        onClick={e => e.stopPropagation()}
        className="absolute inset-y-0 right-0 flex w-[min(520px,100vw)] flex-col gap-4 overflow-y-auto border-l bg-background p-5 shadow-2xl animate-in slide-in-from-right"
      >
        <header className="flex items-center gap-3">
          <h2 className="font-mono text-sm">{signal.target}</h2>
          <span className="text-xs text-muted-foreground">{new Date(signal.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
          <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="size-4" />
          </button>
        </header>
        <Field label="Source">{signal.source}</Field>
        {signal.from && <Field label="From">{from ? agentLink(from.id) : signal.from}</Field>}
        <Field label="Thread">{signal.thread ? <RefChip r={{ kind: "thread", id: signal.thread }} /> : <span className="text-muted-foreground">none</span>}</Field>
        <section data-agent="event-route" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Routed to</h3>
          {route.length === 0 || route.every(h => h.to.length === 0) ? (
            <span className="text-sm text-amber-400">unrouted</span>
          ) : (
            <ol className="flex flex-col gap-2.5 border-l pl-3">
              {route.map((hop, n) => (
                <li key={n} className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">
                    {when(hop.at)} · {hop.routed ? `the funnel routed it${hop.kind ? ` (${hop.kind})` : ""}` : hopLabel(hop.to, hop.objective)}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {hop.objective && (
                      <>
                        <RefChip r={{ kind: "objective", id: hop.objective }} />
                        {hop.to.length > 0 && <ArrowRight className="size-3 text-muted-foreground" />}
                      </>
                    )}
                    {hop.to.map(id => (
                      <span key={id} className="inline-flex items-center gap-1">
                        <RefChip r={{ kind: "agent", id }} />
                        {signal.delivery?.[id] && <span className={cn("text-[11px]", deliveryLook[signal.delivery[id]!].className)}>{deliveryLook[signal.delivery[id]!].label}</span>}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <div className="border-t pt-4">
          <Markdown text={signal.text} className="text-sm leading-relaxed" />
        </div>
      </aside>
    </div>
  );
}
