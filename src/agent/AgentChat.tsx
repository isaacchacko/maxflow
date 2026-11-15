import { useEffect, useRef, useState } from "react";
import { Face } from "./AgentFace";
import { act } from "./plan";

type Line = { from: "you" | "agent"; text: string };

export function AgentChat() {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { from: "agent", text: "Hi. Tell me what to do, like \"start the close-path reconciler\" or \"move pagination to done\"." },
  ]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || working) return;
    setInput("");
    setLines(l => [...l, { from: "you", text }]);
    setWorking(true);
    try {
      await act(text, say => setLines(l => [...l, { from: "agent", text: say }]));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="fixed right-5 bottom-5 z-40 flex flex-col items-end gap-3">
      {open && (
        <div className="flex h-96 w-80 flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950/95 shadow-2xl backdrop-blur">
          <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
            <Face working={working} size={24} />
            <span className="text-sm font-medium">maxflow</span>
            <span className="text-xs text-neutral-500">{working ? "working…" : "idle"}</span>
            <button onClick={() => setOpen(false)} className="ml-auto text-neutral-500 hover:text-neutral-200">
              ✕
            </button>
          </header>
          <div ref={listRef} className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
            {lines.map((line, i) => (
              <p
                key={i}
                className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm ${
                  line.from === "you" ? "ml-auto bg-violet-600/70" : "bg-neutral-800"
                }`}
              >
                {line.text}
              </p>
            ))}
          </div>
          <form onSubmit={send} className="border-t border-neutral-800 p-2">
            <input
              autoFocus
              value={input}
              onChange={e => setInput(e.target.value)}
              disabled={working}
              placeholder={working ? "Working…" : "Ask the agent…"}
              className="w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 disabled:opacity-50"
            />
          </form>
        </div>
      )}
      <button
        data-agent="face"
        onClick={() => setOpen(o => !o)}
        className="rounded-full shadow-lg transition-transform hover:scale-105 active:scale-95"
      >
        <Face working={working} />
      </button>
    </div>
  );
}
