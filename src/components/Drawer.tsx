import { useRef } from "react";
import { useEventListener, usePresence } from "@/lib/effects";
import { cn } from "@/lib/utils";

// In on a spring-like ease-out, out a little faster; transform and opacity only, so nothing lays out while it moves.
const IN_MS = 240;
const OUT_MS = 170;
const IN_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const OUT_EASE = "cubic-bezier(0.4, 0, 1, 1)";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A panel that slides in from the right over a fading backdrop and slides back out before it unmounts. `children` is
 * drawn from the last open state while it leaves, and a new `contentKey` while open fades the content instead of re-sliding.
 */
export function Drawer({ open, onClose, contentKey, children, className, ...rest }: { open: boolean; onClose: () => void; contentKey?: string; children: React.ReactNode; className?: string; "data-agent"?: string }) {
  const { mounted, shown } = usePresence(open, reducedMotion() ? 0 : OUT_MS);
  const kept = useRef({ children, contentKey });
  if (open) kept.current = { children, contentKey };
  // The content it opened with arrives with the slide; only a switch while open fades.
  const openedWith = useRef(contentKey);
  if (!mounted) openedWith.current = contentKey;

  const panel = useRef<HTMLElement>(null);
  useEventListener("keydown", e => open && e.key === "Escape" && (e.stopImmediatePropagation(), onClose()), { capture: true });
  // The page stays clickable under the dimming: a click outside closes it, and runs before the page's own handler, so a
  // click on another event closes and reopens in one update and the content just fades over.
  useEventListener("click", e => open && !panel.current?.contains(e.target as Node) && onClose(), { target: document, capture: true });

  if (!mounted) return null;
  const motion = (ms: number, ease: string) => ({ transitionDuration: `${ms}ms`, transitionTimingFunction: ease });
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
        <div key={kept.current.contentKey} className={cn(kept.current.contentKey !== openedWith.current && "animate-in fade-in-0 duration-150 motion-reduce:animate-none", className)}>
          {kept.current.children}
        </div>
      </aside>
    </div>
  );
}
