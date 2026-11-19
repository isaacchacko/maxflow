import { cn } from "@/lib/utils";
import { agentStore, nameStore } from "@/store";

export function AgentLink({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const agents = agentStore.use();
  const names = nameStore.use();
  const agent = agents.find(a => a.id === id);
  const name = agent?.name ?? names[id] ?? id;
  const hasSessionEnded = agent === undefined;
  if (hasSessionEnded)
    return (
      <span title={name} className={className}>
        {children}
      </span>
    );
  const openAgentPage = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    location.hash = `agent/${id}`;
  };
  return (
    <span
      role="link"
      tabIndex={0}
      title={`Open ${name}`}
      data-agent={`agent-link:${id}`}
      onClick={openAgentPage}
      onKeyDown={e => e.key === "Enter" && openAgentPage(e)}
      className={cn("cursor-pointer rounded-full transition-shadow hover:ring-2 hover:ring-link/40 focus-visible:ring-2 focus-visible:ring-link/60 focus-visible:outline-none", className)}
    >
      {children}
    </span>
  );
}
