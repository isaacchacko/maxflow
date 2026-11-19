import { GitPullRequest, MessagesSquare, Search, SquareTerminal } from "lucide-react";
import { SlackGlyph, slackLabel, slackNameStore, loadSlackNames } from "@/lib/slack";
import { cn } from "@/lib/utils";
import { agentStateColor, type Agent, type Shell, type Wait } from "@/mock";
import { agentStore, nameStore, prStore, shellStore, threadStore } from "@/store";
import { pill } from "@/threads/Rich";

/**
 * A chip that opens what it names. A span, not a link, so it can sit inside the cards and rows that are links themselves: a click
 * on it opens the condition, a click beside it the row's own target.
 */
function Chip({ href, title, icon, children, muted }: { href?: string; title: string; icon: React.ReactNode; children: React.ReactNode; muted?: boolean }) {
  const open = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!href) return;
    if (href.startsWith("#")) location.hash = href.slice(1);
    else window.open(href, "_blank", "noreferrer");
  };
  return (
    <span
      role={href ? "link" : undefined}
      tabIndex={href ? 0 : undefined}
      title={title}
      onClick={open}
      onKeyDown={e => e.key === "Enter" && open(e)}
      className={cn(pill(), "max-w-[min(100%,52ch)] cursor-pointer text-[0.92em] font-medium text-foreground", muted && "border-dashed border-border bg-transparent text-muted-foreground line-through", !href && "cursor-default")}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** A shell's state as its icon's color: still running, exited 0, exited otherwise, or ended with no code to tell. */
function shellTone(x?: Shell) {
  if (!x?.end) return "text-agent animate-pulse";
  return x.end.code === 0 ? "text-ok" : x.end.code === null ? "text-muted-foreground" : "text-destructive";
}

function ShellChip({ wait, shell }: { wait: Wait; shell?: Shell }) {
  const what = !shell ? "shell gone" : shell.kind === "pid" ? `process ${shell.pid}` : shell.kind === "pane" ? "session" : `$ ${shell.cmd}`;
  const state = !shell ? "" : !shell.end ? `running ${ago(Date.now() - shell.at)}` : shell.end.code === null ? "ended" : `exited ${shell.end.code}`;
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
  const [repo, n] = pr.split("#");
  const known = prStore.use()[pr.toLowerCase()];
  return (
    <Chip href={`https://github.com/${repo}/pull/${n}`} title={known ? `${pr} ${known.title}` : pr} icon={<GitPullRequest className="size-3 text-ok" />}>
      {repo === "dryft-ai/app" ? "" : repo}#{n}
      {known && <span className="text-muted-foreground"> {known.title}</span>}
    </Chip>
  );
}

function SlackTarget({ target }: { target: string }) {
  const names = slackNameStore.use();
  loadSlackNames();
  if (target.startsWith("search:"))
    return (
      <Chip title={`Slack search: ${target.slice(7)}`} icon={<Search className="size-3 text-muted-foreground" />}>
        “{target.slice(7)}”
      </Chip>
    );
  const [channel, ts] = target.split("/");
  const href = `https://dryftai.slack.com/archives/${channel}${ts ? `/p${ts.replace(".", "")}` : ""}`;
  const label = `${slackLabel(channel!, names)}${ts ? " · thread" : ""}`;
  return (
    <Chip href={href} title={`Slack · ${label}`} icon={<SlackGlyph />}>
      {label}
    </Chip>
  );
}

/**
 * What an agent sleeps on, as a sentence with the condition drawn as a chip that opens it: "Waiting until ‹the app#12847 prod apply
 * finishes›", "Waiting until ‹PR› is approved", "Waiting until you answer in ‹thread›". Nothing for done or no wait.
 */
export function Waiting({ wait, className, lead = "Waiting" }: { wait?: Wait | null; className?: string; lead?: string }) {
  const agents = agentStore.use();
  const names = nameStore.use();
  const threads = threadStore.use();
  const shells = shellStore.use();
  if (!wait || wait.kind === "done") return null;
  const sentence = (() => {
    switch (wait.kind) {
      case "until":
        return <>until <ShellChip wait={wait} shell={shells.find(x => x.id === wait.ref)} /></>;
      case "agent": {
        const ids = wait.ref.split(",");
        return (
          <>
            until{" "}
            {ids.map((id, i) => (
              <span key={id}>
                {i > 0 && " or "}
                <AgentChip id={id} agents={agents} names={names} />
              </span>
            ))}{" "}
            replies or finishes
          </>
        );
      }
      case "thread": {
        const t = threads.find(x => x.id === wait.ref);
        return (
          <>
            until you answer in{" "}
            <Chip href={`#thread/${wait.ref}`} title={t?.title ?? wait.ref} icon={<MessagesSquare className="size-3 text-link" />} muted={!t}>
              {t?.title ?? wait.ref}
            </Chip>
          </>
        );
      }
      case "approval":
        return <>until <PrChip pr={wait.ref} /> is approved</>;
      case "ci":
        return <>until CI finishes on <PrChip pr={wait.ref} /></>;
      case "slack":
        return <>until someone posts in <SlackTarget target={wait.ref} /></>;
      default:
        return <>on {wait.kind}:{wait.ref}</>;
    }
  })();
  return (
    <span className={cn("min-w-0", className)}>
      {lead} {sentence}
    </span>
  );
}

/** The same sentence as plain words, for a tooltip or a search index. */
export function waitWords(wait: Wait, agents: Agent[] = []) {
  const name = (id: string) => agents.find(a => a.id === id)?.name ?? id;
  switch (wait.kind) {
    case "until":
      return `waiting until ${wait.desc ?? wait.ref}`;
    case "agent":
      return `waiting until ${wait.ref.split(",").map(name).join(" or ")} replies or finishes`;
    case "thread":
      return "waiting until you answer";
    case "approval":
      return `waiting until ${wait.ref} is approved`;
    case "ci":
      return `waiting until CI finishes on ${wait.ref}`;
    case "slack":
      return "waiting until someone posts in Slack";
    default:
      return `waiting on ${wait.kind}:${wait.ref}`;
  }
}
