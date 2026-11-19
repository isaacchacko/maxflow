import { GitCommitHorizontal, GitPullRequest, MessagesSquare, Search, SquareTerminal } from "lucide-react";
import { SlackGlyph, slackLabel, slackNameStore, loadSlackNames } from "@/lib/slack";
import { useNow } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { agentStateColor, type Agent, type Shell, type Wait } from "@/mock";
import { agentStore, nameStore, prStore, shellStore, threadStore } from "@/store";
import { pill } from "@/threads/Rich";

function Chip({ href, title, icon, children, muted }: { href?: string | undefined; title: string; icon: React.ReactNode; children: React.ReactNode; muted?: boolean }) {
  const hasTarget = hasText(href);
  const open = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hasText(href)) return;
    if (href.startsWith("#")) location.hash = href.slice(1);
    else window.open(href, "_blank", "noreferrer");
  };
  return (
    <span
      role={hasTarget ? "link" : undefined}
      tabIndex={hasTarget ? 0 : undefined}
      title={title}
      onClick={open}
      onKeyDown={e => e.key === "Enter" && open(e)}
      className={cn(pill(), "max-w-[min(100%,52ch)] cursor-pointer text-[0.92em] font-medium text-foreground", muted === true && "border-dashed border-border bg-transparent text-muted-foreground line-through", !hasTarget && "cursor-default")}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function agoText(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

function shellTone(x?: Shell) {
  if (!x?.end) return "text-agent animate-pulse";
  if (x.end.code === 0) return "text-ok";
  return x.end.code === null ? "text-muted-foreground" : "text-destructive";
}

function shellWhat(shell: Shell | undefined) {
  if (!shell) return "shell gone";
  if (shell.kind === "pid") return `process ${shell.pid}`;
  return shell.kind === "pane" ? "session" : `$ ${shell.cmd}`;
}

function shellState(shell: Shell | undefined, now: number) {
  if (!shell) return "";
  if (!shell.end) return `running ${agoText(now - shell.at)}`;
  return shell.end.code === null ? "ended" : `exited ${shell.end.code}`;
}

function ShellChip({ wait, shell }: { wait: Wait; shell?: Shell | undefined }) {
  const now = useNow(() => 60_000);
  const what = shellWhat(shell);
  const state = shellState(shell, now);
  return (
    <Chip href={shell && shell.kind !== "pid" ? `#agent/${shell.id}` : undefined} title={`${wait.desc}\n${what}\n${state}`} icon={<SquareTerminal className={cn("size-3", shellTone(shell))} />}>
      {wait.desc ?? shell?.desc ?? wait.ref}
    </Chip>
  );
}

function AgentChip({ id, agents, names }: { id: string; agents: Agent[]; names: Record<string, string> }) {
  const a = agents.find(x => x.id === id);
  return (
    <Chip href={`#agent/${id}`} title={a ? `${a.name ?? a.id} · ${a.state}` : `${names[id] ?? id} has ended`} icon={<span className={cn("size-1.5 rounded-full", a ? agentStateColor[a.state] : "bg-muted-foreground")} />} muted={!a}>
      {a?.name ?? names[id] ?? id}
    </Chip>
  );
}

function PrChip({ pr }: { pr: string }) {
  const [repo, n] = pr.split("#", 2);
  const known = prStore.use()[pr.toLowerCase()];
  return (
    <Chip href={`https://github.com/${repo}/pull/${n}`} title={known ? `${pr} ${known.title}` : pr} icon={<GitPullRequest className="size-3 text-ok" />}>
      {repo === "dryft-ai/app" ? "" : repo}#{n}
      {known && <span className="text-muted-foreground"> {known.title}</span>}
    </Chip>
  );
}

function CommitChip({ commit }: { commit: string }) {
  const [repo = "", sha = ""] = commit.split("@", 2);
  return (
    <Chip href={`https://github.com/${repo}/commit/${sha}`} title={commit} icon={<GitCommitHorizontal className="size-3 text-ok" />}>
      {repo === "dryft-ai/app" ? "" : `${repo}@`}
      {sha.slice(0, 7)}
    </Chip>
  );
}

const CiTarget = ({ target }: { target: string }) => (target.includes("@") ? <CommitChip commit={target} /> : <PrChip pr={target} />);

function SlackTarget({ target }: { target: string }) {
  const names = slackNameStore.use();
  loadSlackNames();
  if (target.startsWith("search:"))
    return (
      <Chip title={`Slack search: ${target.slice(7)}`} icon={<Search className="size-3 text-muted-foreground" />}>
        “{target.slice(7)}”
      </Chip>
    );
  const [channel = "", ts] = target.split("/", 2);
  const href = `https://dryftai.slack.com/archives/${channel}${hasText(ts) ? `/p${ts.replace(".", "")}` : ""}`;
  const label = `${slackLabel(channel, names)}${hasText(ts) ? " · thread" : ""}`;
  return (
    <Chip href={href} title={`Slack · ${label}`} icon={<SlackGlyph />}>
      {label}
    </Chip>
  );
}

function UntilShell({ wait }: { wait: Wait }) {
  const shells = shellStore.use();
  return (
    <>
      until <ShellChip wait={wait} shell={shells.find(x => x.id === wait.ref)} />
    </>
  );
}

function UntilAgents({ agentIds }: { agentIds: string }) {
  const agents = agentStore.use();
  const names = nameStore.use();
  return (
    <>
      until{" "}
      {agentIds.split(",").map((id, i) => (
        <span key={id}>
          {i > 0 && " or "}
          <AgentChip id={id} agents={agents} names={names} />
        </span>
      ))}{" "}
      replies or finishes
    </>
  );
}

function UntilThreadAnswer({ threadId }: { threadId: string }) {
  const t = threadStore.use().find(x => x.id === threadId);
  return (
    <>
      until you answer in{" "}
      <Chip href={`#thread/${threadId}`} title={t?.title ?? threadId} icon={<MessagesSquare className="size-3 text-link" />} muted={!t}>
        {t?.title ?? threadId}
      </Chip>
    </>
  );
}

function WaitSentence({ wait }: { wait: Wait }) {
  switch (wait.kind) {
    case "until": {
      return <UntilShell wait={wait} />;
    }
    case "agent": {
      return <UntilAgents agentIds={wait.ref} />;
    }
    case "thread": {
      return <UntilThreadAnswer threadId={wait.ref} />;
    }
    case "approval": {
      return <>until <PrChip pr={wait.ref} /> is approved</>;
    }
    case "ci": {
      return <>until CI finishes on <CiTarget target={wait.ref} /></>;
    }
    case "slack": {
      return <>until someone posts in <SlackTarget target={wait.ref} /></>;
    }
    default: {
      return <>on {wait.kind}:{wait.ref}</>;
    }
  }
}

export function Waiting({ wait, className, lead = "Waiting" }: { wait?: Wait | null | undefined; className?: string; lead?: string }) {
  if (!wait || wait.kind === "done") return null;
  return (
    <span className={cn("min-w-0", className)}>
      {lead} <WaitSentence wait={wait} />
    </span>
  );
}

export function waitWords(wait: Wait, agents: Agent[] = []) {
  const name = (id: string) => agents.find(a => a.id === id)?.name ?? id;
  switch (wait.kind) {
    case "until": {
      return `waiting until ${wait.desc ?? wait.ref}`;
    }
    case "agent": {
      return `waiting until ${wait.ref.split(",").map(name).join(" or ")} replies or finishes`;
    }
    case "thread": {
      return "waiting until you answer";
    }
    case "approval": {
      return `waiting until ${wait.ref} is approved`;
    }
    case "ci": {
      return `waiting until CI finishes on ${wait.ref}`;
    }
    case "slack": {
      return "waiting until someone posts in Slack";
    }
    default: {
      return `waiting on ${wait.kind}:${wait.ref}`;
    }
  }
}
