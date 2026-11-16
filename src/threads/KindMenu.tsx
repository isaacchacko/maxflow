import { Check, ChevronDown, MessagesSquare, Zap, type LucideIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { setKind } from "@/store";

type Kind = NonNullable<Thread["kind"]>;

/** The glyph each kind of thread draws as, wherever its kind shows, and what choosing it means. */
export const KINDS: Record<Kind, { icon: LucideIcon; label: string; means: string }> = {
  conversation: { icon: MessagesSquare, label: "Conversation", means: "Talked through: its router keeps the thread open and answers as you go" },
  command: { icon: Zap, label: "Command", means: "Just done: its router acts on it and answers once, with the result" },
};

/** The thread's kind as its glyph beside the title; clicking it offers both kinds, and a flip goes to its routers. */
export function KindMenu({ thread }: { thread: Thread }) {
  const kind = thread.kind ?? "conversation";
  const Icon = KINDS[kind].icon;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        data-agent="thread-kind"
        title={`${KINDS[kind].label}: click to change`}
        className="group/kind flex shrink-0 items-center gap-0.5 border border-transparent p-1 text-muted-foreground outline-none hover:border-border hover:text-foreground data-[state=open]:border-border data-[state=open]:text-foreground"
      >
        <Icon className={cn("size-4", kind === "command" && "text-amber-400")} />
        <ChevronDown className="size-3 opacity-0 group-hover/kind:opacity-100 group-data-[state=open]/kind:opacity-100" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} data-agent="menu:thread-kind" className="z-50 w-80 border bg-background p-1 text-sm shadow-lg">
          {(Object.keys(KINDS) as Kind[]).map(k => {
            const { icon: KIcon, label, means } = KINDS[k];
            return (
              <DropdownMenu.Item
                key={k}
                data-agent={`thread-kind:${k}`}
                onSelect={() => k !== kind && setKind(thread.id, k)}
                className="flex cursor-pointer items-start gap-2 px-2 py-1.5 outline-none select-none data-highlighted:bg-muted"
              >
                <KIcon className={cn("mt-0.5 size-3.5 shrink-0", k === "command" ? "text-amber-400" : "text-muted-foreground")} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{label}</span>
                  <span className="text-xs text-muted-foreground">{means}</span>
                </span>
                <Check className={cn("mt-0.5 size-3.5 shrink-0", k === kind ? "text-sky-400" : "invisible")} />
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
