import { ArrowLeft, Globe, SquareTerminal } from "lucide-react";
import { AgentFace, expressionOf } from "@/components/AgentFace";
import { Button } from "@/components/ui/button";
import { cn, hasText } from "@/lib/utils";
import type { Agent } from "@/mock";
import { agentStore } from "@/store";
import { BrowserPane, useScreencast } from "@/agent/BrowserPane";

const nameOf = (agent: Agent) => agent.name ?? agent.id;

function BrowserCard({ agent }: { agent: Agent }) {
  const { page, mount } = useScreencast(agent.id);
  return (
    <li>
      <a href={`#browsers/${agent.id}`} data-agent={`browser:${agent.id}`} className="group flex flex-col overflow-hidden rounded-lg border bg-background hover:ring-2 hover:ring-link/40">
        <div className="flex aspect-[16/10] items-center justify-center overflow-hidden border-b bg-muted/40">
          <img ref={mount} alt={page.title === "" ? `${nameOf(agent)}'s browser` : page.title} draggable={false} className="size-full object-cover object-top select-none" />
        </div>
        <div className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
          <AgentFace id={agent.id} expression={expressionOf(agent.state)} small className="size-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className={cn("truncate text-sm font-medium", !hasText(agent.name) && "font-mono")}>{nameOf(agent)}</p>
            <p title={page.url} className="truncate text-xs text-muted-foreground">
              {page.title === "" ? page.url : page.title}
            </p>
            {page.title !== "" && <p className="truncate font-mono text-[11px] text-muted-foreground/80">{page.url}</p>}
          </div>
        </div>
      </a>
    </li>
  );
}

function NoneOpen() {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 px-4 text-center">
      <Globe className="size-8 text-muted-foreground" />
      <h2 className="text-base font-medium">No agent has a browser open</h2>
      <p className="text-sm text-muted-foreground">An agent opens its own headless Chrome by running</p>
      <code className="rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs">cli.ts browser open &lt;url&gt;</code>
      <p className="text-sm text-muted-foreground">It shows up here while it is open, and you can watch it or take it over. A browser closes after 10 minutes unused, or when its agent's session ends.</p>
    </div>
  );
}

function OneBrowser({ agent }: { agent: Agent }) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-3">
      <div className="flex h-9 shrink-0 items-center gap-2.5">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href="#browsers" title="All browsers">
            <ArrowLeft />
          </a>
        </Button>
        <AgentFace id={agent.id} expression={expressionOf(agent.state)} small className="size-7 shrink-0" />
        <h1 className={cn("min-w-0 truncate text-base font-medium", !hasText(agent.name) && "font-mono")}>{nameOf(agent)}</h1>
        <Button variant="outline" size="sm" asChild className="ml-auto shrink-0">
          <a href={`#agent/${agent.id}`} data-agent={`agent-page:${agent.id}`}>
            <SquareTerminal /> Agent page
          </a>
        </Button>
      </div>
      <BrowserPane key={agent.id} id={agent.id} />
    </div>
  );
}

export function BrowsersView({ id }: { id?: string | undefined }) {
  const browsing = agentStore.use().filter(a => a.browser === true);
  const shown = browsing.find(a => a.id === id);
  if (shown) return <OneBrowser agent={shown} />;
  return (
    <div className="h-full overflow-y-auto p-3">
      {browsing.length === 0 ? (
        <NoneOpen />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
          {browsing.map(agent => (
            <BrowserCard key={agent.id} agent={agent} />
          ))}
        </ul>
      )}
    </div>
  );
}
