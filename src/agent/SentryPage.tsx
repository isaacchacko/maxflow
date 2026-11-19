import { ArrowLeft, Radar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { SentrySession } from "@/mock";
import { agentStore } from "@/store";
import { Row, Section } from "./sidebar-parts";
import { Terminal } from "./Terminal";

export function SentryPage({ sentry, back }: { sentry: SentrySession; back: string }) {
  const agents = agentStore.use();
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden pb-3">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button variant="ghost" size="icon" asChild>
          <a href={`#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        <Radar className="size-4 shrink-0 text-command" />
        <h1 title={sentry.name} className="min-w-0 truncate text-lg">
          {sentry.name}
        </h1>
        <Badge variant="outline" className="shrink-0">
          sentry
        </Badge>
      </header>
      <div className="flex min-h-0 flex-1 gap-4 pl-3">
        <section className="dark min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background p-2">
          <Terminal key={sentry.id} id={sentry.id} />
        </section>
        <aside className="-my-3 flex w-1/4 min-w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l px-4 py-4">
          <Section title="Properties">
            <Row label="State">
              <span className={cn("size-2 rounded-full", sentry.running ? "bg-ok" : "bg-destructive")} />
              {sentry.running ? "running" : "exited"}
            </Row>
            <Row label="Started">{new Date(sentry.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Row>
            <Row label="Last output">{new Date(sentry.lastOutputAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</Row>
          </Section>
          <Separator />
          <Section title={`Tied to · ${sentry.ties.length}`}>
            {sentry.ties.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
            {sentry.ties.map(t => (
              <a key={`${t.session}:${t.label}`} href={`#agent/${t.session}`} className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
                <span className="shrink-0 text-xs">{agents.find(a => a.id === t.session)?.name ?? t.session}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{t.label}</span>
              </a>
            ))}
          </Section>
        </aside>
      </div>
    </div>
  );
}
