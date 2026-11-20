import { useState } from "react";
import { Pause, Play, RotateCcw, Zap } from "lucide-react";
import { AgentFace } from "@/components/AgentFace";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useInterval } from "@/lib/effects";
import { cn } from "@/lib/utils";
import { MessageRow } from "@/threads/MessageRow";
import { colorOf } from "./engine";
import { onLand } from "./holds";
import { fireCursor, missedStore, recentStore, setShown, shownStore, tuningStore, type CursorEvent, type Tuning } from "./store";

const AGENTS = [
  { agent: "7c1e9a42", name: "inbox fixer" },
  { agent: "3fb08d17", name: "board tidier" },
  { agent: "e95a2c60", name: "docs writer" },
];
const AT = new Date().toISOString();

type Stage = {
  threads: { id: string; from: string; text: string; merged: number }[];
  objectives: { id: string; title: string; threads: string[] }[];
  tasks: { id: string; title: string; isDone: boolean }[];
  archive: { id: string; title: string }[];
  cards: { id: string; text: string }[];
  todo: string[];
};

const FIRST: Stage = {
  threads: [
    { id: "dev-th-1", from: "isaac", text: "can you make the cursors glide a bit slower?", merged: 0 },
    { id: "dev-th-2", from: "7c1e9a42", text: "Shipped the inbox fix, CI is green.", merged: 0 },
    { id: "dev-th-3", from: "isaac", text: "why is the board stuck on Review?", merged: 0 },
    { id: "dev-th-4", from: "3fb08d17", text: "Board is stuck on Review again.", merged: 0 },
  ],
  objectives: ["yarn polish", "maxflow development", "cleopatra handoff"].map((title, i) => ({ id: `dev-o${i + 1}`, title, threads: [] })),
  tasks: Array.from({ length: 3 }, (_, i) => ({ id: `dev-t${i + 1}`, title: `Task ${i + 1}`, isDone: false })),
  archive: Array.from({ length: 12 }, (_, i) => ({ id: `dev-a${i + 1}`, title: `Old task ${i + 1}` })),
  cards: [
    { id: "dev-b1", text: "Status: on track" },
    { id: "dev-b2", text: "Risks: none yet" },
    { id: "dev-b3", text: "Next: record the gif" },
  ],
  todo: [],
};

type Step = Pick<CursorEvent, "gesture" | "action" | "to" | "from" | "into" | "carry"> & { change: (s: Stage) => Stage };

const titleOf = (s: Stage, id: string) => s.threads.find(t => t.id === id)?.text ?? id;

const SCRIPT: Step[] = [
  {
    gesture: "drag",
    action: "move thread",
    from: ["inbox-row:dev-th-2"],
    to: ["objective:dev-o3"],
    change: s => ({ ...s, objectives: s.objectives.map(o => (o.id === "dev-o3" ? { ...o, threads: [...o.threads, titleOf(s, "dev-th-2")] } : o)) }),
  },
  { gesture: "edit", action: "retitle task", to: ["row:dev-t2"], change: s => ({ ...s, tasks: s.tasks.map(t => (t.id === "dev-t2" ? { ...t, title: "Ship the cursor rework" } : t)) }) },
  {
    gesture: "create",
    action: "new task",
    to: ["row:dev-t4"],
    into: ["tasks:dev-o1"],
    change: s => ({ ...s, tasks: [...s.tasks, { id: "dev-t4", title: "Record the gestures", isDone: false }] }),
  },
  { gesture: "delete", action: "remove card", to: ["block:dev-b2"], change: s => ({ ...s, cards: s.cards.filter(c => c.id !== "dev-b2") }) },
  {
    gesture: "drag",
    action: "merge thread",
    from: ["inbox-row:dev-th-4"],
    to: ["inbox-row:dev-th-3"],
    change: s => ({ ...s, threads: s.threads.filter(t => t.id !== "dev-th-4").map(t => (t.id === "dev-th-3" ? { ...t, merged: t.merged + 1 } : t)) }),
  },
  { gesture: "edit", action: "rename objective", to: ["objective:dev-o1"], change: s => ({ ...s, objectives: s.objectives.map(o => (o.id === "dev-o1" ? { ...o, title: "yarn polish, round two" } : o)) }) },
  {
    gesture: "drag",
    action: "tag todo",
    from: ["chip:dev-th-1"],
    to: ["todo:dev-td1"],
    carry: "can you make the cursors glide a bit slower?",
    change: s => ({ ...s, todo: [...s.todo, titleOf(s, "dev-th-1")] }),
  },
  { gesture: "edit", action: "mark done", to: ["row:dev-t1"], change: s => ({ ...s, tasks: s.tasks.map(t => (t.id === "dev-t1" ? { ...t, isDone: true } : t)) }) },
  { gesture: "create", action: "add card", to: ["block:dev-b4"], into: ["dev-page"], change: s => ({ ...s, cards: [...s.cards, { id: "dev-b4", text: "Shipped: gestures" }] }) },
  { gesture: "edit", action: "retitle task", to: ["row:dev-a11"], change: s => ({ ...s, archive: s.archive.map(t => (t.id === "dev-a11" ? { ...t, title: "Off screen, so no cursor" } : t)) }) },
];

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} className="w-24" />
      <span className="w-8 tabular-nums text-foreground">{value}</span>
    </label>
  );
}

function Controls({ isPlaying, onPlay, onFire, onReset }: { isPlaying: boolean; onPlay: () => void; onFire: () => void; onReset: () => void }) {
  const tuning = tuningStore.use();
  const isShown = shownStore.use();
  const tune = (patch: Partial<Tuning>) => tuningStore.set(t => ({ ...t, ...patch }));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3">
      <Button size="sm" onClick={onPlay} data-agent="cursors-play">
        {isPlaying ? <Pause /> : <Play />}
        {isPlaying ? "Stop" : "Play script"}
      </Button>
      <Button size="sm" variant="outline" onClick={onFire} data-agent="cursors-fire">
        <Zap />
        Fire one
      </Button>
      <Button size="sm" variant="ghost" onClick={onReset} data-agent="cursors-reset">
        <RotateCcw />
        Reset
      </Button>
      <Slider label="Speed" value={tuning.speed} min={0.25} max={3} step={0.25} onChange={speed => tune({ speed })} />
      <Slider label="Arc" value={tuning.arc} min={0} max={0.5} step={0.02} onChange={arc => tune({ arc })} />
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={tuning.isMotionReduced} onChange={e => tune({ isMotionReduced: e.target.checked })} />
        Reduced motion
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={isShown} onChange={e => setShown(e.target.checked)} />
        Show cursors
      </label>
    </div>
  );
}

function Roster() {
  return (
    <section className="flex flex-wrap gap-2">
      {AGENTS.map(a => (
        <span key={a.agent} data-agent={`agent:${a.agent}`} className="flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs">
          <AgentFace id={a.agent} small still className="size-5" />
          {a.name}
        </span>
      ))}
    </section>
  );
}

function Threads({ stage }: { stage: Stage }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-1 text-xs font-medium text-muted-foreground">Threads</h2>
      {stage.threads.map(t => (
        <div key={t.id} data-agent={`inbox-row:${t.id}`}>
          <MessageRow from={t.from} at={AT} text={t.merged > 0 ? `${t.text} (+${t.merged} merged in)` : t.text} />
        </div>
      ))}
      <h2 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">Todo</h2>
      <Card data-agent="todo:dev-td1" className="gap-2 px-4 py-3 text-sm">
        Tune the cursor feel
        <div className="flex flex-wrap gap-1">
          {stage.todo.map(t => (
            <span key={t} className="max-w-56 truncate rounded-full border px-2 py-0.5 text-xs">
              {t}
            </span>
          ))}
        </div>
      </Card>
    </section>
  );
}

function Board({ stage }: { stage: Stage }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-xs font-medium text-muted-foreground">Objectives</h2>
      {stage.objectives.map(o => (
        <Card key={o.id} className="gap-1.5 px-4 py-3 text-sm">
          <span data-agent={`objective:${o.id}`} className="w-fit">
            {o.title}
          </span>
          {o.threads.map(t => (
            <span key={t} className="w-fit max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-xs">
              {t}
            </span>
          ))}
        </Card>
      ))}
      <h2 className="text-xs font-medium text-muted-foreground">Tasks</h2>
      <ol data-agent="tasks:dev-o1" className="rounded-md border">
        {stage.tasks.map(t => (
          <li key={t.id} data-agent={`row:${t.id}`} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0">
            <span className={cn("size-2 shrink-0 rounded-full", t.isDone ? "bg-green-500" : "bg-muted-foreground/40")} />
            <span className={cn(t.isDone && "text-muted-foreground")}>{t.title}</span>
          </li>
        ))}
      </ol>
      <h2 className="text-xs font-medium text-muted-foreground">Archive (scroll: some are off screen, and change with no cursor)</h2>
      <ol className="h-24 overflow-y-auto rounded-md border">
        {stage.archive.map(t => (
          <li key={t.id} data-agent={`row:${t.id}`} className="border-b px-3 py-1.5 text-sm last:border-b-0">
            {t.title}
          </li>
        ))}
      </ol>
      <h2 className="text-xs font-medium text-muted-foreground">Page cards</h2>
      <div data-agent="dev-page" className="grid grid-cols-2 gap-2">
        {stage.cards.map(c => (
          <Card key={c.id} data-agent={`block:${c.id}`} className="px-3 py-2 text-sm">
            {c.text}
          </Card>
        ))}
      </div>
    </section>
  );
}

function Logs() {
  const missed = missedStore.use();
  const recent = recentStore.use();
  return (
    <div className="grid gap-4 border-t p-5 md:grid-cols-2">
      <section data-agent="cursors-missed">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Actions with no UI ({missed.length})</h2>
        {missed.length === 0 && <p className="text-xs text-muted-foreground">None yet. A gesture whose places are nowhere on the page lands here.</p>}
        {missed.map(m => (
          <p key={m.action} className="flex gap-2 text-xs">
            <span className="w-8 text-right tabular-nums text-muted-foreground">{m.count}×</span>
            <span className="font-mono">{m.gesture} · {m.action}</span>
            <span className="truncate text-muted-foreground">{m.to.join(", ") || "no target"} · last by {m.name}</span>
          </p>
        ))}
      </section>
      <section>
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Recent cursor events</h2>
        {recent.map(e => (
          <p key={`${e.agent}-${e.at}`} className="flex gap-2 text-xs">
            <span style={{ color: colorOf(e.agent) }} className="w-28 truncate font-medium">{e.name}</span>
            <span className="font-mono">{e.gesture} · {e.action}</span>
            <span className="truncate text-muted-foreground">{[...(e.from ?? []), ...e.to].join(" → ")}</span>
          </p>
        ))}
      </section>
    </div>
  );
}

export function CursorPlayground() {
  const [isPlaying, setPlaying] = useState(false);
  const [n, setN] = useState(0);
  const [stage, setStage] = useState(FIRST);
  const fire = () => {
    const step = SCRIPT[n % SCRIPT.length];
    const who = AGENTS[n % AGENTS.length];
    if (n > 0 && n % SCRIPT.length === 0) setStage(FIRST);
    setN(n + 1);
    if (!step || !who) return;
    const { change, ...aim } = step;
    const key = `dev:${n}`;
    if (!shownStore.get()) {
      setStage(change);
      return;
    }
    const stop = onLand(key, () => {
      stop();
      setStage(change);
    });
    fireCursor({ ...who, ...aim, holds: [key], at: Date.now() });
  };
  useInterval(() => isPlaying && fire(), 2200);
  const reset = () => {
    setStage(FIRST);
    setN(0);
  };
  return (
    <div data-agent="cursors-playground" className="flex h-full flex-col overflow-y-auto">
      <header className="flex flex-col gap-2 px-5 pt-4 pb-3">
        <h1 className="text-lg font-semibold">Agent cursors</h1>
        <p className="text-sm text-muted-foreground">Fake agents drag, edit, create and delete real components. Each change waits for its cursor and happens under it; a place that is off screen just changes.</p>
        <Roster />
      </header>
      <Controls isPlaying={isPlaying} onPlay={() => setPlaying(!isPlaying)} onFire={fire} onReset={reset} />
      <div className="grid gap-4 p-5 md:grid-cols-2">
        <Threads stage={stage} />
        <Board stage={stage} />
      </div>
      <Logs />
    </div>
  );
}
