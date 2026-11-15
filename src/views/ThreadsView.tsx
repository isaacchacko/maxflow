import { useState } from "react";
import { statusColor, tasks, type Message } from "../mock";

const bubble: Record<Message["from"], string> = {
  isaac: "ml-auto bg-sky-900/60",
  agent: "bg-neutral-800",
  sentry: "mx-auto bg-transparent text-xs text-neutral-500",
};

export function ThreadsView() {
  const [selectedId, setSelectedId] = useState(tasks[0]!.id);
  const selected = tasks.find(t => t.id === selectedId)!;

  return (
    <div className="flex h-full">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-neutral-800">
        {tasks.map(t => {
          const last = t.messages.at(-1);
          return (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={`block w-full border-b border-neutral-900 px-4 py-3 text-left ${
                t.id === selectedId ? "bg-neutral-900" : "hover:bg-neutral-900/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`size-2 shrink-0 rounded-full ${statusColor[t.status]}`} />
                <span className="truncate text-sm">{t.title}</span>
                <span className="ml-auto shrink-0 text-xs text-neutral-600">{last?.at}</span>
              </div>
              <p className="mt-1 truncate pl-4 text-xs text-neutral-500">{last?.text ?? "No messages"}</p>
            </button>
          );
        })}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-medium">{selected.title}</h2>
          {selected.agent && <span className="text-xs text-neutral-500">{selected.agent}</span>}
          {selected.pr && <span className="text-xs text-neutral-500">#{selected.pr}</span>}
        </header>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          {selected.messages.map((m, i) => (
            <div key={i} className={`max-w-lg rounded-lg px-3 py-2 text-sm ${bubble[m.from]}`}>
              {m.text}
              <div className="mt-1 text-xs text-neutral-500">{m.at}</div>
            </div>
          ))}
        </div>
        <footer className="border-t border-neutral-800 p-3">
          <textarea
            rows={2}
            placeholder={`Message ${selected.agent ?? "a new agent"}…`}
            className="w-full resize-none rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
          />
        </footer>
      </section>
    </div>
  );
}
