import { Check, ChevronDown, Circle, ExternalLink, MessagesSquare, Pause, Pin, Waypoints } from "lucide-react";
import { useState } from "react";
import { AgentFace } from "@/components/AgentFace";
import { AgentLink } from "@/components/AgentLink";
import { GitHubGlyph, SlackGlyph } from "@/lib/slack";
import { cn } from "@/lib/utils";
import { statusColor, type Thread } from "@/mock";
import { agentStore, nameStore, objectiveStore, setPinned, taskStore, threadStore } from "@/store";
import { contributorsOf, stateOf, type Contributor } from "./contributors";
import { when } from "./MessageRow";
import { pausedLabel } from "./Pause";
import { ago } from "./Replies";
import { RefChip, refsIn, urlsIn, type Ref } from "./Rich";

// A thread's side panel, as Linear's issue sidebar: a quiet column on the window tint, sections under small muted headers that fold,
// and rows that are an icon and a value (the icon says what it is), filled on hover and clickable where there is somewhere to go.

const KEY = "yarn-panel-folded";
const loadFolded = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};

function Group({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  const [folded, setFolded] = useState(() => !!loadFolded()[title]);
  const toggle = () => {
    setFolded(!folded);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...loadFolded(), [title]: !folded }));
    } catch {}
  };
  return (
    <section id={id} data-agent={`panel:${title.toLowerCase()}`} className="flex flex-col">
      <button onClick={toggle} aria-expanded={!folded} className="group/h flex h-7 items-center gap-1 self-start rounded-md px-2 text-[13px] text-muted-foreground hover:text-foreground">
        {title}
        <ChevronDown className={cn("size-3.5 opacity-0 transition group-hover/h:opacity-100", folded && "-rotate-90 opacity-100")} />
      </button>
      {!folded && <div className="mt-0.5 flex flex-col">{children}</div>}
    </section>
  );
}

const row = "flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2 text-[13px] whitespace-nowrap";
const hover = "hover:bg-black/[0.04]";

function Prop({ icon, children, href, title, onClick, className }: { icon: React.ReactNode; children: React.ReactNode; href?: string; title?: string; onClick?: () => void; className?: string }) {
  const body = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  if (href)
    return (
      <a href={href} title={title} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer" className={cn(row, hover, className)}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button onClick={onClick} title={title} className={cn(row, hover, "text-left", className)}>
        {body}
      </button>
    );
  return (
    <div title={title} className={cn(row, className)}>
      {body}
    </div>
  );
}

const span = (at?: string) => (at && Number.isFinite(Date.parse(at)) ? ago(Date.parse(at)) : "");

/** One agent on the thread: its face doing what it does, its name, and its state with how long. */
function AgentRow({ c, t }: { c: Contributor; t: Thread }) {
  const s = stateOf(c, t);
  const time = span(s.at);
  const word = c.agent ? `${s.word}${time ? ` ${time}` : ""}` : `done${time ? ` ${time} ago` : ""}`;
  const face = <AgentFace id={c.id} expression={s.expression} small still={!c.agent} className="size-5" />;
  const body = (
    <>
      {face}
      <span className={cn("min-w-0 flex-1 truncate", !c.agent && "text-muted-foreground")}>{c.name}</span>
      <span className="max-w-[55%] shrink-0 truncate text-xs text-muted-foreground">{word}</span>
    </>
  );
  const title = [c.name, c.agent?.doing, `${c.why}${c.agent?.role === "router" ? " · router" : ""}`].filter(Boolean).join("\n");
  return c.agent ? (
    <a href={`#agent/${c.id}`} title={title} data-agent={`contributor:${c.id}`} className={cn(row, hover)}>
      {body}
    </a>
  ) : (
    <div title={title} data-agent={`contributor:${c.id}`} className={row}>
      {body}
    </div>
  );
}

export function useContributors(t: Thread | undefined) {
  const threads = threadStore.use();
  const agents = agentStore.use();
  const names = nameStore.use();
  return t ? contributorsOf(t, threads, agents, names) : [];
}

export function ThreadPanel({ thread }: { thread: Thread }) {
  const all = threadStore.use();
  const agents = agentStore.use();
  const names = nameStore.use();
  const objective = objectiveStore.use().find(o => o.id === thread.objectiveId);
  const task = taskStore.use().find(x => x.id === thread.taskId);
  const contributors = useContributors(thread);

  const mentioned = new Map<string, Ref>();
  for (const m of thread.messages) for (const r of refsIn(m.text)) mentioned.set(`${r.kind}:${r.id}`, r);
  const links = new Map(thread.messages.flatMap(m => urlsIn(m.text)).map(l => [l.url, l]));
  // Backlinks: the threads with a message that @-mentions this one.
  const mentionedIn = all.filter(t => t.id !== thread.id && t.messages.some(m => m.text.includes(`[[thread:${thread.id}]]`)));

  return (
    <aside data-agent="thread-panel" className="flex w-1/4 max-w-80 min-w-64 shrink-0 flex-col gap-6 overflow-y-auto border-l bg-window/60 px-3 py-4">
      <Group title="Properties">
        {thread.resolved ? (
          <Prop icon={<Check className="size-4 text-ok" />}>Resolved {when(thread.resolved.at)}</Prop>
        ) : thread.paused ? (
          <Prop icon={<Pause className="size-4" />}>Paused {pausedLabel(thread.paused)}</Prop>
        ) : (
          <Prop icon={<Circle className="size-4" />}>Open</Prop>
        )}
        {objective && (
          <Prop icon={<Waypoints className="size-4 text-agent" />} href={`#objective/${objective.id}`} title={objective.title}>
            {objective.title}
          </Prop>
        )}
        {thread.routerIds.map(rid => {
          const r = agents.find(a => a.id === rid);
          const name = r?.name ?? names[rid] ?? rid;
          return (
            <Prop key={rid} icon={<AgentFace id={rid} expression="idle" small still className="size-4" />} href={r ? `#agent/${rid}` : undefined} title={[name, r?.scope].filter(Boolean).join("\n")}>
              {name}
            </Prop>
          );
        })}
        {task && (
          <Prop icon={<span className={cn("size-2 rounded-full", statusColor[task.status])} />} href={`#task/${task.id}`} title={task.title}>
            {task.title}
          </Prop>
        )}
        {thread.feed && (
          <Prop icon={thread.feed.source === "slack" ? <SlackGlyph className="size-3.5" /> : thread.feed.source === "gh" ? <GitHubGlyph className="size-3.5" /> : <ExternalLink className="size-3.5" />} href={thread.feed.link} title={thread.feed.link}>
            {thread.feed.who}
          </Prop>
        )}
        {thread.pinned && (
          <Prop icon={<Pin className="size-4" />} onClick={() => void setPinned(thread.id, false)} title="Pinned to the sidebar; click to unpin">
            Pinned
          </Prop>
        )}
      </Group>

      {contributors.length > 0 && (
        <Group title="Agents" id={`agents-${thread.id}`}>
          {contributors.map(c => (
            <AgentRow key={c.id} c={c} t={thread} />
          ))}
        </Group>
      )}

      {mentioned.size > 0 && (
        <Group title="Related">
          {[...mentioned.values()].map(r => (
            <RefChip key={`${r.kind}:${r.id}`} r={r} row />
          ))}
        </Group>
      )}

      {mentionedIn.length > 0 && (
        <Group title="Mentioned in">
          <div data-agent="mentioned-in" className="flex flex-col">
            {mentionedIn.map(t => (
              <RefChip key={t.id} r={{ kind: "thread", id: t.id }} row />
            ))}
          </div>
        </Group>
      )}

      {links.size > 0 && (
        <Group title="Links">
          {[...links.values()].map(l => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={`${l.label}\n${l.url}`} className={cn(row, hover, "h-8")}>
              <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{l.label}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new URL(l.url).hostname.replace(/^www\./, "")}</span>
            </a>
          ))}
        </Group>
      )}
    </aside>
  );
}

/**
 * The faces of the agents on a thread, up to four and a count, for a header. `onOpen` makes the stack a button (the page scrolls to
 * its Agents section); without it each face opens its agent (the side pane, which has no panel).
 */
export function AgentStack({ thread, onOpen }: { thread: Thread; onOpen?: () => void }) {
  const cs = useContributors(thread).filter(c => c.agent);
  if (!cs.length) return null;
  const shown = cs.slice(0, 4);
  const faces = shown.map(c => {
    const face = <AgentFace id={c.id} expression={stateOf(c, thread).expression} small className="size-5" />;
    return (
      <span key={c.id} className="-ml-1 flex rounded-full bg-card ring-2 ring-card first:ml-0">
        {onOpen ? face : <AgentLink id={c.id}>{face}</AgentLink>}
      </span>
    );
  });
  const more = cs.length > 4 && <span className="ml-1 text-xs text-muted-foreground tabular-nums">+{cs.length - 4}</span>;
  return onOpen ? (
    <button data-agent="thread-agents" title={cs.map(c => `${c.name}: ${stateOf(c, thread).word}`).join("\n")} onClick={onOpen} className="flex shrink-0 items-center rounded-full px-1 py-0.5 hover:bg-muted">
      {faces}
      {more}
    </button>
  ) : (
    <span data-agent="thread-agents" className="flex shrink-0 items-center">
      {faces}
      {more}
    </span>
  );
}
