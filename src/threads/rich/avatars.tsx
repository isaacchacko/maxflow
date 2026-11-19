import { Network, Radar, Waypoints } from "lucide-react";
import { useState } from "react";
import { AgentFace, expressionOf } from "@/components/AgentFace";
import { AgentLink } from "@/components/AgentLink";
import { GitHubGlyph, SlackGlyph } from "@/lib/slack";
import { cn, hasText } from "@/lib/utils";
import type { External } from "@/mock";
import { agentStore, nameStore, objectiveStore, sentryStore } from "@/store";

const GITHUB_LOGIN = "isaacchacko";

function IsaacPicture({ tile, isSmall }: { tile: string; isSmall: boolean }) {
  const [isBroken, setBroken] = useState(false);
  if (isBroken) return <span className={cn(tile, "bg-tile-1 text-tile-ink")}>IC</span>;
  return <img src={`https://avatars.githubusercontent.com/${GITHUB_LOGIN}?s=72`} alt="" onError={() => setBroken(true)} className={cn("shrink-0 object-cover", isSmall ? "size-5 rounded-full" : "size-9 rounded-lg")} />;
}

function AgentPicture({ from, isSmall }: { from: string; isSmall: boolean }) {
  const a = agentStore.use().find(x => x.id === from);
  return (
    <AgentLink id={from} className={cn("relative flex shrink-0", isSmall ? "size-5" : "size-9")}>
      <AgentFace id={from} expression={expressionOf(a?.state)} small={isSmall} still className="size-full" />
      {!isSmall && a?.role === "router" && (
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-card shadow-card">
          <Network className="size-2.5 text-router" />
        </span>
      )}
    </AgentLink>
  );
}

export function Avatar({ from, small }: { from: string; small?: boolean }) {
  const objectives = objectiveStore.use();
  const sentries = sentryStore.use();
  const isSmall = small === true;
  const tile = cn("relative flex shrink-0 items-center justify-center font-semibold", isSmall ? "size-5 rounded-full text-[10px] [&>svg]:size-3" : "size-9 rounded-lg text-sm");
  if (from === "isaac") return <IsaacPicture tile={tile} isSmall={isSmall} />;
  if (objectives.some(o => o.id === from))
    return (
      <span className={cn(tile, "bg-agent/10")}>
        <Waypoints className="size-4 text-agent" />
      </span>
    );
  if (sentries.some(x => x.id === from))
    return (
      <span className={cn(tile, "bg-muted")}>
        <Radar className="size-4 text-muted-foreground" />
      </span>
    );
  return <AgentPicture from={from} isSmall={isSmall} />;
}

export function Author({ from, className }: { from: string; className?: string }) {
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const sentries = sentryStore.use();
  const names = nameStore.use();
  if (from === "isaac") return <span className={cn("text-sm font-semibold", className)}>you</span>;
  const o = objectives.find(x => x.id === from);
  if (o)
    return (
      <a href={`#objective/${o.id}`} title={o.title} className={cn("text-sm font-semibold hover:underline", className)}>
        {o.title}
      </a>
    );
  const name = agents.find(x => x.id === from)?.name ?? sentries.find(x => x.id === from)?.name ?? names[from] ?? from;
  return (
    <a href={`#agent/${from}`} title={name} className={cn("text-sm font-semibold hover:underline", className)}>
      {name}
    </a>
  );
}

function pictureOf(ext: External) {
  if (ext.own === true || !hasText(ext.user)) return;
  if (ext.source === "slack") return `/api/avatar/slack/${ext.user}?name=${encodeURIComponent(ext.name)}`;
  return `https://avatars.githubusercontent.com/${ext.user}?s=72`;
}

function TheirPicture({ ext }: { ext: External }) {
  const [isBroken, setBroken] = useState(false);
  const src = pictureOf(ext);
  if (src !== undefined && !isBroken) return <img src={src} alt="" onError={() => setBroken(true)} className="size-9 rounded-lg object-cover" />;
  const initials = ext.name
    .split(/\s+/)
    .map(w => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return <span className="flex size-9 items-center justify-center rounded-lg bg-tile-2 text-sm font-semibold text-tile-ink">{initials}</span>;
}

export function ExtAvatar({ ext }: { ext: External }) {
  return (
    <span className="relative size-9 shrink-0">
      {ext.own === true ? <Avatar from="isaac" /> : <TheirPicture ext={ext} />}
      <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-card shadow-card">{ext.source === "slack" ? <SlackGlyph className="size-2.5" /> : <GitHubGlyph className="size-2.5" />}</span>
    </span>
  );
}

export function ExtAuthor({ ext, className }: { ext: External; className?: string }) {
  const isOwn = ext.own === true;
  return (
    <a href={ext.link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} title={`${isOwn ? "you" : ext.name} on ${ext.source === "slack" ? "Slack" : "GitHub"}`} className={cn("text-sm font-semibold hover:underline", className)}>
      {isOwn ? "you" : ext.name}
    </a>
  );
}
