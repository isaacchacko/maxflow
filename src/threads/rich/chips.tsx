import { GitPullRequest, SquareKanban } from "lucide-react";
import { useContext } from "react";
import { GitHubGlyph, loadSlackNames, SlackGlyph, slackLabel, slackLink, slackNameStore } from "@/lib/slack";
import { cn, hasText } from "@/lib/utils";
import { prStore } from "@/store";
import { openViewer, ShotScope } from "../Viewer";
import { pill } from "./RefChip";
import { LINEAR, REPO } from "./remark";

const PR_COLOR = { open: "text-ok", merged: "text-merged", closed: "text-destructive" } as const;

const stopHere = (e: React.MouseEvent) => e.stopPropagation();

export function PrChip({ repo, n }: { repo: string; n: string }) {
  const pr = prStore.use()[`${repo}#${n}`];
  return (
    <a href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noreferrer" onClick={stopHere} title={pr ? `${repo}#${n} ${pr.title}` : `${repo}#${n}`} className={cn(pill(), "text-[0.92em]")}>
      <GitPullRequest className={cn("size-3 shrink-0", pr ? PR_COLOR[pr.state] : "text-muted-foreground")} />
      <span className="shrink-0 tabular-nums">
        {repo === REPO ? "" : repo}#{n}
      </span>
      {pr && <span className="truncate text-muted-foreground">{pr.title}</span>}
    </a>
  );
}

export function SlackChip({ href, still, name }: { href: string; still?: boolean; name?: string | undefined }) {
  const names = slackNameStore.use();
  loadSlackNames();
  const link = slackLink(href);
  if (!link) return null;
  const isStill = still === true;
  const label = `${names[link.channel] ?? (hasText(name) ? `#${name}` : slackLabel(link.channel, names))}${link.thread ? " · thread" : ""}`;
  const Tag = isStill ? "span" : "a";
  return (
    <Tag href={isStill ? undefined : href} target="_blank" rel="noreferrer" onClick={stopHere} title={`Slack · ${label}`} className={cn(pill(), "text-[0.92em]")}>
      <SlackGlyph />
      <span className="min-w-0 truncate">
        <span className="text-muted-foreground">Slack · </span>
        {label}
      </span>
    </Tag>
  );
}

const GITHUB_THREAD = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/i;

export function GitHubChip({ href }: { href: string }) {
  const m = GITHUB_THREAD.exec(href);
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={stopHere} title={href} className={cn(pill(), "text-[0.92em]")}>
      <GitHubGlyph />
      <span className="min-w-0 truncate">
        <span className="text-muted-foreground">GitHub · </span>
        {m ? `${m[2] ?? ""}#${m[3] ?? ""}` : "link"}
      </span>
    </a>
  );
}

export function LinearChip({ issue }: { issue: string }) {
  return (
    <a href={`${LINEAR}/${issue}`} target="_blank" rel="noreferrer" onClick={stopHere} title={issue} className={cn(pill(), "text-[0.92em]")}>
      <SquareKanban className="size-3 text-link" />
      <span className="min-w-0 truncate">{issue}</span>
    </a>
  );
}

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(",");
  return "";
}

export function SlackUser({ id, children }: { id: string; children: React.ReactNode }) {
  const names = slackNameStore.use();
  loadSlackNames();
  const name = names[id];
  const label = hasText(name) && textOf(children) === `@${id}` ? `@${name}` : children;
  return <span className="rounded bg-link/10 px-0.5 font-medium text-link">{label}</span>;
}

export function Upload({ name, className, children }: { name: string; className: string; children: React.ReactNode }) {
  const shots = useContext(ShotScope);
  const url = `/api/uploads/${name}`;
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (shots === undefined || shots.length === 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    openViewer(shots, url);
  };
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={onClick} className={className}>
      {children}
    </a>
  );
}
