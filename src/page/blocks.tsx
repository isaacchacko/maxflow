import { Check, CircleDashed, GitPullRequest, Loader2, Network, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Waiting } from "@/components/Waiting";
import { cn } from "@/lib/utils";
import { agentStateColor, statusColor, type Block, type Event, type Status } from "@/mock";
import { addEvent, agentStore, putBlock, taskStore, objectiveStore, type PageRef } from "@/store";
import { Rich } from "@/threads/Rich";

export type Subject = { ref: PageRef; status: Status; events: Event[]; pr?: number; objectiveId?: string };

type Of<K extends Block["kind"]> = Extract<Block, { kind: K }>;
type Props<K extends Block["kind"]> = { block: Of<K>; subject: Subject };

function Shell({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className="h-full gap-2 overflow-hidden py-3">
      <CardHeader className="flex items-center justify-between px-4">
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className={cn("min-h-0 flex-1 px-4", className)}>{children}</CardContent>
    </Card>
  );
}

function StatusBlock({ block, subject }: Props<"status">) {
  return (
    <Shell
      title="Status"
      action={
        <Badge variant="outline" className="gap-1.5 capitalize">
          <span className={cn("size-1.5 rounded-full", statusColor[subject.status])} />
          {subject.status}
        </Badge>
      }
    >
      <Rich text={block.summary} className="block text-lg leading-snug" />
    </Shell>
  );
}

function NoteBlock({ block }: Props<"note">) {
  return (
    <Shell title={block.title}>
      <p className="text-sm leading-relaxed text-muted-foreground">{block.text}</p>
    </Shell>
  );
}

function StepsBlock({ block }: Props<"steps">) {
  const done = block.items.filter(i => i.done).length;
  return (
    <Shell title={block.title} action={<span className="text-xs text-muted-foreground">{done}/{block.items.length}</span>}>
      <Progress value={(done / block.items.length) * 100} className="mb-3 h-1" />
      <ul className="space-y-2">
        {block.items.map(item => (
          <li key={item.text} className="flex items-center gap-2 text-sm">
            <Checkbox checked={item.done} />
            <span className={cn(item.done && "text-muted-foreground line-through")}>{item.text}</span>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

const tone = { good: "text-ok", bad: "text-destructive", flat: "text-muted-foreground" };

function StatBlock({ block }: Props<"stat">) {
  return (
    <Shell title={block.label} className="flex flex-col justify-end">
      <div className="text-4xl font-semibold tracking-tight tabular-nums">{block.value}</div>
      {block.delta && <div className={cn("mt-1 text-sm", tone[block.tone ?? "flat"])}>{block.delta}</div>}
    </Shell>
  );
}

function ChartBlock({ block }: Props<"chart">) {
  const max = Math.max(...block.points);
  const min = block.style === "bar" ? 0 : Math.min(...block.points);
  const y = (v: number) => 100 - ((v - min) / (max - min || 1)) * 90 - 5;
  const step = 100 / (block.points.length - 1);
  const line = block.points.map((v, i) => `${i * step},${y(v)}`).join(" ");
  const last = block.points.at(-1)!;
  return (
    <Shell
      title={block.title}
      action={<span className="text-sm tabular-nums">{last}{block.unit && ` ${block.unit}`}</span>}
      className="pb-1"
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full">
        {block.style === "line" ? (
          <>
            <polygon points={`0,100 ${line} 100,100`} className="fill-chart-1/20" />
            <polyline points={line} className="fill-none stroke-chart-1" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        ) : (
          block.points.map((v, i) => {
            const w = 100 / block.points.length;
            return <rect key={i} x={i * w + w * 0.15} width={w * 0.7} y={y(v)} height={100 - y(v)} rx={1} className="fill-chart-1" />;
          })
        )}
      </svg>
    </Shell>
  );
}

const who = { isaac: "bg-link", agent: "bg-agent", router: "bg-router", sentry: "bg-command" };

function ActivityBlock({ subject }: Props<"activity">) {
  return (
    <Shell title="Activity" className="flex flex-col-reverse overflow-hidden">
      <ol className="space-y-2">
        {subject.events.slice(-4).map((e, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", who[e.from])} />
            <Rich text={e.text} className="flex-1 text-muted-foreground" />
            <span className="shrink-0 text-xs text-muted-foreground/60">{e.at}</span>
          </li>
        ))}
        {subject.events.length === 0 && <li className="text-sm text-muted-foreground">None</li>}
      </ol>
    </Shell>
  );
}

const check = {
  pass: <Check className="size-3.5 text-ok" />,
  fail: <X className="size-3.5 text-destructive" />,
  running: <Loader2 className="size-3.5 animate-spin text-command" />,
};

function PrBlock({ block, subject }: Props<"pr">) {
  return (
    <Shell title="Pull request" action={<Badge variant="secondary" className="gap-1"><GitPullRequest className="size-3" />#{subject.pr}</Badge>}>
      <ul className="space-y-1.5">
        {block.checks.map(c => (
          <li key={c.name} className="flex items-center gap-2 font-mono text-xs">
            {check[c.state]}
            {c.name}
          </li>
        ))}
      </ul>
      <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
        <CircleDashed className="size-3.5" />
        {block.review}
      </p>
    </Shell>
  );
}

function TableBlock({ block }: Props<"table">) {
  return (
    <Shell title={block.title}>
      <Table>
        <TableHeader>
          <TableRow>
            {block.columns.map(c => <TableHead key={c} className="h-8">{c}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => <TableCell key={j} className="py-1.5 font-mono text-xs">{cell}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Shell>
  );
}

function CodeBlock({ block }: Props<"code">) {
  return (
    <Shell title={block.title}>
      <pre className="h-full overflow-hidden rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">{block.text}</pre>
    </Shell>
  );
}

function QuestionBlock({ block, subject }: Props<"question">) {
  const answer = (option: string) => {
    addEvent(subject.ref, { from: "isaac", at: "now", text: `Decided: ${option}` });
    putBlock(subject.ref, { id: block.id, kind: "note", w: block.w, h: block.h, title: "Decision", text: `${option}. ${block.question}` });
  };
  return (
    <Card className="h-full gap-3 overflow-hidden border-warn/40 bg-warn/5 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-xs font-medium tracking-wide text-warn uppercase">Needs you</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3 px-4">
        <p className="text-sm leading-snug">{block.question}</p>
        <div className="flex flex-wrap gap-2">
          {block.options.map((o, i) => (
            <Button key={o} size="sm" variant={i === 0 ? "default" : "outline"} onClick={() => answer(o)}>
              {o}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}


function VisionBlock({ block }: Props<"vision">) {
  return (
    <Shell title="Vision" className="flex gap-6">
      <p className="flex-1 text-xl leading-snug font-medium tracking-tight">{block.goal}</p>
      <div className="w-72 shrink-0">
        <p className="mb-2 text-xs text-muted-foreground">Done when</p>
        <ol className="space-y-1.5">
          {block.doneWhen.map((d, i) => (
            <li key={d} className="flex gap-2 text-sm">
              <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
              {d}
            </li>
          ))}
        </ol>
      </div>
    </Shell>
  );
}

function TasksBlock({ subject }: Props<"tasks">) {
  const objective = objectiveStore.use().find(t => t.id === subject.objectiveId);
  const all = taskStore.use();
  const items = (objective?.taskIds ?? []).map(id => all.find(t => t.id === id)!).filter(Boolean);
  const done = items.filter(t => t.status === "done").length;
  return (
    <Shell title="Tasks" action={<span className="text-xs text-muted-foreground">{done}/{items.length} done</span>} className="flex flex-col">
      <Progress value={(done / (items.length || 1)) * 100} className="mb-3 h-1" />
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {items.map(t => (
          <li key={t.id}>
            <a href={`#task/${t.id}`} data-agent={`row:${t.id}`} className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted">
              <span className={cn("size-2 shrink-0 rounded-full", statusColor[t.status])} />
              <span className={cn("flex-1 truncate", t.status === "done" && "text-muted-foreground")}>{t.title}</span>
              {t.agent && <Badge variant="secondary">{t.agent}</Badge>}
            </a>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

export function AgentRow({ id, indent }: { id: string; indent?: boolean }) {
  const agent = agentStore.use().find(a => a.id === id)!;
  return (
    <a href={`#agent/${id}`} data-agent={`agent:${id}`} className={cn("flex items-center gap-2 py-1 text-sm hover:bg-muted", indent && "ml-3 border-l pl-4")}>
      {agent.role === "router" ? <Network className="size-3.5 shrink-0 text-router" /> : <span className={cn("ml-1 size-2 shrink-0 rounded-full", agentStateColor[agent.state])} />}
      <span className="shrink-0 truncate text-xs">{agent.name ?? agent.id}</span>
      {agent.wait && agent.wait.kind !== "done" ? <Waiting wait={agent.wait} className="truncate text-muted-foreground" /> : <Rich still text={agent.doing} className="truncate text-muted-foreground" />}
    </a>
  );
}

function AgentsBlock({ subject }: Props<"agents">) {
  const all = agentStore.use().filter(a => a.objectiveId === subject.objectiveId);
  const count = (role: "router" | "worker") => {
    const n = all.filter(a => a.role === role).length;
    return `${n} ${role}${n === 1 ? "" : "s"}`;
  };
  return (
    <Shell title="Agents" action={<span className="text-xs text-muted-foreground">{count("router")} · {count("worker")}</span>}>
      {all.filter(a => a.role === "router").map(r => (
        <div key={r.id}>
          <AgentRow id={r.id} />
          {all.filter(w => w.parent === r.id).map(w => <AgentRow key={w.id} id={w.id} indent />)}
        </div>
      ))}
    </Shell>
  );
}

const renderers: { [K in Block["kind"]]: (p: Props<K>) => React.ReactNode } = {
  status: StatusBlock,
  note: NoteBlock,
  steps: StepsBlock,
  stat: StatBlock,
  chart: ChartBlock,
  activity: ActivityBlock,
  pr: PrBlock,
  table: TableBlock,
  code: CodeBlock,
  question: QuestionBlock,
  vision: VisionBlock,
  tasks: TasksBlock,
  agents: AgentsBlock,
};

export function BlockView({ block, subject }: { block: Block; subject: Subject }) {
  const Render = renderers[block.kind] as (p: { block: Block; subject: Subject }) => React.ReactNode;
  return <Render block={block} subject={subject} />;
}
