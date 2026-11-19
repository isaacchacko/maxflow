import { ArrowLeft, SquareTerminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn, hasText } from "@/lib/utils";
import type { Shell } from "@/mock";
import { agentStore } from "@/store";
import { Row, Section } from "./sidebar-parts";
import { Terminal } from "./Terminal";

function shellState(shell: Shell) {
  if (!shell.end) return "running";
  return shell.end.code === null ? "ended" : `exited ${shell.end.code}`;
}

function shellTone(shell: Shell) {
  if (!shell.end) return "bg-agent";
  if (shell.end.code === 0) return "bg-ok";
  return shell.end.code === null ? "bg-muted-foreground" : "bg-destructive";
}

const fullTime = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

function ShellProperties({ shell }: { shell: Shell }) {
  const owner = agentStore.use().find(a => a.id === shell.owner);
  return (
    <Section title="Properties">
      <Row label="State">
        <span className={cn("size-2 rounded-full", shellTone(shell), !shell.end && "animate-pulse")} />
        {shellState(shell)}
      </Row>
      <Row label="Waited on by">
        <a href={`#agent/${shell.owner}`} className="truncate hover:underline">
          {owner?.name ?? shell.owner}
        </a>
      </Row>
      {hasText(shell.cmd) && (
        <Row label="Command">
          <code className="font-mono text-xs break-all">{shell.cmd}</code>
        </Row>
      )}
      {shell.pid !== undefined && <Row label="Process">{shell.pid}</Row>}
      {hasText(shell.cwd) && (
        <Row label="Folder">
          <span className="truncate font-mono text-xs">{shell.cwd}</span>
        </Row>
      )}
      <Row label="Started">{fullTime(shell.at)}</Row>
      {shell.end && <Row label="Ended">{fullTime(shell.end.at)}</Row>}
    </Section>
  );
}

export function ShellPage({ shell, back }: { shell: Shell; back: string }) {
  const tail = shell.end?.tail;
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden pb-3">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button variant="ghost" size="icon" asChild>
          <a href={`#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        <SquareTerminal className="size-4 shrink-0 text-command" />
        <h1 title={shell.desc} className="min-w-0 truncate text-lg">
          {shell.desc}
        </h1>
        <Badge variant="outline" className="shrink-0">
          shell
        </Badge>
      </header>
      <div className="flex min-h-0 flex-1 gap-4 pl-3">
        <section className="dark min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background p-2">
          {shell.kind === "pid" ? <p className="p-4 font-mono text-sm text-muted-foreground">process {shell.pid}: its output isn't maxflow's to show</p> : <Terminal key={shell.id} id={shell.id} />}
        </section>
        <aside className="-my-3 flex w-1/4 min-w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l px-4 py-4">
          <ShellProperties shell={shell} />
          {hasText(tail) && (
            <>
              <Separator />
              <Section title="Last lines">
                <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">{tail}</pre>
              </Section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
