import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { statusColor, type Task } from "@/mock";
import { taskStore } from "@/store";

const W = 260;
const H = 76;

function layout(tasks: Task[]) {
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    const task = tasks.find(t => t.id === id)!;
    const d = task.dependsOn.length ? 1 + Math.max(...task.dependsOn.map(depthOf)) : 0;
    depth.set(id, d);
    return d;
  };
  const rows = new Map<number, number>();
  return new Map(
    tasks.map(t => {
      const col = depthOf(t.id);
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      return [t.id, { x: 40 + col * (W + 80), y: 40 + row * (H + 28) }];
    }),
  );
}

export function GraphView() {
  const tasks = taskStore.use();
  const pos = layout(tasks);
  return (
    <svg className="h-full w-full">
      {tasks.flatMap(t =>
        t.dependsOn.map(dep => {
          const a = pos.get(dep)!;
          const b = pos.get(t.id)!;
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
          return (
            <path
              key={`${dep}-${t.id}`}
              d={`M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`}
              className="fill-none stroke-border"
              strokeWidth={1.5}
            />
          );
        }),
      )}
      {tasks.map(t => {
        const { x, y } = pos.get(t.id)!;
        return (
          <foreignObject key={t.id} x={x} y={y} width={W} height={H}>
            <a href={`#task/${t.id}`} data-agent={`node:${t.id}`}>
              <Card className="h-full justify-center gap-1.5 px-3 py-0 transition-colors hover:border-ring">
                <div className="flex items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", statusColor[t.status])} />
                  <span className="truncate text-sm">{t.title}</span>
                </div>
                <div className="flex gap-1.5 pl-4">
                  {t.agent && <Badge variant="secondary">{t.agent}</Badge>}
                  {t.pr && <Badge variant="outline">#{t.pr}</Badge>}
                </div>
              </Card>
            </a>
          </foreignObject>
        );
      })}
    </svg>
  );
}
