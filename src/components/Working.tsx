import { cn } from "@/lib/utils";

/** The ✻ of a router working on an answer: a small turning iridescent ring. */
export function Working({ className }: { className?: string }) {
  return <span role="img" aria-label="working" className={cn("working-ring iris", className)} />;
}
