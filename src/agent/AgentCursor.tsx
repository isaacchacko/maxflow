import { cursorStore } from "./cursor";

export function AgentCursor() {
  const c = cursorStore.use();
  return (
    <div
      className="pointer-events-none fixed top-0 left-0 z-50"
      style={{
        transform: `translate(${c.x}px, ${c.y}px)`,
        transition: `transform ${c.duration}ms cubic-bezier(0.45, 0, 0.2, 1), opacity 200ms`,
        opacity: c.visible ? 1 : 0,
      }}
    >
      <span key={c.clicks} className={c.clicks ? "agent-ripple" : ""} />
      {c.ghost && (
        <div className="absolute top-10 left-2 w-56 rotate-2 rounded-lg border border-violet-500/60 bg-neutral-900/90 p-3 text-sm shadow-2xl">
          {c.ghost}
        </div>
      )}
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        className="relative drop-shadow-lg transition-transform"
        style={{ transform: c.pressing ? "scale(0.85)" : "scale(1)" }}
      >
        <path d="M3 2l7 19 2.5-7.5L20 11z" className="fill-violet-500 stroke-white" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      <span className="absolute top-5 left-5 rounded-full bg-violet-500 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white">
        maxflow
      </span>
    </div>
  );
}
