import { useRef, useState } from "react";
import { useEventListener, usePresence } from "@/lib/effects";
import { cn } from "@/lib/utils";

const IN_MS = 240;
const OUT_MS = 170;
const IN_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const OUT_EASE = "cubic-bezier(0.4, 0, 1, 1)";

const isMotionReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const motion = (ms: number, ease: string) => ({ transitionDuration: `${ms}ms`, transitionTimingFunction: ease });

function useContentKeptWhileClosing(isOpen: boolean, isMounted: boolean, children: React.ReactNode, contentKey: string | undefined) {
  const [lastOpen, setLastOpen] = useState({ children, contentKey });
  if (isOpen && (lastOpen.children !== children || lastOpen.contentKey !== contentKey)) setLastOpen({ children, contentKey });
  const [contentKeyOpenedWith, setContentKeyOpenedWith] = useState(contentKey);
  if (!isMounted && contentKeyOpenedWith !== contentKey) setContentKeyOpenedWith(contentKey);
  const drawn = isOpen ? { children, contentKey } : lastOpen;
  return { ...drawn, isSwitchedWhileOpen: drawn.contentKey !== contentKeyOpenedWith };
}

function useCloseOnEscapeOrClickOutside(isOpen: boolean, onClose: () => void, panel: React.RefObject<HTMLElement | null>) {
  useEventListener(
    "keydown",
    e => {
      if (!isOpen || e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    },
    { capture: true },
  );
  const closeOnClickOutsideBeforeThePageHandlesIt = (e: MouseEvent) => {
    if (isOpen && panel.current?.contains(e.target as Node) !== true) onClose();
  };
  useEventListener("click", closeOnClickOutsideBeforeThePageHandlesIt, { target: document, capture: true });
}

export function Drawer({ open, onClose, contentKey, children, className, ...rest }: { open: boolean; onClose: () => void; contentKey?: string; children: React.ReactNode; className?: string; "data-agent"?: string }) {
  const { mounted, shown } = usePresence(open, isMotionReduced() ? 0 : OUT_MS);
  const drawn = useContentKeptWhileClosing(open, mounted, children, contentKey);
  const panel = useRef<HTMLElement>(null);
  useCloseOnEscapeOrClickOutside(open, onClose, panel);

  if (!mounted) return null;
  const timing = shown ? motion(IN_MS, IN_EASE) : motion(OUT_MS, OUT_EASE);
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      <div className={cn("absolute inset-0 bg-black/30 transition-opacity motion-reduce:transition-none", shown ? "opacity-100" : "opacity-0")} style={timing} />
      <aside
        {...rest}
        ref={panel}
        style={timing}
        className={cn(
          "absolute inset-y-0 right-0 w-[min(520px,100vw)] overflow-y-auto border-l bg-card shadow-2xl transition-[translate,opacity] will-change-[translate,opacity] motion-reduce:transition-none",
          shown ? "translate-x-0 opacity-100" : "translate-x-full opacity-0",
          open && "pointer-events-auto",
        )}
      >
        <div key={drawn.contentKey} className={cn(drawn.isSwitchedWhileOpen && "animate-in fade-in-0 duration-150 motion-reduce:animate-none", className)}>
          {drawn.children}
        </div>
      </aside>
    </div>
  );
}
