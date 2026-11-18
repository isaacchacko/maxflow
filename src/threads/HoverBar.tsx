import { Ellipsis } from "lucide-react";
import { DropdownMenu, Tooltip } from "radix-ui";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { PinIcon, pinLook } from "./PinToggle";
import { applying, type MenuItem } from "./RowMenu";

type Action = Exclude<MenuItem, "-">;

/**
 * Slack's message toolbar: a small bar on a row's top-right edge, a third of it above the row and the rest inside, at the right
 * where it stays clear of the header's name and time on the left, with the row's actions as 32px icon buttons, each named in a
 * tooltip, and ⋯ for the rest of its right-click menu.
 * It shows while the row is hovered (its parent carries `group/bar`) and while its menu is open.
 */
export function HoverBar({ agent, actions, menu }: { agent: string; actions: (Action | false | undefined)[]; menu: (MenuItem | false | undefined)[] }) {
  const [open, setOpen] = useState(false);
  const items = applying(menu);
  // How far it reaches in from the row's right edge (32px buttons, 2px gaps, its padding, border and 16px inset), set on the row
  // as --bar-w so the header leaves that much room while it shows, and the name and time are never under it.
  const n = actions.filter(Boolean).length + (items.length > 0 ? 1 : 0);
  const reach = n * 32 + (n - 1) * 2 + 4 + 2 + 16;
  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        ref={el => void el?.parentElement?.style.setProperty("--bar-w", `${reach}px`)}
        data-agent={`hoverbar:${agent}`}
        onClick={e => e.stopPropagation()}
        className={cn("absolute -top-3 -right-1 z-10 hidden items-center gap-0.5 rounded-lg border bg-card p-0.5 shadow-raised group-hover/bar:flex", open && "flex")}
      >
        {actions.filter((x): x is Action => !!x).map(a => (
          <Tip key={a.label} label={a.label}>
            {/* A toggle (the pin) shows whether it is on, as the header's does. */}
            {a.pressed !== undefined ? (
              <button data-agent={a.agent} aria-label={a.label} aria-pressed={a.pressed} onClick={a.run} className={cn("flex size-8 items-center justify-center rounded-md", pinLook(a.pressed))}>
                <PinIcon on={a.pressed} className="size-4" />
              </button>
            ) : (
              <button data-agent={a.agent} aria-label={a.label} onClick={a.run} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                <a.icon className="size-4" />
              </button>
            )}
          </Tip>
        ))}
        {items.length > 0 && (
          <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
            <Tip label="More">
              <DropdownMenu.Trigger data-agent={`hoverbar-more:${agent}`} aria-label="More" className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted">
                <Ellipsis className="size-4" />
              </DropdownMenu.Trigger>
            </Tip>
            <DropdownMenu.Portal>
              {/* Its keys are its own (Escape closes it without climbing a level), as the right-click menu's are. */}
              <DropdownMenu.Content align="end" sideOffset={4} onEscapeKeyDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onCloseAutoFocus={e => e.preventDefault()} className="z-50 min-w-48 border bg-background p-1 text-sm shadow-lg">
                {items.map((x, i) =>
                  x === "-" ? (
                    <DropdownMenu.Separator key={i} className="my-1 h-px bg-border" />
                  ) : (
                    <DropdownMenu.Item key={x.label} data-agent={x.agent && `more-${x.agent}`} onSelect={x.run} className="flex cursor-pointer items-center gap-2 px-2 py-1 outline-none select-none data-highlighted:bg-muted">
                      <x.icon className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{x.label}</span>
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

function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="top" sideOffset={6} className="z-50 flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs text-background">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
