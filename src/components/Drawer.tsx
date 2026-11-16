import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const kept = useRef({ children, contentKey });
  if (open) kept.current = { children, contentKey };
  // The content it opened with arrives with the slide; only a switch while open fades.
  const openedWith = useRef(contentKey);
  if (!mounted) openedWith.current = contentKey;

  useLayoutEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      // One frame at rest off-screen first, so the slide has somewhere to start from.
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const done = setTimeout(() => setMounted(false), reducedMotion() ? 0 : OUT_MS);
    return () => clearTimeout(done);
  }, [open, mounted]);

  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopImmediatePropagation(), onClose());
    // The page stays clickable under the dimming: a click outside closes it, and runs before the page's own handler, so a
    // click on another event closes and reopens in one update and the content just fades over.
    const onClick = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && onClose();
    addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [open, onClose]);

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
