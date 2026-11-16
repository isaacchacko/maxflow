import { AgentFace, type Colors } from "@/components/AgentFace";
import { cn } from "@/lib/utils";

/** maxflow's mark: the Dryft logo as an agent face, in Dryft blue, idling. favicon.svg is the same face, still. */
export const MARK_ID = "maxflow:mark";
export const DRYFT_BLUE: Colors = { face: "#264aff", edge: "#1630b4", line: "#1a3be0", ink: "#ffffff" };

export function Mark({ className }: { className?: string }) {
  return (
    <span role="img" aria-label="maxflow" className={cn("inline-flex size-8", className)}>
      <AgentFace id={MARK_ID} shape="dryft" colors={DRYFT_BLUE} className="size-full" />
    </span>
  );
}
