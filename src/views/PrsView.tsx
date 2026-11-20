import { ChevronRight, GitMerge, GitPullRequest } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ago } from "@/threads/Replies";
import { useJson } from "@/views/stats/load";

type Finding = { path: string; line: number; severity: string; body: string };
type Approval = { verdict: string; sha: string; current: boolean | null; tier: number | null; round: number; at: number | null; summary: string; findings: Finding[] };
export type PrRow = {
  pr: string; url: string; title: string; stage: string; since: number; created: number; ended: number | null; moves: { at: string; stage: string }[];
  sessions: { id: string; name: string; live: boolean; wait: string | null }[]; tasks: { id: number; title: string; status: string }[];
  approval: Approval | null; failing: string[]; unresolved: number; ready: boolean; stuck: string | null;
};

export const PRS_URL = "/api/prs";
export const shouldKeepLooking = () => true;
const ENDED_STAGES = new Set(["merged", "closed"]);
const STAGE_TONE: Record<string, string> = {
  merged: "text-ok", approved: "text-ok", merging: "text-ok", "needs reviewer": "text-new", "in review": "text-new",
  "ci failing": "text-destructive", conflict: "text-destructive", "changes requested": "text-destructive", closed: "text-muted-foreground", draft: "text-muted-foreground",
};

const VERDICT_TONE: Record<string, string> = { passed: "text-ok", findings: "text-warn" };
const label = (pr: string) => pr.replace(/^[^/]+\//, "");

function ApprovalChip({ a }: { a: Approval | null }) {
  if (!a) return null;
  const tone = VERDICT_TONE[a.verdict] ?? "text-muted-foreground";
  return (
    <span className={cn("shrink-0 text-xs", tone)} title={`approval sentry ${a.verdict} on ${a.sha.slice(0, 8)}${a.current === false ? " (an older head)" : ""}`}>
      review {a.verdict.split(":", 1)[0]}{a.findings.length > 0 && ` (${a.findings.length})`}{a.current === false && " · old head"}
    </span>
  );
}

function Who({ row }: { row: PrRow }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
      {row.sessions.map(s => (
        <a key={s.id} href={`#agent/${s.id}`} className={cn("truncate hover:underline", !s.live && "opacity-60")} title={s.wait ?? (s.live ? "awake" : "archived")}>
          {s.name}
        </a>
      ))}
      {row.tasks.map(t => (
        <a key={t.id} href={`#task/${t.id}`} className="truncate hover:underline">task {t.id} · {t.status}</a>
      ))}
      {row.sessions.length === 0 && row.tasks.length === 0 && <span>no agent or task</span>}
    </span>
  );
}

function Details({ row }: { row: PrRow }) {
  const a = row.approval;
  return (
    <div className="space-y-3 border-t bg-muted/30 px-9 py-3 text-xs">
      {row.failing.length > 0 && <p className="text-destructive">Failing checks: {row.failing.join(", ")}</p>}
      {row.unresolved > 0 && <p className="text-warn">{row.unresolved} unresolved review thread(s)</p>}
      {a && (
        <div className="space-y-1.5">
          <p className="font-medium">
            Approval sentry: {a.verdict} on {a.sha.slice(0, 8)}{a.tier !== null && `, tier ${a.tier}`}{a.round > 0 && `, round ${a.round}`}{a.at !== null && `, ${ago(a.at)} ago`}
          </p>
          {a.findings.map((f, i) => (
            <p key={i} className="leading-relaxed">
              <span className={cn("font-mono", f.severity === "blocking" ? "text-destructive" : "text-warn")}>{f.severity}</span>{" "}
              <span className="font-mono text-muted-foreground">{f.path}:{f.line}</span> {f.body}
            </p>
          ))}
          {a.findings.length === 0 && <p className="whitespace-pre-wrap text-muted-foreground">{a.summary}</p>}
        </div>
      )}
      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        {row.moves.map(m => (
          <li key={`${m.at}${m.stage}`}>
            <span className="tabular-nums">{new Date(m.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> {m.stage}
          </li>
        ))}
        {row.moves.length === 0 && <li>no stage history yet</li>}
      </ol>
    </div>
  );
}

async function merge(pr: string) {
  const res = await fetch("/api/prs/merge", { method: "POST", body: JSON.stringify({ pr }) });
  return res.ok ? "merged" : `merge failed: ${await res.text()}`;
}

function MergeButton({ pr }: { pr: string }) {
  const [state, setState] = useState<string>();
  const click = () => {
    setState("merging…");
    void merge(pr).then(setState);
  };
  if (state !== undefined) return <span className="max-w-60 shrink-0 truncate text-xs text-muted-foreground" title={state}>{state}</span>;
  return (
    <Button size="xs" onClick={click} data-agent={`prs:merge:${pr}`}>
      <GitMerge />
      Merge
    </Button>
  );
}

function Row({ row }: { row: PrRow }) {
  const [isOpen, setOpen] = useState(false);
  const when = row.ended ?? row.since;
  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50">
        <button type="button" onClick={() => setOpen(!isOpen)} aria-label="Details" className="shrink-0 text-muted-foreground">
          <ChevronRight className={cn("size-4 transition-transform", isOpen && "rotate-90")} />
        </button>
        <a href={row.url} target="_blank" rel="noreferrer" className="w-28 shrink-0 font-mono text-xs hover:underline">{label(row.pr)}</a>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" title={row.title}>{row.title}</p>
          <Who row={row} />
          {row.stuck !== null && <p className="text-xs text-warn">stuck: {row.stuck}</p>}
        </div>
        <ApprovalChip a={row.approval} />
        <span className={cn("w-32 shrink-0 text-right text-xs", STAGE_TONE[row.stage] ?? "text-muted-foreground")}>{row.stage}</span>
        <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums" title={Number.isNaN(when) ? "" : new Date(when).toLocaleString()}>
          {Number.isNaN(when) ? "" : ago(when)}
        </span>
        {row.ready && <MergeButton pr={row.pr} />}
      </div>
      {isOpen && <Details row={row} />}
    </li>
  );
}

function Section({ title, rows, hint }: { title: string; rows: PrRow[]; hint?: string }) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h2 className="flex items-baseline gap-2 text-sm font-medium">
        {title} <Badge variant="secondary">{rows.length}</Badge>
        {hint !== undefined && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
      </h2>
      <ol className="flex flex-col border">
        {rows.map(r => <Row key={r.pr} row={r} />)}
      </ol>
    </section>
  );
}

export function PrsView() {
  const { value, error } = useJson<PrRow[]>(PRS_URL, shouldKeepLooking);
  const rows = value ?? [];
  const open = rows.filter(r => !ENDED_STAGES.has(r.stage));
  const ready = open.filter(r => r.ready);
  const stuck = open.filter(r => !r.ready && r.stuck !== null);
  const moving = open.filter(r => !r.ready && r.stuck === null);
  const ended = rows.filter(r => ENDED_STAGES.has(r.stage)).toSorted((a, b) => (b.ended ?? 0) - (a.ended ?? 0));
  return (
    <div className="h-full space-y-5 overflow-y-auto p-3" data-agent="prs">
      <header className="flex items-center gap-2 text-sm text-muted-foreground">
        <GitPullRequest className="size-4" />
        {open.length} open, {ended.length} merged or closed in the last 14 days
        {error !== undefined && <span className="text-destructive">· {error}</span>}
      </header>
      <Section title="Ready for you to merge" rows={ready} hint="green, approved where the repo needs it, no open threads" />
      <Section title="Stuck" rows={stuck} />
      <Section title="Moving" rows={moving} />
      <Section title="Merged and closed" rows={ended} />
    </div>
  );
}
