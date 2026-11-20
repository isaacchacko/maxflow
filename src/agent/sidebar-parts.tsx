import { Bot, ExternalLink, GitPullRequest, Hash, Radar, User, Waypoints } from "lucide-react";
import { hasText } from "@/lib/utils";
import { NOW_AT, type AgentState } from "@/mock";

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3 text-sm">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function LinkRow({ icon: Icon, label, detail, href }: { icon: typeof User; label: string; detail?: string; href: string }) {
  return (
    <a href={href} className="group flex items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {hasText(detail) && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      <ExternalLink className="ml-auto size-3 shrink-0 opacity-0 group-hover:opacity-60" />
    </a>
  );
}

export const sourceIcon = { isaac: User, gh: GitPullRequest, slack: Hash, agent: Bot, sentry: Radar, yarn: Waypoints };

export const stateOrder: AgentState[] = ["working", "waiting", "idle", "asleep"];

export function when(at: string) {
  return at.slice(0, 10) === NOW_AT.slice(0, 10) ? at.slice(11, 16) : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
