import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { cn, hasText } from "@/lib/utils";

const DAY_MS = 86_400_000;
const JUMP_ITEM = "flex cursor-pointer items-center justify-between gap-6 px-2 py-1 outline-none select-none data-highlighted:bg-muted";

function dayLabel(day: string) {
  const d = new Date(`${day}T00:00`);
  if (d.toDateString() === new Date().toDateString()) return "Today";
  if (d.toDateString() === new Date(Date.now() - DAY_MS).toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
}

function dayAWeekBack(newestFirst: string[]) {
  const weekAgo = new Date(Date.now() - 7 * DAY_MS).toLocaleDateString("sv");
  const yesterday = new Date(Date.now() - DAY_MS).toLocaleDateString("sv");
  return newestFirst.findLast(d => d >= weekAgo && d < yesterday);
}

export function DayDivider({ day, days, jump }: { day: string; days: string[]; jump: (day: string) => void }) {
  const lastWeek = dayAWeekBack(days);
  return (
    <>
      <div data-day={day} className="-mx-5 mt-5 h-px bg-border" />
      <div data-agent="inbox-day" className="group/day pointer-events-none sticky top-1.5 z-20 -mt-3 mb-1.5 flex justify-center">
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger data-agent="inbox-day-jump" className="pointer-events-auto flex items-center gap-1 rounded-full border bg-card px-3 py-0.5 text-xs font-medium text-foreground outline-none group-data-stuck/day:shadow-[0_2px_6px_rgb(0_0_0/0.08)] hover:bg-muted data-[state=open]:bg-muted">
            {dayLabel(day)}
            <ChevronDown className="size-3 text-muted-foreground" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="center" sideOffset={4} onEscapeKeyDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onCloseAutoFocus={e => e.preventDefault()} className="z-50 max-h-80 min-w-44 overflow-y-auto border bg-background p-1 text-sm shadow-lg">
              <DropdownMenu.Label className="px-2 py-1 text-xs text-muted-foreground">Jump to…</DropdownMenu.Label>
              {hasText(lastWeek) && (
                <DropdownMenu.Item className={JUMP_ITEM} onSelect={() => jump(lastWeek)}>
                  Last week <span className="text-xs text-muted-foreground">{dayLabel(lastWeek)}</span>
                </DropdownMenu.Item>
              )}
              {days.map(d => (
                <DropdownMenu.Item key={d} data-agent={`inbox-day-to:${d}`} className={cn(JUMP_ITEM, d === day && "font-medium")} onSelect={() => jump(d)}>
                  {dayLabel(d)}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </>
  );
}
