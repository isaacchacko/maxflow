import { useCallback } from "react";
import { AgentFace, faceOf } from "@/components/AgentFace";
import { rigCursor, runCursors, shownCursorsStore, type Shown } from "./engine";
import { shownStore } from "./store";

export const colorOf = (agent: string) => `hsl(${faceOf(agent).hue} 62% 48%)`;

const ARROW = "M1.5 1.5 L1.5 19.5 L6.6 14.6 L10 22.2 L13.3 20.8 L9.9 13.3 L16.8 13.3 Z";

function Arrow({ color }: { color: string }) {
  return (
    <svg width="20" height="24" viewBox="0 0 20 24" className="absolute top-0 left-0 drop-shadow-[0_1px_2px_rgb(0_0_0/0.3)]" aria-hidden>
      <path d={ARROW} fill={color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function Label({ agent, name, action, color }: Shown & { color: string }) {
  return (
    <div style={{ background: color }} className="absolute top-5 left-3.5 flex max-w-72 items-center gap-1 rounded-full py-0.5 pr-2.5 pl-0.5 text-xs font-medium whitespace-nowrap text-white shadow-md">
      <span className="rounded-full bg-white/90 p-px">
        <AgentFace id={agent} small still className="size-4" />
      </span>
      <span className="truncate">{name}</span>
      <span className="shrink-0 opacity-75">{action}</span>
    </div>
  );
}

function Edge({ agent, color }: { agent: string; color: string }) {
  return (
    <div data-part="edge" style={{ display: "none" }} className="absolute top-0 left-0 will-change-transform">
      <div className="absolute -top-3.5 -left-3.5 size-7">
        <div data-part="pointer" className="absolute inset-0">
          <span style={{ borderLeftColor: color }} className="absolute top-1/2 -right-2 -translate-y-1/2 border-y-[6px] border-l-[9px] border-y-transparent" />
        </div>
        <span style={{ borderColor: color }} className="absolute inset-0 flex items-center justify-center rounded-full border-2 bg-white shadow-md">
          <AgentFace id={agent} small still className="size-5" />
        </span>
      </div>
    </div>
  );
}

function AgentCursor(shown: Shown) {
  const { agent } = shown;
  const color = colorOf(agent);
  const rig = useCallback((root: HTMLDivElement) => rigCursor(agent, root), [agent]);
  return (
    <div ref={rig} data-cursor={agent} style={{ opacity: 0 }} className="absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none">
      <div data-part="arrow" style={{ display: "none" }} className="absolute top-0 left-0 will-change-transform">
        <span data-part="pulse" style={{ background: color, opacity: 0 }} className="absolute top-0 left-0 size-9 -translate-x-1/2 -translate-y-1/2 rounded-full" />
        <Arrow color={color} />
        <Label {...shown} color={color} />
      </div>
      <Edge agent={agent} color={color} />
    </div>
  );
}

export function Cursors() {
  const isShown = shownStore.use();
  const shown = shownCursorsStore.use();
  if (!isShown) return null;
  return (
    <div ref={runCursors} aria-hidden data-agent="cursors" className="pointer-events-none fixed inset-0 z-[70] overflow-hidden">
      {shown.map(s => (
        <AgentCursor key={s.agent} {...s} />
      ))}
    </div>
  );
}
