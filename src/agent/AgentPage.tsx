import { Archive, ArrowLeft, Bot, ExternalLink, FolderGit2, GitBranch, GitPullRequest, Hash, Link2, Network, Pause, Play, Plus, Radar, User, Waypoints } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentFace, expressionOf } from "@/components/AgentFace";
import { Dots } from "@/components/Working";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";
import { NOW_AT, agentStateColor, statusColor, type Agent, type AgentState } from "@/mock";
import { addSignal, agentStore, api, liveStore, objectiveStore, pathOf, sentryStore, setArchived, signalStore, spawnWorker, taskStore } from "@/store";
import { Rich } from "@/threads/Rich";
import { Terminal } from "./Terminal";
import { closing, transcriptFor, typedStore, type Line } from "./transcript";

function Tty({ agent, lines }: { agent: Agent; lines: Line[] }) {
  const [draft, setDraft] = usePersistentDraft(`tty:${agent.id}`);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    addSignal({ source: "isaac", target: "chat", text, routedTo: [agent.id] });
    typedStore.set(t => ({ ...t, [agent.id]: [...(t[agent.id] ?? []), { kind: "user", text }] }));
    agentStore.set(all => all.map(a => (a.id === agent.id ? { ...a, state: "working", doing: text } : a)));
    setTimeout(() => {
      typedStore.set(t => ({ ...t, [agent.id]: [...(t[agent.id] ?? []), { kind: "assistant", text: "On it. I'll post back here when it's done." }] }));
    }, 700);
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border bg-card font-mono text-[13px] leading-relaxed">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {lines.map((l, i) => (
          <div key={i} className="mb-2">
            {l.kind === "system" && <p className="text-muted-foreground/60">{l.text}</p>}
            {l.kind === "router" && <p className="border-l-2 border-router/60 pl-3 text-router">{l.text}</p>}
            {l.kind === "sentry" && <p className="border-l-2 border-command/60 pl-3 text-command/90">{l.text}</p>}
            {l.kind === "user" && (
              <p className="bg-muted/40 px-2 py-1">
                <span className="text-link">&gt; </span>
                {l.text}
              </p>
            )}
            {l.kind === "assistant" && (
              <p>
                <span className="text-agent">⏺ </span>
                {l.text}
              </p>
            )}
            {l.kind === "tool" && (
              <>
                <p>
                  <span className="text-ok">⏺ </span>
                  <span className="font-semibold">{l.name}</span>
                  <span className="text-muted-foreground">({l.arg})</span>
                </p>
                <p className="pl-4 text-muted-foreground">⎿ {l.result}</p>
              </>
            )}
            {l.kind === "working" && (
              <p className="flex items-center gap-2 text-agent">
                <Dots spin />
                <span className="shimmer">{l.text}…</span>
              </p>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex items-center gap-2 border-t px-4 py-2.5">
        <span className="text-link">&gt;</span>
        <input
          data-agent="tty-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={`Message ${agent.id}`}
          className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
        />
      </form>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3 text-sm">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function LinkRow({ icon: Icon, label, detail, href }: { icon: typeof User; label: string; detail?: string; href: string }) {
  return (
    <a href={href} className="group flex items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      <ExternalLink className="ml-auto size-3 shrink-0 opacity-0 group-hover:opacity-60" />
    </a>
  );
}

const sourceIcon = { isaac: User, gh: GitPullRequest, slack: Hash, agent: Bot, sentry: Radar, maxflow: Waypoints };

const stateOrder: AgentState[] = ["working", "waiting", "idle", "asleep"];

function when(at: string) {
  return at.slice(0, 10) === NOW_AT.slice(0, 10) ? at.slice(11, 16) : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A router's page is about its scope: who it runs, what it handed to whom, and who shares the objective. */
function RouterSidebar({ router }: { router: Agent }) {
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const signals = signalStore.use();
  const tasks = taskStore.use();

  const crew = agents.filter(a => a.parent === router.id);
  const objective = objectives.find(o => o.id === router.objectiveId);
  const peers = agents.filter(a => a.role === "router" && a.objectiveId === router.objectiveId && a.id !== router.id);
  const crewIds = new Set(crew.map(a => a.id));
  const dispatched = signals
    .filter(s => pathOf(s, agents).routers.includes(router.id))
    .map(s => ({ signal: s, to: s.routedTo.filter(id => crewIds.has(id)) }));

  const spawn = () => spawnWorker(router);

  return (
    <>
      <Section title="Properties">
        <Row label="State">
          <span className={cn("size-2 rounded-full", agentStateColor[router.state])} />
          {router.state}
        </Row>
        {objective && (
          <Row label="Objective">
            <a href={`#objective/${objective.id}`} className="flex min-w-0 items-center gap-1.5 hover:underline">
              <Waypoints className="size-3.5 shrink-0 text-agent" />
              <span className="truncate">{objective.title}</span>
            </a>
          </Row>
        )}
        <Row label="Scope">{router.scope}</Row>
              </Section>

      <Separator />

      <Section title={`Agents · ${crew.length}`}>
        {stateOrder.map(state => {
          const group = crew.filter(a => a.state === state);
          if (!group.length) return null;
          return (
            <div key={state} className="flex flex-col">
              <p className="flex items-center gap-1.5 pt-1 pb-0.5 text-[11px] text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", agentStateColor[state])} />
                {state} · {group.length}
              </p>
              {group.map(a => {
                const task = tasks.find(t => a.taskIds.includes(t.id));
                return (
                  <a key={a.id} href={`#agent/${a.id}`} className="flex flex-col px-1 py-1 hover:bg-muted">
                    <span className="font-mono text-xs">{a.name ?? a.id}</span>
                    <span className="truncate text-xs text-muted-foreground">{task ? task.title : a.doing}</span>
                  </a>
                );
              })}
            </div>
          );
        })}
        <button onClick={spawn} className="flex items-center gap-2 px-1 py-1 text-left text-sm text-muted-foreground hover:bg-muted">
          <Plus className="size-3.5" /> Spawn agent
        </button>
      </Section>

      <Separator />

      <Section title={`Dispatched · ${dispatched.length}`}>
        {dispatched.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
        {dispatched.slice(0, 10).map(({ signal, to }) => {
          const Icon = sourceIcon[signal.source];
          return (
            <div key={signal.id} className="flex flex-col gap-0.5 py-0.5 text-sm">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <Rich text={signal.text} className="min-w-0 flex-1 truncate" />
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{when(signal.at)}</span>
              </div>
              <p className="pl-5.5 font-mono text-[11px] text-muted-foreground">
                {to.length ? (
                  to.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ", "}→{" "}
                      <a href={`#agent/${id}`} className="text-foreground hover:underline">
                        {id}
                      </a>
                    </span>
                  ))
                ) : (
                  <span>kept</span>
                )}
              </p>
            </div>
          );
        })}
      </Section>

      <Separator />

      <Section title={`Other routers on this objective · ${peers.length}`}>
        {peers.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
        {peers.map(r => (
          <a key={r.id} href={`#agent/${r.id}`} className="flex flex-col px-1 py-1 hover:bg-muted">
            <span className="flex items-center gap-1.5 font-mono text-xs">
              <Network className="size-3 text-router" />
              {r.id}
            </span>
            <span className="truncate text-xs text-muted-foreground">{r.scope}</span>
          </a>
        ))}
      </Section>
    </>
  );
}

export function AgentPage({ id, back }: { id: string; back: string }) {
  const agents = agentStore.use();
  const live = liveStore.use();
  const sentry = sentryStore.use().find(s => s.id === id);
  const tasks = taskStore.use();
  const objectives = objectiveStore.use();
  const signals = signalStore.use();
  const typed = typedStore.use()[id] ?? [];

  const agent = agents.find(a => a.id === id);
  if (!agent && sentry) return <SentryPage id={id} back={back} />;
  if (!agent) return <p className="p-6 text-muted-foreground">No agent {id}.</p>;

  const parent = agents.find(a => a.id === agent.parent);
  const crew = agents.filter(a => a.parent === agent.id);
  const siblings = agents.filter(a => a.parent && a.parent === agent.parent && a.id !== agent.id);
  const objective = objectives.find(o => o.id === agent.objectiveId);
  const task = tasks.find(t => agent.taskIds.includes(t.id) && t.status !== "done") ?? tasks.find(t => t.id === agent.taskIds.at(-1));
  const routedHere = signals.filter(s => {
    const p = pathOf(s, agents);
    return agent.role === "router" ? p.routers.includes(agent.id) : p.agents.includes(agent.id);
  });
  const typedHere = new Set(typed.flatMap(l => (l.kind === "user" ? [l.text] : [])));
  const history = routedHere.filter(s => !(s.source === "isaac" && typedHere.has(s.text))).reverse();
  const lines = [...transcriptFor(agent, crew, parent, task, history), ...typed, closing[agent.state](agent)];

  // Pause interrupts the turn in progress, as Esc does in the terminal.
  const pause = () => (live ? void api(`/api/sessions/${agent.id}/input`, { keys: ["Escape"] }) : agentStore.set(all => all.map(a => (a.id === agent.id ? { ...a, state: "idle" } : a))));

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden pb-3">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href={`#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        <AgentFace id={agent.id} expression={expressionOf(agent.state)} className="size-9" />
        <h1 className={cn("text-lg", !agent.name && "font-mono")}>{agent.name ?? agent.id}</h1>
        <Badge variant="outline">{agent.role}</Badge>
        {agent.role === "router" && <span className="truncate text-sm text-muted-foreground">{agent.scope}</span>}
        {agent.role === "router" && (
          <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            {stateOrder.map(state => {
              const n = crew.filter(a => a.state === state).length;
              return n ? (
                <span key={state} className="flex items-center gap-1">
                  <span className={cn("size-1.5 rounded-full", agentStateColor[state])} />
                  {n} {state}
                </span>
              ) : null;
            })}
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          {agent.state === "asleep" ? (
            <Button variant="outline" size="sm" onClick={() => setArchived(agent.id, false)}>
              <Play /> Resume
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={pause} disabled={agent.state !== "working"}>
              <Pause /> Pause
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setArchived(agent.id, true)} disabled={agent.state === "asleep"}>
            <Archive /> Archive
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 pl-3">
        {live ? (
          <section className="dark min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background p-2">
            <Terminal key={agent.id} id={agent.id} />
          </section>
        ) : (
          <Tty agent={agent} lines={lines} />
        )}

        <aside className="-my-3 flex w-1/4 min-w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l px-4 py-4">
          {agent.role === "router" ? (
            <RouterSidebar router={agent} />
          ) : (
            <>
          <Section title="Properties">
            <Row label="State">
              <span className={cn("size-2 rounded-full", agentStateColor[agent.state])} />
              {agent.state}
            </Row>
            <Row label="Role">{agent.role === "router" ? `router · ${crew.length} agents` : "worker"}</Row>
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
            {agent.scope && <Row label="Scope">{agent.scope}</Row>}
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

          <Separator />

          <Section title="Links">
            {live ? (
              <>
                {agent.cwd && <LinkRow icon={FolderGit2} label={agent.cwd.replace(/^\/(home|Users)\/[^/]+/, "~")} detail="folder" href={`#agent/${agent.id}`} />}
                {agent.links?.map(url => (
                  <LinkRow key={url} icon={/\/pull\/\d+$/.test(url) ? GitPullRequest : Link2} label={url.replace(/^https?:\/\/(www\.)?/, "")} href={url} />
                ))}
              </>
            ) : (
              <>
                {task?.pr && <LinkRow icon={GitPullRequest} label={`#${task.pr}`} detail={task.title} href="#" />}
                {agent.role === "worker" && <LinkRow icon={GitBranch} label={`isaac/${agent.id}`} detail="branch" href="#" />}
                {agent.role === "worker" && <LinkRow icon={FolderGit2} label={`~/Worktrees/${agent.id}`} detail="worktree" href="#" />}
              </>
            )}
            {!live && routedHere.filter(s => s.source === "slack").slice(0, 2).map(s => (
              <LinkRow key={s.id} icon={Hash} label={s.target} detail="Slack thread" href="#" />
            ))}
          </Section>

          <Separator />

          <Section title={`Routed here · ${routedHere.length}`}>
            {routedHere.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
            {routedHere.slice(0, 8).map(s => {
              const Icon = sourceIcon[s.source];
              return (
                <div key={s.id} className="flex items-start gap-2 text-sm">
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <Rich text={s.text} className="min-w-0 flex-1 truncate" />
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {s.at.slice(0, 10) === NOW_AT.slice(0, 10) ? s.at.slice(11, 16) : new Date(s.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </div>
              );
            })}
          </Section>

          <Separator />

          <Section title={agent.role === "router" ? "Agents" : "Alongside"}>
            {(agent.role === "router" ? crew : siblings).length === 0 && <p className="text-xs text-muted-foreground">None</p>}
            {(agent.role === "router" ? crew : siblings).map(a => (
              <a key={a.id} href={`#agent/${a.id}`} className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
                <span className={cn("size-2 shrink-0 rounded-full", agentStateColor[a.state])} />
                <span className="shrink-0 font-mono text-xs">{a.name ?? a.id}</span>
                <Rich still text={a.doing} className="truncate text-xs text-muted-foreground" />
              </a>
            ))}
          </Section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** A sentry's page: its terminal, what it does and which sessions it is tied to. */
function SentryPage({ id, back }: { id: string; back: string }) {
  const sentry = sentryStore.use().find(s => s.id === id)!;
  const agents = agentStore.use();
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden pb-3">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button variant="ghost" size="icon" asChild>
          <a href={`#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        <Radar className="size-4 text-command" />
        <h1 className="text-lg">{sentry.name}</h1>
        <Badge variant="outline">sentry</Badge>
      </header>
      <div className="flex min-h-0 flex-1 gap-4 pl-3">
        <section className="dark min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background p-2">
          <Terminal key={sentry.id} id={sentry.id} />
        </section>
        <aside className="-my-3 flex w-1/4 min-w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l px-4 py-4">
          <Section title="Properties">
            <Row label="State">
              <span className={cn("size-2 rounded-full", sentry.running ? "bg-ok" : "bg-destructive")} />
              {sentry.running ? "running" : "exited"}
            </Row>
            <Row label="Started">{new Date(sentry.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Row>
            <Row label="Last output">{new Date(sentry.lastOutputAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</Row>
          </Section>
          <Separator />
          <Section title={`Tied to · ${sentry.ties.length}`}>
            {sentry.ties.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
            {sentry.ties.map(t => (
              <a key={`${t.session}:${t.label}`} href={`#agent/${t.session}`} className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
                <span className="shrink-0 text-xs">{agents.find(a => a.id === t.session)?.name ?? t.session}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{t.label}</span>
              </a>
            ))}
          </Section>
        </aside>
      </div>
    </div>
  );
}
