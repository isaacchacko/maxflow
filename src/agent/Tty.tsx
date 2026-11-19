import { Dots } from "@/components/Working";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import type { Agent } from "@/mock";
import { addSignal, agentStore } from "@/store";
import { typedStore, type Line } from "./transcript";

const scrollToBottom = (line: HTMLElement | null) => {
  const list = line?.parentElement;
  if (list) list.scrollTop = list.scrollHeight;
};

function TtyLine({ l }: { l: Line }) {
  return (
    <>
      {l.kind === "system" && <p className="text-muted-foreground/60">{l.text}</p>}
      {l.kind === "router" && <p className="border-l-2 border-router/60 pl-3 text-router">{l.text}</p>}
      {l.kind === "sentry" && <p className="border-l-2 border-command/60 pl-3 text-command/90">{l.text}</p>}
      {l.kind === "user" && (
        <p className="bg-muted/40 px-2 py-1">
          <span className="text-link">&gt; </span>
          {l.text}
        </p>
      )}
      {l.kind === "assistant" && (
        <p>
          <span className="text-agent">⏺ </span>
          {l.text}
        </p>
      )}
      {l.kind === "tool" && (
        <>
          <p>
            <span className="text-ok">⏺ </span>
            <span className="font-semibold">{l.name}</span>
            <span className="text-muted-foreground">({l.arg})</span>
          </p>
          <p className="pl-4 text-muted-foreground">⎿ {l.result}</p>
        </>
      )}
      {l.kind === "working" && (
        <p className="flex items-center gap-2 text-agent">
          <Dots spin />
          <span className="shimmer">{l.text}…</span>
        </p>
      )}
    </>
  );
}

export function Tty({ agent, lines }: { agent: Agent; lines: Line[] }) {
  const [draft, setDraft] = usePersistentDraft(`tty:${agent.id}`);

  function send(e: React.SyntheticEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    addSignal({ source: "isaac", target: "chat", text, routedTo: [agent.id] });
    typedStore.set(t => ({ ...t, [agent.id]: [...(t[agent.id] ?? []), { kind: "user", text }] }));
    agentStore.set(all => all.map(a => (a.id === agent.id ? { ...a, state: "working", doing: text } : a)));
    setTimeout(() => {
      typedStore.set(t => ({ ...t, [agent.id]: [...(t[agent.id] ?? []), { kind: "assistant", text: "On it. I'll post back here when it's done." }] }));
    }, 700);
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border bg-card font-mono text-[13px] leading-relaxed">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {lines.map((l, i) => (
          <div key={i} ref={i === lines.length - 1 ? scrollToBottom : undefined} className="mb-2">
            <TtyLine l={l} />
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex items-center gap-2 border-t px-4 py-2.5">
        <span className="text-link">&gt;</span>
        <input
          data-agent="tty-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={`Message ${agent.id}`}
          className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
        />
      </form>
    </section>
  );
}
