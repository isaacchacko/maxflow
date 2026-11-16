import { Archive, ArrowLeft, Copy, ExternalLink, FolderGit2, GitBranch, GitPullRequest, Hash, Network, Pause, Play, Plus, User, Waypoints } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { NOW_AT, agentStateColor, statusColor, type Agent, type AgentState } from "@/mock";
import { addSignal, agentStore, objectiveStore, pathOf, signalStore, taskStore } from "@/store";
import { closing, transcriptFor, typedStore, type Line } from "./transcript";

function Tty({ agent, lines }: { agent: Agent; lines: Line[] }) {
  const [draft, setDraft] = useState("");
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border bg-black/40 font-mono text-[13px] leading-relaxed">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {lines.map((l, i) => (
          <div key={i} className="mb-2">
            {l.kind === "system" && <p className="text-muted-foreground/60">{l.text}</p>}
            {l.kind === "router" && <p className="border-l-2 border-fuchsia-400/60 pl-3 text-fuchsia-300">{l.text}</p>}
            {l.kind === "sentry" && <p className="border-l-2 border-amber-400/60 pl-3 text-amber-300/90">{l.text}</p>}
            {l.kind === "user" && (
              <p className="bg-muted/40 px-2 py-1">
                <span className="text-sky-400">&gt; </span>
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
                  <span className="text-emerald-400">⏺ </span>
                  <span className="font-semibold">{l.name}</span>
                  <span className="text-muted-foreground">({l.arg})</span>
                </p>
                <p className="pl-4 text-muted-foreground">⎿ {l.result}</p>
              </>
            )}
            {l.kind === "working" && (
              <p className="text-agent">
                <span className="inline-block animate-spin">✻</span> {l.text}… <span className="text-muted-foreground">(esc to interrupt)</span>
              </p>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex items-center gap-2 border-t px-4 py-2.5">
        <span className="text-sky-400">&gt;</span>
        <input
          data-agent="tty-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={`Message ${agent.id}`}
          className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
        />
      </form>
      <div className="flex gap-4 border-t px-4 py-1 text-[11px] text-muted-foreground">
        <span>opus 5.5</span>
        <span>{agent.role === "router" ? "routing" : `isaac/${agent.id}`}</span>
        <span className="ml-auto">ctx 38%</span>
      </div>
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

const sourceIcon = { isaac: User, gh: GitPullRequest, slack: Hash };

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

  const spawn = () => {
    const n = crew.length + 1;
    const id = `${router.id.replace(/^r-/, "")}-${n}`;
    agentStore.set(all => [...all, { id, role: "worker", objectiveId: router.objectiveId, parent: router.id, taskIds: [], state: "idle", doing: "Waiting for a brief" }]);
  };

  return (
    <>
      <Section title="Properties">
        <Row label="State">
          <span className={cn("size-2", agentStateColor[router.state])} />
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
        <Row label="Model">opus 5.5</Row>
      </Section>

      <Separator />

      <Section title={`Agents · ${crew.length}`}>
        {stateOrder.map(state => {
          const group = crew.filter(a => a.state === state);
          if (!group.length) return null;
          return (
            <div key={state} className="flex flex-col">
              <p className="flex items-center gap-1.5 pt-1 pb-0.5 text-[11px] text-muted-foreground">
                <span className={cn("size-1.5", agentStateColor[state])} />
                {state} · {group.length}
              </p>
              {group.map(a => {
                const task = tasks.find(t => a.taskIds.includes(t.id));
                return (
                  <a key={a.id} href={`#agent/${a.id}`} className="flex flex-col px-1 py-1 hover:bg-muted">
                    <span className="font-mono text-xs">{a.id}</span>
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
        {dispatched.length === 0 && <p className="text-xs text-muted-foreground">Nothing has reached this router yet.</p>}
        {dispatched.slice(0, 10).map(({ signal, to }) => {
          const Icon = sourceIcon[signal.source];
          return (
            <div key={signal.id} className="flex flex-col gap-0.5 py-0.5 text-sm">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{signal.text}</span>
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
                  <span>kept · handled by {router.id}</span>
                )}
              </p>
            </div>
          );
        })}
      </Section>

      <Separator />

      <Section title={`Other routers on this objective · ${peers.length}`}>
        {peers.length === 0 && <p className="text-xs text-muted-foreground">This router owns the whole objective.</p>}
        {peers.map(r => (
          <a key={r.id} href={`#agent/${r.id}`} className="flex flex-col px-1 py-1 hover:bg-muted">
            <span className="flex items-center gap-1.5 font-mono text-xs">
              <Network className="size-3 text-fuchsia-400" />
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
  const tasks = taskStore.use();
  const objectives = objectiveStore.use();
  const signals = signalStore.use();
  const typed = typedStore.use()[id] ?? [];

  const agent = agents.find(a => a.id === id);
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

  const setState = (state: AgentState) => agentStore.set(all => all.map(a => (a.id === agent.id ? { ...a, state } : a)));

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href={`#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        {agent.role === "router" ? <Network className="size-4 text-fuchsia-400" /> : <span className={cn("size-2.5", agentStateColor[agent.state])} />}
        <h1 className="font-mono text-lg">{agent.id}</h1>
        <Badge variant="outline">{agent.role}</Badge>
        <span className="truncate text-sm text-muted-foreground">{agent.role === "router" ? agent.scope : agent.doing}</span>
        {agent.role === "router" && (
          <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            {stateOrder.map(state => {
              const n = crew.filter(a => a.state === state).length;
              return n ? (
                <span key={state} className="flex items-center gap-1">
                  <span className={cn("size-1.5", agentStateColor[state])} />
                  {n} {state}
                </span>
              ) : null;
            })}
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          {agent.state === "idle" || agent.state === "asleep" ? (
            <Button variant="outline" size="sm" onClick={() => setState("working")}>
              <Play /> Resume
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setState("idle")}>
              <Pause /> Pause
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setState("asleep")} disabled={agent.state === "asleep"}>
            <Archive /> Archive
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <Tty agent={agent} lines={lines} />

        <aside className="flex w-1/4 min-w-72 shrink-0 flex-col gap-5 overflow-y-auto pr-1">
          {agent.role === "router" ? (
            <RouterSidebar router={agent} />
          ) : (
            <>
          <Section title="Properties">
            <Row label="State">
              <span className={cn("size-2", agentStateColor[agent.state])} />
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
                  <Network className="size-3.5 shrink-0 text-fuchsia-400" />
                  <span className="truncate font-mono text-xs">{parent.id}</span>
                </a>
              </Row>
            )}
            {agent.scope && <Row label="Scope">{agent.scope}</Row>}
            {task && (
              <Row label="Task">
                <a href={`#task/${task.id}`} className="flex min-w-0 items-center gap-1.5 hover:underline">
                  <span className={cn("size-2 shrink-0", statusColor[task.status])} />
                  <span className="truncate">{task.title}</span>
                </a>
              </Row>
            )}
            {task && <Row label="Started">{new Date(task.start).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Row>}
            <Row label="Model">opus 5.5</Row>
          </Section>

          <Separator />

          <Section title="Links">
            {task?.pr && <LinkRow icon={GitPullRequest} label={`#${task.pr}`} detail={task.title} href="#" />}
            {agent.role === "worker" && <LinkRow icon={GitBranch} label={`isaac/${agent.id}`} detail="branch" href="#" />}
            {agent.role === "worker" && <LinkRow icon={FolderGit2} label={`~/Worktrees/${agent.id}`} detail="worktree" href="#" />}
            {routedHere.filter(s => s.source === "slack").slice(0, 2).map(s => (
              <LinkRow key={s.id} icon={Hash} label={s.target} detail="Slack thread" href="#" />
            ))}
            <button className="flex items-center gap-2 px-1 py-1 text-left text-sm text-muted-foreground hover:bg-muted" onClick={() => navigator.clipboard?.writeText(`maxflow attach ${agent.id}`).catch(() => {})}>
              <Copy className="size-3.5" /> Copy attach command
            </button>
          </Section>

          <Separator />

          <Section title={`Routed here · ${routedHere.length}`}>
            {routedHere.length === 0 && <p className="text-xs text-muted-foreground">Nothing routed here yet.</p>}
            {routedHere.slice(0, 8).map(s => {
              const Icon = sourceIcon[s.source];
              return (
                <div key={s.id} className="flex items-start gap-2 text-sm">
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{s.text}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {s.at.slice(0, 10) === NOW_AT.slice(0, 10) ? s.at.slice(11, 16) : new Date(s.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </div>
              );
            })}
          </Section>

          <Separator />

          <Section title={agent.role === "router" ? "Agents" : "Alongside"}>
            {(agent.role === "router" ? crew : siblings).length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
            {(agent.role === "router" ? crew : siblings).map(a => (
              <a key={a.id} href={`#agent/${a.id}`} className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
                <span className={cn("size-2 shrink-0", agentStateColor[a.state])} />
                <span className="shrink-0 font-mono text-xs">{a.id}</span>
                <span className="truncate text-xs text-muted-foreground">{a.doing}</span>
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
