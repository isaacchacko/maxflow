import { useEffect, useRef, useState } from "react";
import { cursorStore } from "./cursor";

function useLookAt(ref: React.RefObject<HTMLElement | null>) {
  const cursor = cursorStore.use();
  const [mouse, setMouse] = useState({ x: innerWidth / 2, y: innerHeight / 2 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => setMouse({ x: e.clientX, y: e.clientY });
    addEventListener("mousemove", onMove);
    return () => removeEventListener("mousemove", onMove);
  }, []);
  const target = cursor.visible ? cursor : mouse;
  const r = ref.current?.getBoundingClientRect();
  if (!r) return { dx: 0, dy: 0 };
  const angle = Math.atan2(target.y - (r.y + r.height / 2), target.x - (r.x + r.width / 2));
  return { dx: Math.cos(angle) * 3, dy: Math.sin(angle) * 3 };
}

export function Face({ working, size = 48 }: { working: boolean; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { dx, dy } = useLookAt(ref);
  return (
    <div ref={ref} className="relative" style={{ width: size, height: size }}>
      <div
        className={`absolute -inset-0.5 rounded-full bg-conic from-violet-500 via-sky-400 to-violet-500 ${
          working ? "animate-spin opacity-100" : "opacity-0"
        } transition-opacity`}
      />
      <svg viewBox="0 0 48 48" className="relative size-full rounded-full bg-neutral-900">
        <g
          style={{ transform: `translate(${dx}px, ${dy}px)`, transition: "transform 120ms ease-out" }}
          className="fill-white"
        >
          <g className="agent-blink">
            <rect x="14" y="17" width="6" height="12" rx="3" />
            <rect x="28" y="17" width="6" height="12" rx="3" />
          </g>
        </g>
      </svg>
    </div>
  );
}
