import { ArrowRight, Bot, Network, X } from "lucide-react";
import { Drawer } from "@/components/Drawer";
import type { Agent, Signal } from "@/mock";
import { cn, hasText } from "@/lib/utils";
import { agentStore, pathOf, sentryStore } from "@/store";
import { when } from "@/threads/MessageRow";
import { Markdown, RefChip } from "@/threads/Rich";

type Hop = NonNullable<Signal["route"]>[number];
type Context = NonNullable<Signal["context"]>[number];

const deliveryLook = {
  queued: { label: "queued", className: "text-warn" },
  delivered: { label: "delivered", className: "text-ok" },
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

export function EventDrawer({ signal, onClose }: { signal: Signal | undefined; onClose: () => void }) {
  return (
    <Drawer open={signal !== undefined} onClose={onClose} contentKey={signal?.id} data-agent="event-drawer" className="flex flex-col gap-4 p-5">
      {signal && <EventDetail signal={signal} onClose={onClose} />}
    </Drawer>
  );
}

function reachedThroughObjective(signal: Signal, agents: Agent[]): Hop {
  const [objective] = pathOf(signal, agents).objectives;
  const hop = { at: signal.at, to: signal.routedTo };
  return objective === undefined ? hop : { ...hop, objective };
}

function hopText(hop: Hop, funnel: string | undefined) {
  if (hop.routed === true) return `the funnel routed it${hasText(hop.kind) ? ` (${hop.kind})` : ""}`;
  if (hop.to.length === 1 && hop.to[0] === funnel) return "sent to the funnel to route";
  return hasText(hop.objective) ? "sent to its objective's routers" : "sent to";
}

const slackOrGithubChip = (link: string) => `<${link}>`;

function AgentLink({ id, agents }: { id: string; agents: Agent[] }) {
  const a = agents.find(x => x.id === id);
  return (
    <a href={`#agent/${id}`} className="flex items-center gap-1.5 truncate hover:underline">
      {a?.role === "router" ? <Network className="size-3.5 shrink-0 text-router" /> : <Bot className="size-3.5 shrink-0 text-muted-foreground" />}
      {a?.name ?? id}
    </a>
  );
}

function HopRow({ hop, funnel, delivery }: { hop: Hop; funnel: string | undefined; delivery: Signal["delivery"] }) {
  return (
    <li className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">
        {when(hop.at)} · {hopText(hop, funnel)}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {hasText(hop.objective) && (
          <>
            <RefChip r={{ kind: "objective", id: hop.objective }} />
            {hop.to.length > 0 && <ArrowRight className="size-3 text-muted-foreground" />}
          </>
        )}
        {hop.to.map(id => {
          const state = delivery?.[id];
          return (
            <span key={id} className="inline-flex items-center gap-1">
              <RefChip r={{ kind: "agent", id }} />
              {state !== undefined && <span className={cn("text-[11px]", deliveryLook[state].className)}>{deliveryLook[state].label}</span>}
            </span>
          );
        })}
      </span>
    </li>
  );
}

function RouteSection({ signal, agents, funnel }: { signal: Signal; agents: Agent[]; funnel: string | undefined }) {
  const route = signal.route ?? [reachedThroughObjective(signal, agents)];
  return (
    <section data-agent="event-route" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Routed to</h3>
      {route.every(h => h.to.length === 0) ? (
        <span className="text-sm text-warn">unrouted</span>
      ) : (
        <ol className="flex flex-col gap-2.5 border-l pl-3">
          {route.map((hop, n) => (
            <HopRow key={n} hop={hop} funnel={funnel} delivery={signal.delivery} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ContextSection({ context }: { context: Context[] }) {
  return (
    <section data-agent="event-context" className="flex flex-col gap-2 border-t pt-4">
      <h3 className="text-xs font-medium text-muted-foreground">Before it, in the same conversation</h3>
      {context.map((c, i) => (
        <div key={i} className={cn("border-l-2 pl-3 text-sm", c.own === true ? "border-link" : "border-border")}>
          <span className="text-xs text-muted-foreground">
            <span className={cn("font-medium", c.own === true ? "text-link" : "text-foreground")}>{c.own === true ? "you" : c.who}</span> · {when(c.at)}
          </span>
          <Markdown text={c.text} className="leading-relaxed" />
        </div>
      ))}
    </section>
  );
}

function EventDetail({ signal, onClose }: { signal: Signal; onClose: () => void }) {
  const agents = agentStore.use();
  const sentries = sentryStore.use();
  const funnel = sentries.find(x => x.name === "funnel")?.id;
  const from = agents.find(a => a.id === signal.from);

  return (
    <>
      <header className="flex items-center gap-3">
        <h2 className="font-mono text-sm">{signal.target}</h2>
        <span className="text-xs text-muted-foreground">{new Date(signal.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
        <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="size-4" />
        </button>
      </header>
      <Field label="Source">{signal.source}</Field>
      {hasText(signal.from) && <Field label="From">{from ? <AgentLink id={from.id} agents={agents} /> : signal.from}</Field>}
      {hasText(signal.where) && <Field label="Where">{signal.where}</Field>}
      {hasText(signal.link) && (
        <Field label="Original">
          <Markdown text={slackOrGithubChip(signal.link)} />
        </Field>
      )}
      {hasText(signal.taskId) && (
        <Field label="Task">
          <RefChip r={{ kind: "task", id: signal.taskId }} />
        </Field>
      )}
      <Field label="Thread">{hasText(signal.thread) ? <RefChip r={{ kind: "thread", id: signal.thread }} /> : <span className="text-muted-foreground">none</span>}</Field>
      <RouteSection signal={signal} agents={agents} funnel={funnel} />
      {signal.context && signal.context.length > 0 && <ContextSection context={signal.context} />}
      <div className="border-t pt-4">
        <Markdown text={signal.text} className="text-sm leading-relaxed" />
      </div>
    </>
  );
}
