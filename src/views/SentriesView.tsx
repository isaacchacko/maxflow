import { Radar } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentStore, sentryStore } from "@/store";

/** Every sentry main maxflow runs. vis-factory is no session of its own: it is the workers the review sentry starts on its queue. */
const SENTRIES = ["funnel", "assistant", "review", "meta", "inbox", "gh", "slack", "graph", "rename", "ram", "health", "vis-factory"];
const AGENTS = new Set(["funnel", "assistant", "review", "meta"]);

function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}

export function SentriesView() {
  const sentries = sentryStore.use();
  const agents = agentStore.use();

  return (
    <div className="h-full overflow-y-auto p-4">
      <ol className="flex flex-col border">
        {SENTRIES.map(name => {
          const s = sentries.find(x => x.name === name);
          const workers = name === "vis-factory" ? agents.filter(a => a.name === "vis factory worker") : [];
          const running = name === "vis-factory" ? workers.length > 0 : !!s?.running;
          const row = (
            <>
              <span className={cn("size-2 shrink-0 rounded-full", running ? "bg-ok" : "bg-muted-foreground/40")} />
              <Radar className="size-3.5 shrink-0 text-command" />
              <span className="w-28 shrink-0 font-mono text-sm">{name}</span>
              <span className="w-16 shrink-0 text-xs text-muted-foreground">{AGENTS.has(name) || name === "vis-factory" ? "agent" : "script"}</span>
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {name === "vis-factory" ? `${workers.length} workers` : s ? (s.running ? "running" : "exited") : "not started"}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {s?.ties.length ? s.ties.map(t => `${agents.find(a => a.id === t.session)?.name ?? t.session} (${t.label})`).join(", ") : ""}
              </span>
              {s && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(s.lastOutputAt)}</span>}
            </>
          );
          const href = s ? `#agent/${s.id}` : workers[0] ? `#agent/${workers[0].id}` : undefined;
          return (
            <li key={name} className="border-b last:border-b-0">
              {href ? (
                <a href={href} className="flex items-center gap-3 px-3 py-2 hover:bg-muted">
                  {row}
                </a>
              ) : (
                <div className="flex items-center gap-3 px-3 py-2 opacity-60">{row}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
