import { Check, CircleDashed, GitPullRequest, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { statusColor, type Block, type Task } from "@/mock";
import { addEvent, putBlock } from "@/store";

type Of<K extends Block["kind"]> = Extract<Block, { kind: K }>;
type Props<K extends Block["kind"]> = { block: Of<K>; task: Task };

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

function StatusBlock({ block, task }: Props<"status">) {
  return (
    <Shell
      title="Status"
      action={
        <Badge variant="outline" className="gap-1.5 capitalize">
          <span className={cn("size-1.5 rounded-full", statusColor[task.status])} />
          {task.status}
        </Badge>
      }
    >
      <p className="text-lg leading-snug">{block.summary}</p>
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

const tone = { good: "text-emerald-400", bad: "text-red-400", flat: "text-muted-foreground" };

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

const who = { isaac: "bg-sky-500", agent: "bg-agent", sentry: "bg-amber-500" };

function ActivityBlock({ task }: Props<"activity">) {
  return (
    <Shell title="Activity" className="flex flex-col-reverse overflow-hidden">
      <ol className="space-y-2">
        {task.events.slice(-4).map((e, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", who[e.from])} />
            <span className="flex-1 text-muted-foreground">{e.text}</span>
            <span className="shrink-0 text-xs text-muted-foreground/60">{e.at}</span>
          </li>
        ))}
        {task.events.length === 0 && <li className="text-sm text-muted-foreground">Nothing yet.</li>}
      </ol>
    </Shell>
  );
}

const check = {
  pass: <Check className="size-3.5 text-emerald-400" />,
  fail: <X className="size-3.5 text-red-400" />,
  running: <Loader2 className="size-3.5 animate-spin text-amber-400" />,
};

function PrBlock({ block, task }: Props<"pr">) {
  return (
    <Shell title="Pull request" action={<Badge variant="secondary" className="gap-1"><GitPullRequest className="size-3" />#{task.pr}</Badge>}>
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

function QuestionBlock({ block, task }: Props<"question">) {
  const answer = (option: string) => {
    addEvent(task.id, { from: "isaac", at: "now", text: `Decided: ${option}` });
    putBlock(task.id, { id: block.id, kind: "note", w: block.w, h: block.h, title: "Decision", text: `${option}. ${block.question}` });
  };
  return (
    <Card className="h-full gap-3 overflow-hidden border-amber-400/40 bg-amber-400/5 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-xs font-medium tracking-wide text-amber-400 uppercase">Needs you</CardTitle>
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
};

export function BlockView({ block, task }: { block: Block; task: Task }) {
  const Render = renderers[block.kind] as (p: { block: Block; task: Task }) => React.ReactNode;
  return <Render block={block} task={task} />;
}
