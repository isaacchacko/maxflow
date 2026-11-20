import { Link2, Trash2 } from "lucide-react";
import { createContext, use } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentFace } from "@/components/AgentFace";
import { useInterval } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { md } from "@/threads/rich/components";
import { type CanvasNode, markTyping } from "./canvas-api";

export type Selected = { from: string; text: string; near: number };
export type BoxActions = {
  path: string;
  zoom: number;
  isPicking: boolean;
  jump: (id: string) => void;
  hasBox: (id: string) => boolean;
  pick: (to: string) => void;
  edit: (id: string) => void;
  type: (id: string, text: string) => void;
  finish: (id: string) => void;
  place: (id: string, box: Partial<CanvasNode>, isDone: boolean) => void;
  remove: (id: string) => void;
  offerLink: (selected: Selected | undefined, at?: DOMRect) => void;
  startLink: (selected: Selected) => void;
};

export const BoxContext = createContext<BoxActions | undefined>(undefined);
const useActions = () => {
  const actions = use(BoxContext);
  if (!actions) throw new Error("a canvas box needs BoxContext");
  return actions;
};

const MIN = { width: 80, height: 40 };
const TYPING_BEAT_MS = 2000;

function LinkSpan({ href = "", children }: { href?: string | undefined; children?: React.ReactNode }) {
  const { jump, hasBox } = useActions();
  const id = href.slice(1);
  const isLive = hasBox(id);
  return (
    <span
      role="link"
      tabIndex={0}
      data-agent={`canvas:link:${id}`}
      title={isLive ? "Jump to the linked box" : "The linked box is gone"}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (isLive) jump(id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && isLive) jump(id);
      }}
      className={cn("cursor-pointer rounded-sm px-0.5 decoration-2 underline-offset-2", isLive ? "bg-amber-200/70 text-foreground hover:bg-amber-300/80 dark:bg-amber-400/25" : "text-muted-foreground line-through")}
    >
      {children}
    </span>
  );
}

const COMPONENTS: Components = { ...md, a: ({ href, children }) =>
    href?.startsWith("#") === true ? (
      <LinkSpan href={href}>{children}</LinkSpan>
    ) : (
      <a href={href} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()} className="text-link hover:underline">
        {children}
      </a>
    ),
};
const keepAnchors = (url: string) => (url.startsWith("#") ? url : defaultUrlTransform(url));

function dragWith(e: React.PointerEvent, zoom: number, onMove: (dx: number, dy: number) => void, onEnd: () => void) {
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget;
  const [sx, sy] = [e.clientX, e.clientY];
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => onMove((ev.clientX - sx) / zoom, (ev.clientY - sy) / zoom);
  const up = () => {
    el.removeEventListener("pointermove", move as EventListener);
    onEnd();
  };
  el.addEventListener("pointermove", move as EventListener);
  el.addEventListener("pointerup", up, { once: true });
}

function selectedIn(body: HTMLElement, from: string): { selected: Selected; rect: DOMRect } | undefined {
  const sel = getSelection();
  const text = sel?.toString().trim() ?? "";
  if (!sel || sel.rangeCount === 0 || text === "" || !body.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const before = document.createRange();
  before.setStart(body, 0);
  before.setEnd(range.startContainer, range.startOffset);
  return { selected: { from, text, near: before.toString().length }, rect: range.getBoundingClientRect() };
}

function Editor({ node }: { node: CanvasNode }) {
  const { path, type, finish, startLink } = useActions();
  useInterval(async () => markTyping(path, node.id), TYPING_BEAT_MS);
  const linkSelection = (el: HTMLTextAreaElement) => {
    if (el.selectionStart === el.selectionEnd) return;
    const raw = el.value.slice(el.selectionStart, el.selectionEnd);
    const text = raw.trim();
    startLink({ from: node.id, text, near: el.selectionStart + raw.indexOf(text) });
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape" || (e.key === "Enter" && isMod)) e.currentTarget.blur();
    if (e.key !== "k" || !isMod) return;
    e.preventDefault();
    linkSelection(e.currentTarget);
  };
  return (
    <textarea
      autoFocus
      onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
      data-agent={`canvas:editor:${node.id}`}
      value={node.text}
      placeholder="Write in markdown…"
      onChange={(e) => type(node.id, e.target.value)}
      onBlur={() => finish(node.id)}
      onKeyDown={onKey}
      className="min-h-0 flex-1 resize-none bg-transparent px-3 pb-2 font-mono text-[13px] leading-relaxed outline-none"
    />
  );
}

function Bar({ node, isEditing }: { node: CanvasNode; isEditing: boolean }) {
  const { zoom, place, remove } = useActions();
  const startMove = (e: React.PointerEvent) => {
    let at = { x: node.x, y: node.y };
    dragWith(
      e,
      zoom,
      (dx, dy) => {
        at = { x: Math.round(node.x + dx), y: Math.round(node.y + dy) };
        place(node.id, at, false);
      },
      () => place(node.id, at, true),
    );
  };
  const isAgent = hasText(node.author) && node.author !== "isaac";
  return (
    <div onPointerDown={startMove} className={cn("flex h-6 shrink-0 cursor-grab items-center gap-1 px-1.5 active:cursor-grabbing", !isEditing && "opacity-0 group-hover:opacity-100")}>
      {isAgent && <AgentFace id={node.author ?? ""} small still className="size-4" />}
      <span className="flex-1" />
      {isEditing && <span className="text-[10px] text-muted-foreground">select text, ⌘K to link</span>}
      <button
        type="button"
        title="Delete box"
        data-agent={`canvas:delete:${node.id}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => remove(node.id)}
        className="rounded p-0.5 text-muted-foreground hover:bg-black/[0.06] hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

export function Box({ node, isEditing, isFlashing }: { node: CanvasNode; isEditing: boolean; isFlashing: boolean }) {
  const actions = useActions();
  const startResize = (e: React.PointerEvent) => {
    let size = { width: node.width, height: node.height };
    dragWith(
      e,
      actions.zoom,
      (dx, dy) => {
        size = { width: Math.max(MIN.width, Math.round(node.width + dx)), height: Math.max(MIN.height, Math.round(node.height + dy)) };
        actions.place(node.id, size, false);
      },
      () => actions.place(node.id, size, true),
    );
  };
  return (
    <div
      data-agent={`canvas:node:${actions.path}:${node.id}`}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (actions.isPicking) actions.pick(node.id);
      }}
      className={cn(
        "group absolute flex flex-col rounded-lg border bg-card shadow-sm transition-shadow",
        isEditing && "ring-2 ring-link/60",
        isFlashing && "ring-4 ring-amber-400",
        actions.isPicking && "cursor-crosshair hover:ring-2 hover:ring-amber-400",
      )}
    >
      <Bar node={node} isEditing={isEditing} />
      {isEditing ? (
        <Editor node={node} />
      ) : (
        <div
          onDoubleClick={() => actions.edit(node.id)}
          onMouseUp={(e) => {
            const found = selectedIn(e.currentTarget, node.id);
            actions.offerLink(found?.selected, found?.rect);
          }}
          className="min-h-0 flex-1 cursor-text overflow-hidden px-3 pb-2 text-sm leading-relaxed select-text"
        >
          {hasText(node.text) ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} urlTransform={keepAnchors}>
              {node.text}
            </ReactMarkdown>
          ) : (
            <span className="text-muted-foreground">Empty, double-click to write</span>
          )}
        </div>
      )}
      <div onPointerDown={startResize} title="Resize" className="absolute right-0 bottom-0 size-3.5 cursor-nwse-resize opacity-0 group-hover:opacity-100">
        <svg viewBox="0 0 10 10" className="size-full text-muted-foreground" aria-hidden>
          <path d="M9 3 L3 9 M9 6 L6 9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
    </div>
  );
}

export function LinkOffer({ at, onLink }: { at: DOMRect; onLink: () => void }) {
  return (
    <button
      type="button"
      data-agent="canvas:link-selection"
      style={{ left: at.left + at.width / 2, top: at.bottom + 6 }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onLink}
      className="fixed z-50 flex -translate-x-1/2 items-center gap-1 rounded-md border bg-popover px-2 py-1 text-xs font-medium shadow-md hover:bg-muted"
    >
      <Link2 className="size-3.5" />
      Link to a box
    </button>
  );
}
