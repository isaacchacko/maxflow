import { Bot, Network, Waypoints, X } from "lucide-react";
import { useEffect } from "react";
import type { Signal } from "@/mock";
import { Rich } from "@/threads/Rich";
import { agentStore, objectiveStore, pathOf } from "@/store";

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
  const objectives = objectiveStore.use();
  const path = pathOf(signal, agents);
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
        <Field label="Routed to">{signal.routedTo.length ? signal.routedTo.map(agentLink) : <span className="text-amber-400">unrouted</span>}</Field>
        {path.objectives.length > 0 && (
          <Field label="Objective">
            {path.objectives.map(id => (
              <a key={id} href={`#objective/${id}`} className="flex items-center gap-1.5 truncate hover:underline">
                <Waypoints className="size-3.5 shrink-0 text-agent" />
                {objectives.find(o => o.id === id)?.title ?? id}
              </a>
            ))}
          </Field>
        )}
        <div className="border-t pt-4">
          <Rich text={signal.text} className="text-sm leading-relaxed whitespace-pre-wrap break-words" />
        </div>
      </aside>
    </div>
  );
}
