import { AgentFace } from "@/components/AgentFace";
import { cn } from "@/lib/utils";

/** maxflow's mark: its own agent face, idling. favicon.svg is the same face, still. */
export const MARK_ID = "maxflow:mark";

export function Mark({ className }: { className?: string }) {
  return (
    <span role="img" aria-label="maxflow" className={cn("inline-flex size-7", className)}>
      <AgentFace id={MARK_ID} className="size-full" />
    </span>
  );
}
