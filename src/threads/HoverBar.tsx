import { Ellipsis } from "lucide-react";
import { DropdownMenu, Tooltip } from "radix-ui";
import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import { PinIcon, pinLook } from "./PinToggle";
import { applying, type MenuItem } from "./RowMenu";

type Action = Exclude<MenuItem, "-">;

const BUTTON_PX = 32;
const GAP_PX = 2;
const PADDING_PX = 4;
const BORDER_PX = 2;
const INSET_PX = 16;

export function HoverBar({ agent, actions, menu }: { agent: string; actions: (Action | false | undefined)[]; menu: (MenuItem | false | undefined)[] }) {
  const [open, setOpen] = useState(false);
  const items = applying(menu);
  const shownActions = actions.filter(x => x !== false && x !== undefined);
  const buttons = shownActions.length + (items.length > 0 ? 1 : 0);
  const reachFromRowEdge = buttons * BUTTON_PX + (buttons - 1) * GAP_PX + PADDING_PX + BORDER_PX + INSET_PX;
  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        ref={el => {
          el?.parentElement?.style.setProperty("--bar-w", `${reachFromRowEdge}px`);
        }}
        data-agent={`hoverbar:${agent}`}
        onClick={e => e.stopPropagation()}
        className={cn("absolute -top-3 -right-1 z-10 hidden items-center gap-0.5 rounded-lg border bg-card p-0.5 shadow-raised group-hover/bar:flex", open && "flex")}
      >
        {shownActions.map(a => (
          <Tip key={a.label} label={a.label}>
            {a.pressed === undefined ? (
              <button data-agent={a.agent} aria-label={a.label} onClick={a.run} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                <a.icon className="size-4" />
              </button>
            ) : (
              <button data-agent={a.agent} aria-label={a.label} aria-pressed={a.pressed} onClick={a.run} className={cn("flex size-8 items-center justify-center rounded-md", pinLook(a.pressed))}>
                <PinIcon on={a.pressed} className="size-4" />
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
              <DropdownMenu.Content align="end" sideOffset={4} onEscapeKeyDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onCloseAutoFocus={e => e.preventDefault()} className="z-50 min-w-48 border bg-background p-1 text-sm shadow-lg">
                {items.map((x, i) =>
                  x === "-" ? (
                    <DropdownMenu.Separator key={i} className="my-1 h-px bg-border" />
                  ) : (
                    <DropdownMenu.Item key={x.label} data-agent={hasText(x.agent) ? `more-${x.agent}` : undefined} onSelect={x.run} className="flex cursor-pointer items-center gap-2 px-2 py-1 outline-none select-none data-highlighted:bg-muted">
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
