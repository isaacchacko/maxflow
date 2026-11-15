import { statusColor, tasks } from "../mock";

const W = 260;
const H = 64;

function layout() {
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
      return [t.id, { x: 40 + col * (W + 80), y: 40 + row * (H + 32) }];
    }),
  );
}

export function GraphView() {
  const pos = layout();
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
              className="fill-none stroke-neutral-600"
              strokeWidth={1.5}
            />
          );
        }),
      )}
      {tasks.map(t => {
        const { x, y } = pos.get(t.id)!;
        return (
          <foreignObject key={t.id} x={x} y={y} width={W} height={H}>
            <div className="flex h-full flex-col justify-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 hover:border-neutral-600">
              <div className="flex items-center gap-2">
                <span className={`size-2 shrink-0 rounded-full ${statusColor[t.status]}`} />
                <span className="truncate text-sm">{t.title}</span>
              </div>
              <div className="flex gap-3 pl-4 text-xs text-neutral-500">
                {t.agent && <span>{t.agent}</span>}
                {t.pr && <span>#{t.pr}</span>}
              </div>
            </div>
          </foreignObject>
        );
      })}
    </svg>
  );
}
