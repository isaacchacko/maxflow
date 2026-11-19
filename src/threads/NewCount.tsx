import type { LucideIcon } from "lucide-react";

export function NewCount({ count, arrow: Arrow }: { count: number; arrow?: LucideIcon }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-new-soft px-1.5 font-medium text-new">
      {count} new
      {Arrow && <Arrow className="size-3" />}
    </span>
  );
}
