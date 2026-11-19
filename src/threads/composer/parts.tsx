import { ArrowUpToLine, AtSign, Ellipsis, Plus, SendHorizontal, Smile, Type, X } from "lucide-react";
import { useRef, useState } from "react";
import { useEventListener } from "@/lib/effects";
import { cn } from "@/lib/utils";
import { EmojiPanel } from "../Emoji";
import { Markdown } from "../Rich";
import { FORMAT_GROUP_STARTS, FORMATS, type Edit } from "./edits";
import { imagesIn } from "./images";

const TOOL = "flex size-7 items-center justify-center rounded-md text-muted-foreground/80 hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground";

export const keepFocusInTheBox = (e: React.MouseEvent) => e.preventDefault();

export function FormatRow({ agent, onEdit }: { agent: string; onEdit: (change: (e: Edit) => Edit) => void }) {
  return (
    <div className="flex items-center gap-0.5 px-1.5 pt-1" data-agent={`${agent}-format`}>
      {FORMATS.map((f, i) => (
        <span key={f.label} className="contents">
          {FORMAT_GROUP_STARTS.has(i) && <span className="mx-1 h-4 w-px bg-border" />}
          <button type="button" tabIndex={-1} aria-label={f.label} title={f.keys === undefined ? f.label : `${f.label} (${f.keys})`} onMouseDown={keepFocusInTheBox} onClick={() => onEdit(f.apply)} className={TOOL}>
            <f.icon className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

export function QuoteBox({ agent, quote, onRemove }: { agent: string; quote: string; onRemove: () => void }) {
  return (
    <div className="relative mx-3 mt-2 max-h-32 overflow-y-auto pr-6" data-agent={`${agent}-quote`}>
      <Markdown text={quote} className="text-xs" />
      <button type="button" aria-label="Remove quote" onClick={onRemove} className="absolute top-0 right-0 rounded-md p-0.5 hover:bg-muted">
        <X className="size-3" />
      </button>
    </div>
  );
}

export function RaiseToggle({ agent, isRaising, onToggle }: { agent: string; isRaising: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-agent={`${agent}-raise`}
      aria-pressed={isRaising}
      onMouseDown={keepFocusInTheBox}
      onClick={onToggle}
      className={cn("mx-3 mt-1.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs", isRaising ? "bg-link/10 text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
    >
      <ArrowUpToLine className="size-3" />
      {isRaising ? "Sends as a new thread in Threads" : "Post as a new thread"}
    </button>
  );
}

function Popover({ onClose, className, children, agent }: { onClose: () => void; className?: string; children: React.ReactNode; agent?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEventListener("mousedown", e => {
    const button = ref.current?.parentElement;
    if (!ref.current || (e.target instanceof Node && button?.contains(e.target) === true)) return;
    onClose();
  });
  useEventListener("keydown", e => {
    if (e.key === "Escape") onClose();
  });
  return (
    <div ref={ref} data-agent={agent} className={cn("absolute bottom-9 left-0 z-20 rounded-xl border bg-card shadow-card", className)}>
      {children}
    </div>
  );
}

function EmojiButton({ onPick }: { onPick: (emoji: string) => void }) {
  const [isOpen, setOpen] = useState(false);
  return (
    <span className="relative">
      <button type="button" aria-label="Emoji" title="Emoji" aria-expanded={isOpen} onMouseDown={keepFocusInTheBox} onClick={() => setOpen(o => !o)} className={TOOL}>
        <Smile className="size-3.5" />
      </button>
      {isOpen && (
        <Popover onClose={() => setOpen(false)} agent="composer-emoji">
          <EmojiPanel
            onPick={e => {
              onPick(e);
              setOpen(false);
            }}
          />
        </Popover>
      )}
    </span>
  );
}

function MoreTools({ tools, isToolOn }: { tools: React.ReactNode; isToolOn: boolean }) {
  const [isOpen, setOpen] = useState(false);
  return (
    <span className="relative">
      <button type="button" aria-label="More" title="More" aria-expanded={isOpen} onMouseDown={keepFocusInTheBox} onClick={() => setOpen(o => !o)} className={cn(TOOL, isToolOn && "text-link")}>
        <Ellipsis className="size-3.5" />
      </button>
      {isOpen && (
        <Popover onClose={() => setOpen(false)} className="w-72 p-1">
          {tools}
        </Popover>
      )}
    </span>
  );
}

function clearChosenFiles(element: HTMLInputElement) {
  element.value = "";
}

type ToolbarProps = {
  isFormatting: boolean;
  onToggleFormatting: () => void;
  onAttach: (files: File[]) => void;
  onEmoji: (emoji: string) => void;
  onMention: () => void;
  tools: React.ReactNode;
  isToolOn: boolean;
  canSend: boolean;
};

export function Toolbar({ isFormatting, onToggleFormatting, onAttach, onEmoji, onMention, tools, isToolOn, canSend }: ToolbarProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
      <button type="button" aria-label="Attach an image" title="Attach an image" onMouseDown={keepFocusInTheBox} onClick={() => fileInput.current?.click()} className={cn(TOOL, "rounded-full bg-muted/70")}>
        <Plus className="size-3.5" />
      </button>
      <button type="button" aria-label="Formatting" title={isFormatting ? "Hide formatting" : "Show formatting"} aria-pressed={isFormatting} onMouseDown={keepFocusInTheBox} onClick={onToggleFormatting} className={TOOL}>
        <Type className="size-3.5" />
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={e => {
          onAttach(imagesIn(e.target.files));
          clearChosenFiles(e.target);
        }}
      />
      <EmojiButton onPick={onEmoji} />
      <button type="button" aria-label="Mention an agent or thread" title="Mention an agent or thread (@)" onMouseDown={keepFocusInTheBox} onClick={onMention} className={TOOL}>
        <AtSign className="size-3.5" />
      </button>
      {Boolean(tools) && <MoreTools tools={tools} isToolOn={isToolOn} />}
      <button type="submit" aria-label="Send" title="Send (Return)" disabled={!canSend} onMouseDown={keepFocusInTheBox} className="ml-auto flex h-7 w-8 items-center justify-center rounded-md bg-ok text-white transition-colors disabled:bg-transparent disabled:text-muted-foreground/50">
        <SendHorizontal className="size-3.5" />
      </button>
    </div>
  );
}
