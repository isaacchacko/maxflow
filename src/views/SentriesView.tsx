import { Radar } from "lucide-react";
import type { ReactNode } from "react";
import type { Agent, SentrySession } from "@/mock";
import { cn } from "@/lib/utils";
import { agentStore, sentryStore } from "@/store";
import { ago } from "@/threads/Replies";

const REVIEW_QUEUE_WORKERS = "vis-factory";
const SENTRIES = ["funnel", "assistant", "review", "meta", "inbox", "gh", "slack", "graph", "rename", "ram", "health", REVIEW_QUEUE_WORKERS];
const AGENTS = new Set(["funnel", "assistant", "review", "meta", REVIEW_QUEUE_WORKERS]);

function stateText(name: string, s: SentrySession | undefined, workers: Agent[]) {
  if (name === REVIEW_QUEUE_WORKERS) return `${workers.length} workers`;
  if (!s) return "not started";
  return s.running ? "running" : "exited";
}

function tiesText(s: SentrySession | undefined, agents: Agent[]) {
  if (!s || s.ties.length === 0) return "";
  return s.ties.map(t => `${agents.find(a => a.id === t.session)?.name ?? t.session} (${t.label})`).join(", ");
}

function hrefOf(s: SentrySession | undefined, workers: Agent[]) {
  if (s) return `#agent/${s.id}`;
  const [firstWorker] = workers;
  return firstWorker ? `#agent/${firstWorker.id}` : undefined;
}

function RowLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  if (href === undefined)
    return <div className="flex items-center gap-3 px-3 py-2 opacity-60">{children}</div>;
  return (
    <a href={href} className="flex items-center gap-3 px-3 py-2 hover:bg-muted">
      {children}
    </a>
  );
}

function SentryRow({ name, sentries, agents }: { name: string; sentries: SentrySession[]; agents: Agent[] }) {
  const s = sentries.find(x => x.name === name);
  const isReviewQueue = name === REVIEW_QUEUE_WORKERS;
  const workers = isReviewQueue ? agents.filter(a => a.name === "vis factory worker") : [];
  const isRunning = isReviewQueue ? workers.length > 0 : s?.running === true;
  return (
    <li className="border-b last:border-b-0">
      <RowLink href={hrefOf(s, workers)}>
        <span className={cn("size-2 shrink-0 rounded-full", isRunning ? "bg-ok" : "bg-muted-foreground/40")} />
        <Radar className="size-3.5 shrink-0 text-command" />
        <span className="w-28 shrink-0 font-mono text-sm">{name}</span>
        <span className="w-16 shrink-0 text-xs text-muted-foreground">{AGENTS.has(name) ? "agent" : "script"}</span>
        <span className="w-24 shrink-0 text-xs text-muted-foreground">{stateText(name, s, workers)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{tiesText(s, agents)}</span>
        {s && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(s.lastOutputAt)}</span>}
      </RowLink>
    </li>
  );
}

export function SentriesView() {
  const sentries = sentryStore.use();
  const agents = agentStore.use();

  return (
    <div className="h-full overflow-y-auto p-3">
      <ol className="flex flex-col border">
        {SENTRIES.map(name => (
          <SentryRow key={name} name={name} sentries={sentries} agents={agents} />
        ))}
      </ol>
    </div>
  );
}
