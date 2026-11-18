import { cn } from "@/lib/utils";
import { agentStore, nameStore } from "@/store";

/**
 * A face that stands for a session opens its agent page (Isaac: "i should be able to click on an agent face to jump to the agent").
 * A span acting as a link, since faces sit inside thread links and rows; its click is its own and never reaches the row's.
 */
export function AgentLink({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const agents = agentStore.use();
  const names = nameStore.use();
  const agent = agents.find(a => a.id === id);
  const name = agent?.name ?? names[id] ?? id;
  const go = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    location.hash = `agent/${id}`;
  };
  // A session that has ended has no page to open: its face stays a face.
  if (!agent)
    return (
      <span title={name} className={className}>
        {children}
      </span>
    );
  return (
    <span
      role="link"
      tabIndex={0}
      title={`Open ${name}`}
      data-agent={`agent-link:${id}`}
      onClick={go}
      onKeyDown={e => e.key === "Enter" && go(e)}
      className={cn("cursor-pointer rounded-full transition-shadow hover:ring-2 hover:ring-link/40 focus-visible:ring-2 focus-visible:ring-link/60 focus-visible:outline-none", className)}
    >
      {children}
    </span>
  );
}
