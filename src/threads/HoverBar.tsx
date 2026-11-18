import { Ellipsis } from "lucide-react";
import { DropdownMenu, Tooltip } from "radix-ui";
import { useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { applying, type MenuItem } from "./RowMenu";

type Action = Exclude<MenuItem, "-">;

/**
 * Slack's message toolbar: a small bar floating on a row's top-right edge, over its border, with the row's actions as 28px icon
 * buttons, each named in a tooltip with its key, and ⋯ for the rest of its right-click menu. It shows while the row is hovered
 * (its parent carries `group/bar`), while the row is under the vim cursor (`active`), and while its menu is open.
 */
export function HoverBar({ agent, active, actions, menu }: { agent: string; active?: boolean; actions: (Action | false | undefined)[]; menu: (MenuItem | false | undefined)[] }) {
  const [open, setOpen] = useState(false);
  const items = applying(menu);
  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        data-agent={`hoverbar:${agent}`}
        onClick={e => e.stopPropagation()}
        className={cn("absolute -top-4 right-3 z-10 hidden items-center gap-0.5 rounded-lg border bg-card p-0.5 shadow-raised group-hover/bar:flex", (active || open) && "flex")}
      >
        {actions.filter((x): x is Action => !!x).map(a => (
          <Tip key={a.label} label={a.label} keys={a.keys}>
            <button data-agent={a.agent} aria-label={a.label} onClick={a.run} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <a.icon className="size-4" />
            </button>
          </Tip>
        ))}
        {items.length > 0 && (
          <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
            <Tip label="More">
              <DropdownMenu.Trigger data-agent={`hoverbar-more:${agent}`} aria-label="More" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted">
                <Ellipsis className="size-4" />
              </DropdownMenu.Trigger>
            </Tip>
            <DropdownMenu.Portal>
              {/* Its keys are its own, as the right-click menu's are. */}
              <DropdownMenu.Content align="end" sideOffset={4} onEscapeKeyDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onCloseAutoFocus={e => e.preventDefault()} className="z-50 min-w-48 border bg-background p-1 text-sm shadow-lg">
                {items.map((x, i) =>
                  x === "-" ? (
                    <DropdownMenu.Separator key={i} className="my-1 h-px bg-border" />
                  ) : (
                    <DropdownMenu.Item key={x.label} data-agent={x.agent && `more-${x.agent}`} onSelect={x.run} className="flex cursor-pointer items-center gap-2 px-2 py-1 outline-none select-none data-highlighted:bg-muted">
                      <x.icon className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{x.label}</span>
                      {x.keys && <Kbd>{x.keys}</Kbd>}
                    </DropdownMenu.Item>
                  ),
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
    </Tooltip.Provider>
  );
}

function Tip({ label, keys, children }: { label: string; keys?: string; children: React.ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="top" sideOffset={6} className="z-50 flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs text-background">
          {label}
          {keys && <kbd className="rounded border border-background/30 px-1 font-sans text-[10px]">{keys}</kbd>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
