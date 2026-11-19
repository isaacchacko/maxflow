import { FileText, MessageSquareQuote, MessagesSquare, Network, Radar, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentStateColor, statusColor, type Agent } from "@/mock";
import { agentStore, objectiveStore, sentryStore, taskStore, threadStore } from "@/store";
import { goToMessage } from "../jump";
import type { Ref } from "./parse";

export const pill = (isWide?: boolean) =>
  cn("inline-flex items-baseline gap-1 rounded-full border border-transparent bg-muted px-1.5 align-baseline whitespace-nowrap hover:border-ring [&>:first-child]:shrink-0 [&>:first-child]:self-center", isWide === true ? "max-w-full" : "max-w-[min(100%,28ch)]");

const ROW = "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-[13px] whitespace-nowrap hover:bg-black/[0.04] [&>:first-child]:shrink-0 [&>svg:first-child]:size-4";
const MISSING_ROW = "text-muted-foreground line-through";
const MISSING_PILL = "border-dashed border-border bg-transparent text-muted-foreground line-through";

type Look = { isStill: boolean; isWide: boolean; isRow: boolean };

const missingLook = (isFound: boolean, look: Look) => !isFound && (look.isRow ? MISSING_ROW : MISSING_PILL);

type ChipProps = { r: Ref; look: Look; href: string; isFound: boolean; icon: React.ReactNode; label: string; isMono?: boolean };

function EntityChip({ r, look, href, isFound, icon, label, isMono = false }: ChipProps) {
  const Tag = look.isStill ? "span" : "a";
  return (
    <Tag
      href={look.isStill ? undefined : href}
      onClick={e => e.stopPropagation()}
      title={isFound ? label : `No ${r.kind} ${r.id} in yarn now`}
      className={cn(look.isRow ? ROW : pill(look.isWide), !look.isRow && (isMono ? "font-mono text-[0.85em]" : "text-[0.92em]"), missingLook(isFound, look))}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </Tag>
  );
}

type KindProps = { r: Ref; look: Look };

function TaskChip({ r, look }: KindProps) {
  const t = taskStore.use().find(x => x.id === r.id);
  const dot = <span className={cn("size-1.5 rounded-full", t ? statusColor[t.status] : "bg-muted-foreground")} />;
  return <EntityChip r={r} look={look} href={`#task/${r.id}`} isFound={t !== undefined} icon={dot} label={t?.title ?? r.id} />;
}

function ObjectiveChip({ r, look }: KindProps) {
  const o = objectiveStore.use().find(x => x.id === r.id);
  return <EntityChip r={r} look={look} href={`#objective/${r.id}`} isFound={o !== undefined} icon={<Waypoints className="size-3 text-agent" />} label={o?.title ?? r.id} />;
}

function ThreadChip({ r, look }: KindProps) {
  const t = threadStore.use().find(x => x.id === r.id);
  return <EntityChip r={r} look={look} href={`#thread/${r.id}`} isFound={t !== undefined} icon={<MessagesSquare className="size-3 text-link" />} label={t?.title ?? r.id} />;
}

function DocChip({ r, look }: KindProps) {
  const name = r.id.replace(/\.md$/, "").split("/").at(-1) ?? r.id;
  return <EntityChip r={r} look={look} href={`#docs/${encodeURI(r.id)}`} isFound icon={<FileText className="size-3 text-link" />} label={name} />;
}

function senderName(from: string, agents: Agent[], sentries: { id: string; name?: string | undefined }[]) {
  if (from === "isaac") return "you";
  return agents.find(x => x.id === from)?.name ?? sentries.find(x => x.id === from)?.name ?? from;
}

function MessageChip({ r, look }: KindProps) {
  const agents = agentStore.use();
  const sentries = sentryStore.use();
  const threads = threadStore.use();
  const [threadId = "", messageId] = r.id.split("/", 2);
  const m = threads.find(x => x.id === threadId)?.messages.find(x => x.id === messageId);
  const said = m && `${senderName(m.from, agents, sentries)} · ${m.at.slice(11, 16)}`;
  const Tag = look.isStill ? "span" : "a";
  return (
    <Tag
      href={look.isStill ? undefined : `#thread/${threadId}`}
      onClick={e => {
        e.stopPropagation();
        if (look.isStill) return;
        e.preventDefault();
        goToMessage(threadId, messageId);
      }}
      title={said ?? `No message ${r.id} in yarn now`}
      className={cn(look.isRow ? ROW : cn(pill(look.isWide), "text-[0.92em]"), "not-italic", missingLook(m !== undefined, look))}
    >
      <MessageSquareQuote className="size-3 text-link" />
      <span className="min-w-0 truncate">{said ?? messageId}</span>
    </Tag>
  );
}

function AgentIcon({ agent, isRouter, isSentry }: { agent: Agent | undefined; isRouter: boolean; isSentry: boolean }) {
  if (isRouter) return <Network className="size-3 text-router" />;
  if (isSentry) return <Radar className="size-3 text-muted-foreground" />;
  return <span className={cn("size-1.5 rounded-full", agent ? agentStateColor[agent.state] : "bg-muted-foreground")} />;
}

function AgentChip({ r, look }: KindProps) {
  const a = agentStore.use().find(x => x.id === r.id);
  const sentry = sentryStore.use().find(x => x.id === r.id);
  const icon = <AgentIcon agent={a} isRouter={a?.role === "router" || r.kind === "router"} isSentry={sentry !== undefined} />;
  return <EntityChip r={r} look={look} href={`#agent/${r.id}`} isFound={(a ?? sentry) !== undefined} icon={icon} label={a?.name ?? sentry?.name ?? r.id} isMono />;
}

export function RefChip({ r, still, wide, row }: { r: Ref; still?: boolean; wide?: boolean; row?: boolean }) {
  const look = { isStill: still === true, isWide: wide === true, isRow: row === true };
  switch (r.kind) {
    case "task": {
      return <TaskChip r={r} look={look} />;
    }
    case "objective": {
      return <ObjectiveChip r={r} look={look} />;
    }
    case "msg": {
      return <MessageChip r={r} look={look} />;
    }
    case "thread": {
      return <ThreadChip r={r} look={look} />;
    }
    case "doc": {
      return <DocChip r={r} look={look} />;
    }
    case "agent":
    case "router": {
      return <AgentChip r={r} look={look} />;
    }
  }
}
