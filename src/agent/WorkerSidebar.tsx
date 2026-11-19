import { FolderGit2, GitBranch, GitPullRequest, Hash, Link2, Network, Waypoints } from "lucide-react";
import { Waiting } from "@/components/Waiting";
import { Separator } from "@/components/ui/separator";
import { cn, hasText } from "@/lib/utils";
import { agentStateColor, statusColor, type Agent, type Objective, type Signal, type Task } from "@/mock";
import { Rich } from "@/threads/Rich";
import { LinkRow, Row, Section, sourceIcon, when } from "./sidebar-parts";

type Known = { agent: Agent; parent: Agent | undefined; objective: Objective | undefined; task: Task | undefined };

function WorkerProperties({ agent, parent, objective, task }: Known) {
  return (
    <Section title="Properties">
      <Row label="State">
        <span className={cn("size-2 rounded-full", agentStateColor[agent.state])} />
        {agent.state}
      </Row>
      <Row label="Role">worker</Row>
      {objective && (
        <Row label="Objective">
          <a href={`#objective/${objective.id}`} className="flex min-w-0 items-center gap-1.5 hover:underline">
            <Waypoints className="size-3.5 shrink-0 text-agent" />
            <span className="truncate">{objective.title}</span>
          </a>
        </Row>
      )}
      {parent && (
        <Row label="Router">
          <a href={`#agent/${parent.id}`} className="flex min-w-0 items-center gap-1.5 hover:underline">
            <Network className="size-3.5 shrink-0 text-router" />
            <span className="truncate font-mono text-xs">{parent.id}</span>
          </a>
        </Row>
      )}
      {hasText(agent.scope) && <Row label="Scope">{agent.scope}</Row>}
      {task && (
        <Row label="Task">
          <a href={`#task/${task.id}`} className="flex min-w-0 items-center gap-1.5 hover:underline">
            <span className={cn("size-2 shrink-0 rounded-full", statusColor[task.status])} />
            <span className="truncate">{task.title}</span>
          </a>
        </Row>
      )}
      {task && <Row label="Started">{new Date(task.start).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Row>}
    </Section>
  );
}

function WorkerLinks({ agent, task, isLive, routedHere }: { agent: Agent; task: Task | undefined; isLive: boolean; routedHere: Signal[] }) {
  return (
    <Section title="Links">
      {isLive ? (
        <>
          {hasText(agent.cwd) && <LinkRow icon={FolderGit2} label={agent.cwd.replace(/^\/(home|Users)\/[^/]+/, "~")} detail="folder" href={`#agent/${agent.id}`} />}
          {agent.links?.map(url => (
            <LinkRow key={url} icon={/\/pull\/\d+$/.test(url) ? GitPullRequest : Link2} label={url.replace(/^https?:\/\/(www\.)?/, "")} href={url} />
          ))}
        </>
      ) : (
        <>
          {task?.pr !== undefined && <LinkRow icon={GitPullRequest} label={`#${task.pr}`} detail={task.title} href="#" />}
          <LinkRow icon={GitBranch} label={`isaac/${agent.id}`} detail="branch" href="#" />
          <LinkRow icon={FolderGit2} label={`~/Worktrees/${agent.id}`} detail="worktree" href="#" />
        </>
      )}
      {!isLive &&
        routedHere
          .filter(s => s.source === "slack")
          .slice(0, 2)
          .map(s => <LinkRow key={s.id} icon={Hash} label={s.target} detail="Slack thread" href="#" />)}
    </Section>
  );
}

function RoutedHere({ routedHere }: { routedHere: Signal[] }) {
  return (
    <Section title={`Routed here · ${routedHere.length}`}>
      {routedHere.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
      {routedHere.slice(0, 8).map(s => {
        const Icon = sourceIcon[s.source];
        return (
          <div key={s.id} className="flex items-start gap-2 text-sm">
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <Rich text={s.text} className="min-w-0 flex-1 truncate" />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{when(s.at)}</span>
          </div>
        );
      })}
    </Section>
  );
}

function Alongside({ siblings }: { siblings: Agent[] }) {
  return (
    <Section title="Alongside">
      {siblings.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
      {siblings.map(a => (
        <a key={a.id} href={`#agent/${a.id}`} className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
          <span className={cn("size-2 shrink-0 rounded-full", agentStateColor[a.state])} />
          <span className="shrink-0 font-mono text-xs">{a.name ?? a.id}</span>
          {a.wait && a.wait.kind !== "done" ? <Waiting wait={a.wait} className="truncate text-xs text-muted-foreground" /> : <Rich still text={a.doing} className="truncate text-xs text-muted-foreground" />}
        </a>
      ))}
    </Section>
  );
}

export function WorkerSidebar({ known, isLive, routedHere, siblings }: { known: Known; isLive: boolean; routedHere: Signal[]; siblings: Agent[] }) {
  return (
    <>
      <WorkerProperties {...known} />
      <Separator />
      <WorkerLinks agent={known.agent} task={known.task} isLive={isLive} routedHere={routedHere} />
      <Separator />
      <RoutedHere routedHere={routedHere} />
      <Separator />
      <Alongside siblings={siblings} />
    </>
  );
}
