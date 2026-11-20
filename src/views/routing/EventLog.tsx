import { Bot, GitPullRequest, Hash, Radar, User, Waypoints } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn, hasText } from "@/lib/utils";
import { NOW_AT, type Sentry, type Signal, type Source } from "@/mock";

const look: Record<Source, { icon: typeof User; text: string; ring: string }> = {
  isaac: { icon: User, text: "text-link", ring: "border-link/60" },
  gh: { icon: GitPullRequest, text: "text-ok", ring: "border-ok/60" },
  slack: { icon: Hash, text: "text-command", ring: "border-command/60" },
  agent: { icon: Bot, text: "text-agent", ring: "border-agent/60" },
  sentry: { icon: Radar, text: "text-warn", ring: "border-warn/60" },
  yarn: { icon: Waypoints, text: "text-muted-foreground", ring: "border-muted-foreground/60" },
};

const isToday = (at: string) => at.slice(0, 10) === NOW_AT.slice(0, 10);

function when(at: string) {
  const d = new Date(at);
  return isToday(at) ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function day(at: string) {
  if (isToday(at)) return "Today";
  return new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function SourceToggles({ sentries, shown, onToggle }: { sentries: Sentry[]; shown: Set<Source>; onToggle: (source: Source) => void }) {
  return (
    <div data-node="log" className="flex flex-wrap items-center gap-2">
      {sentries.map(s => {
        const Icon = look[s.id].icon;
        return (
          <button
            key={s.id}
            data-node={`src:${s.id}`}
            onClick={e => {
              e.stopPropagation();
              onToggle(s.id);
            }}
            className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-opacity", shown.has(s.id) ? look[s.id].ring : "opacity-40")}
          >
            <Icon className={cn("size-3.5", look[s.id].text)} />
            {s.label}
            <span className={cn("size-1.5 rounded-full", s.state === "backoff" ? "bg-warn" : "animate-pulse bg-ok")} />
            <span className="text-muted-foreground">{s.state === "live" ? "live" : `${s.state} · ${String(s.every)}`}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChatBox({ draft, onDraft, onSend }: { draft: string; onDraft: (draft: string) => void; onSend: (e: React.SyntheticEvent) => void }) {
  return (
    <form onSubmit={onSend} onClick={e => e.stopPropagation()} className="flex items-center gap-3 rounded-lg border border-link/40 bg-card px-3 py-1.5 focus-within:border-link">
      <User className="size-3.5 shrink-0 text-link" />
      <span className="max-w-28 shrink-0 truncate font-mono text-xs text-muted-foreground">chat</span>
      <Input data-agent="log-composer" value={draft} onChange={e => onDraft(e.target.value)} placeholder="Message" className="h-7 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent" />
      <kbd className="shrink-0 text-xs text-muted-foreground">↵</kbd>
    </form>
  );
}

function SignalRow({ s, isReading, isFresh, onRead }: { s: Signal; isReading: boolean; isFresh: boolean; onRead: (id: string) => void }) {
  const Icon = look[s.source].icon;
  return (
    <li
      data-node={`sig:${s.id}`}
      onClick={() => onRead(s.id)}
      className={cn("flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm hover:border-ring", isReading && "border-ring", isFresh && "agent-edited animate-in fade-in slide-in-from-top-2")}
    >
      <span className="w-11 shrink-0 text-xs text-muted-foreground tabular-nums">{when(s.at)}</span>
      <Icon className={cn("size-3.5 shrink-0", look[s.source].text)} />
      <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">{s.target}</span>
      <span className="min-w-0 flex-1 truncate">
        {hasText(s.who) && <span className="font-medium">{s.who}: </span>}
        {s.text}
      </span>
      {s.routedTo.length === 0 && <span className="shrink-0 text-xs text-warn">unrouted</span>}
    </li>
  );
}

export type EventLogProps = {
  sentries: Sentry[];
  shown: Set<Source>;
  onToggle: (source: Source) => void;
  draft: string;
  onDraft: (draft: string) => void;
  onSend: (e: React.SyntheticEvent) => void;
  visible: Signal[];
  reading: string | undefined;
  fresh: string | undefined;
  onRead: (id: string) => void;
};

export function EventLog({ sentries, shown, onToggle, draft, onDraft, onSend, visible, reading, fresh, onRead }: EventLogProps) {
  const days = [...new Set(visible.map(s => day(s.at)))];
  return (
    <>
      <SourceToggles sentries={sentries} shown={shown} onToggle={onToggle} />
      <ChatBox draft={draft} onDraft={onDraft} onSend={onSend} />
      {days.map(d => (
        <div key={d}>
          <p className="sticky top-0 z-20 bg-background py-1 text-xs text-muted-foreground">{d}</p>
          <ol className="flex flex-col gap-1.5">
            {visible
              .filter(s => day(s.at) === d)
              .map(s => (
                <SignalRow key={s.id} s={s} isReading={reading === s.id} isFresh={fresh === s.id} onRead={onRead} />
              ))}
          </ol>
        </div>
      ))}
    </>
  );
}
