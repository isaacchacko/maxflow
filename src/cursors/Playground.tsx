import { useState } from "react";
import { Pause, Play, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useInterval } from "@/lib/effects";
import { MessageRow } from "@/threads/MessageRow";
import { colorOf } from "./Cursors";
import { fireCursor, missedStore, recentStore, setShown, shownStore, tuningStore, type Tuning } from "./store";

const AGENTS = [
  { agent: "7c1e9a42", name: "inbox fixer" },
  { agent: "3fb08d17", name: "board tidier" },
  { agent: "e95a2c60", name: "docs writer" },
];
const THREADS = [
  { id: "dev-th-1", from: "isaac", text: "can you make the cursors glide a bit slower?" },
  { id: "dev-th-2", from: "7c1e9a42", text: "Shipped the inbox fix, CI is green." },
  { id: "dev-th-3", from: "isaac", text: "why is the board stuck on Review?" },
  { id: "dev-th-4", from: "3fb08d17", text: "Moved three tasks to Done and one back to Doing." },
];
const OBJECTIVES = ["yarn polish", "maxflow development", "cleopatra handoff"];
const TASKS = Array.from({ length: 24 }, (_, i) => `Task ${i + 1}`);
const SCRIPT: { action: string; targets: string[] }[] = [
  { action: "post", targets: ["inbox-row:dev-th-1"] },
  { action: "move task to done", targets: ["row:dev-t3"] },
  { action: "rename objective", targets: ["objective:dev-o2"] },
  { action: "post", targets: ["inbox-row:dev-th-3"] },
  { action: "move task to review", targets: ["row:dev-t21"] },
  { action: "open", targets: ["sidebar:docs"] },
  { action: "status", targets: ["inbox-row:dev-th-2"] },
  { action: "notify", targets: [] },
  { action: "move thread", targets: ["objective:dev-o3"] },
  { action: "edit task", targets: ["row:dev-t7"] },
  { action: "open", targets: ["sidebar:inbox"] },
  { action: "post", targets: ["inbox-row:dev-th-4"] },
];
const AT = new Date().toISOString();

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} className="w-24" />
      <span className="w-8 tabular-nums text-foreground">{value}</span>
    </label>
  );
}

function Controls({ isPlaying, onPlay, onFire }: { isPlaying: boolean; onPlay: () => void; onFire: () => void }) {
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
      <Slider label="Speed" value={tuning.speed} min={0.25} max={3} step={0.25} onChange={speed => tune({ speed })} />
      <Slider label="Arc" value={tuning.arc} min={0} max={0.5} step={0.02} onChange={arc => tune({ arc })} />
      <Slider label="Idle s" value={tuning.idleSeconds} min={1} max={15} step={1} onChange={idleSeconds => tune({ idleSeconds })} />
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

function Stage() {
  return (
    <div className="grid gap-4 p-5 md:grid-cols-2">
      <section className="min-w-0">
        <h2 className="mb-1 text-xs font-medium text-muted-foreground">Threads</h2>
        {THREADS.map(t => (
          <div key={t.id} data-agent={`inbox-row:${t.id}`}>
            <MessageRow from={t.from} at={AT} text={t.text} />
          </div>
        ))}
      </section>
      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-xs font-medium text-muted-foreground">Objectives</h2>
        {OBJECTIVES.map((title, i) => (
          <Card key={title} data-agent={`objective:dev-o${i + 1}`} className="px-4 py-3 text-sm">
            {title}
          </Card>
        ))}
        <h2 className="text-xs font-medium text-muted-foreground">Tasks (scroll: some are off screen)</h2>
        <ol className="h-40 overflow-y-auto rounded-md border">
          {TASKS.map((title, i) => (
            <li key={title} data-agent={`row:dev-t${i + 1}`} className="border-b px-3 py-1.5 text-sm last:border-b-0">
              {title}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Logs() {
  const missed = missedStore.use();
  const recent = recentStore.use();
  return (
    <div className="grid gap-4 border-t p-5 md:grid-cols-2">
      <section data-agent="cursors-missed">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Actions with no UI ({missed.length})</h2>
        {missed.length === 0 && <p className="text-xs text-muted-foreground">None yet. An agent action whose target is nowhere on the page lands here.</p>}
        {missed.map(m => (
          <p key={m.action} className="flex gap-2 text-xs">
            <span className="w-8 text-right tabular-nums text-muted-foreground">{m.count}×</span>
            <span className="font-mono">{m.action}</span>
            <span className="truncate text-muted-foreground">{m.targets.join(", ") || "no target"} · last by {m.name}</span>
          </p>
        ))}
      </section>
      <section>
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Recent cursor events</h2>
        {recent.map(e => (
          <p key={`${e.agent}-${e.at}`} className="flex gap-2 text-xs">
            <span style={{ color: colorOf(e.agent) }} className="w-28 truncate font-medium">{e.name}</span>
            <span className="font-mono">{e.action}</span>
            <span className="truncate text-muted-foreground">{e.targets.join(", ")}</span>
          </p>
        ))}
      </section>
    </div>
  );
}

export function CursorPlayground() {
  const [isPlaying, setPlaying] = useState(false);
  const [n, setN] = useState(0);
  const fire = () => {
    const step = SCRIPT[n % SCRIPT.length];
    const who = AGENTS[(n * 7 + Math.floor(n / SCRIPT.length)) % AGENTS.length];
    if (step && who) fireCursor({ ...who, ...step, at: Date.now() });
    setN(n + 1);
  };
  useInterval(() => isPlaying && fire(), 1100);
  return (
    <div data-agent="cursors-playground" className="flex h-full flex-col overflow-y-auto">
      <header className="px-5 pt-4">
        <h1 className="text-lg font-semibold">Agent cursors</h1>
        <p className="text-sm text-muted-foreground">Fake agents fire scripted actions at real components. Tune the feel here before it goes on the live views.</p>
      </header>
      <Controls isPlaying={isPlaying} onPlay={() => setPlaying(!isPlaying)} onFire={fire} />
      <Stage />
      <Logs />
    </div>
  );
}
