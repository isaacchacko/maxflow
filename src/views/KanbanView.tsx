import { GitPullRequest } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { columns, statusColor } from "@/mock";
import { taskStore } from "@/store";

export function KanbanView() {
  const tasks = taskStore.use();
  return (
    <div className="grid h-full grid-cols-4 gap-3 overflow-x-auto p-4">
      {columns.map(col => {
        const cards = tasks.filter(t => t.status === col.status);
        return (
          <section key={col.status} data-agent={`column:${col.status}`} className="flex min-w-56 flex-col gap-2 rounded-xl bg-muted/30 p-2">
            <h2 className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
              <span className={cn("size-2 rounded-full", statusColor[col.status])} />
              {col.label}
              <span className="text-muted-foreground/60">{cards.length}</span>
            </h2>
            {cards.map(t => (
              <a key={t.id} href={`#task/${t.id}`} data-agent={`card:${t.id}`}>
                <Card className="gap-0 py-3 transition-colors hover:border-ring">
                  <CardContent className="px-3">
                    <p className="text-sm">{t.title}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {t.agent && <Badge variant="secondary">{t.agent}</Badge>}
                      {t.pr && (
                        <Badge variant="outline" className="gap-1">
                          <GitPullRequest className="size-3" />#{t.pr}
                        </Badge>
                      )}
                      {t.page.some(b => b.kind === "question") && (
                        <Badge className="bg-amber-400/15 text-amber-400">needs you</Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </section>
        );
      })}
    </div>
  );
}
