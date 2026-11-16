import { ArrowRight, GitPullRequest, Hash } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { sentries } from "@/mock";

const icon = { gh: GitPullRequest, slack: Hash };

function Routes({ to }: { to: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {to.map(id => (
        <Badge key={id} variant="secondary" className="font-mono text-[10px]">{id}</Badge>
      ))}
    </span>
  );
}

export function SentriesView() {
  return (
    <div className="grid h-full grid-cols-2 gap-4 overflow-hidden p-4">
      {sentries.map(sentry => {
        const Icon = icon[sentry.id];
        return (
          <Card key={sentry.id} data-agent={`sentry:${sentry.id}`} className="min-h-0 gap-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Icon className="size-4" />
                {sentry.label}
              </CardTitle>
              <CardDescription>every {sentry.every} · last poll {sentry.lastPoll}</CardDescription>
              <CardAction>
                <Badge variant="outline" className="gap-1.5">
                  <span className={cn("size-1.5 rounded-full", sentry.state === "polling" ? "animate-pulse bg-emerald-400" : "bg-amber-400")} />
                  {sentry.state}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
              <div>
                <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Watching</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Target</TableHead>
                      <TableHead>For</TableHead>
                      <TableHead>Routes to</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sentry.watching.map(w => (
                      <TableRow key={w.target}>
                        <TableCell className="font-mono text-xs">{w.target}</TableCell>
                        <TableCell className="text-muted-foreground">{w.what}</TableCell>
                        <TableCell><Routes to={w.routedTo} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Separator />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Recent</p>
                <ol className="space-y-2.5">
                  {sentry.events.map((e, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm">
                      <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">{e.at}</span>
                      <span className="flex-1">{e.text}</span>
                      {e.routedTo.length > 0 ? (
                        <span className="flex shrink-0 items-center gap-1.5">
                          <ArrowRight className="size-3 text-muted-foreground" />
                          <Routes to={e.routedTo} />
                        </span>
                      ) : (
                        <span className="text-xs text-amber-400">not routed</span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
