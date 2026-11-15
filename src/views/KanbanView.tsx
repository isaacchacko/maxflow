import { columns, statusColor, tasks } from "../mock";

export function KanbanView() {
  return (
    <div className="grid h-full grid-cols-4 gap-3 overflow-x-auto p-4">
      {columns.map(col => {
        const cards = tasks.filter(t => t.status === col.status);
        return (
          <section key={col.status} className="flex min-w-56 flex-col gap-2">
            <h2 className="flex items-center gap-2 px-1 text-sm text-neutral-400">
              <span className={`size-2 rounded-full ${statusColor[col.status]}`} />
              {col.label}
              <span className="text-neutral-600">{cards.length}</span>
            </h2>
            {cards.map(t => (
              <article
                key={t.id}
                className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 hover:border-neutral-600"
              >
                <p className="text-sm">{t.title}</p>
                <div className="mt-2 flex gap-3 text-xs text-neutral-500">
                  {t.agent && <span>{t.agent}</span>}
                  {t.pr && <span>#{t.pr}</span>}
                  {t.messages.length > 0 && <span>{t.messages.length} msgs</span>}
                </div>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
