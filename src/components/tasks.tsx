import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Bell, Bot, Check, ChevronRight, ExternalLink, GitMerge, GitPullRequest, Hourglass, MessageSquare, Search, SquareKanban, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { QuestionCard } from "@/components/questions";
import { Terminal, type TerminalHandle } from "@/components/terminal";
import { ago, api, pasteImages, store, type OpenComment, type Question, type QueuedPr, type Session, type Task } from "@/lib/api";
import { cn } from "@/lib/utils";

// Linear's status circles: an outline to start, filling as the work goes, a check when done.
function StatusIcon({ status, className }: { status: Task["status"]; className?: string }) {
  const color = { todo: "text-muted-foreground", doing: "text-[#f2c94c]", you: "text-sentry", waiting: "text-[#4cb782]", blocked: "text-[#eb5757]", done: "text-[#5e6ad2]", dropped: "text-muted-foreground" }[status];
  const fill = { todo: 0, doing: 0.5, you: 0.75, waiting: 0.75, blocked: 0.25, done: 1, dropped: 0 }[status];
  // A pie wedge from 12 o'clock, clockwise, covering `fill` of the inner circle.
  const end = 2 * Math.PI * fill;
  const wedge = `M7 7 L7 3.5 A3.5 3.5 0 ${fill > 0.5 ? 1 : 0} 1 ${7 + 3.5 * Math.sin(end)} ${7 - 3.5 * Math.cos(end)} Z`;
  return (
    <svg viewBox="0 0 14 14" className={cn("size-3.5 shrink-0", color, className)} aria-hidden>
      {status === "done" ? (
        <>
          <circle cx="7" cy="7" r="7" fill="currentColor" />
          <path d="M4 7.2l2 2 4-4.4" fill="none" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={status === "dropped" ? "1.6 1.54" : undefined} />
          {fill > 0 && <path d={wedge} fill="currentColor" />}
        </>
      )}
    </svg>
  );
}

const COLUMNS: { status: Task["status"]; title: string }[] = [
  { status: "todo", title: "Todo" },
  { status: "doing", title: "In Progress" },
  { status: "you", title: "Needs You" },
  { status: "waiting", title: "Waiting on Others" },
  { status: "blocked", title: "Blocked" },
  { status: "done", title: "Done" },
];
const DONE_SHOWN = 20;
const statusTitle = (s: Task["status"]) => COLUMNS.find((c) => c.status === s)?.title ?? "Dropped";
const taskKey = (t: Task) => `T-${t.id}`;
const prLabel = (url: string) => url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/)?.slice(1).join("#");
// What a task's agents are asleep on, the longest wait first: "teammate approval on app#12345 · 3h".
function waitingOn(t: Task, byId: Map<string, Session>) {
  const waits = t.sessions.flatMap((id) => {
    const s = byId.get(id);
    return s?.wait && s.wait.kind !== "done" ? [{ s, w: s.wait }] : [];
  }).sort((a, b) => a.w.at - b.w.at);
  if (!waits.length) return null;
  const { s, w } = waits[0];
  const pr = prLabel(w.ref) ?? w.ref;
  const what = { q: `your answer to q${w.ref}`, approval: `teammate approval on ${pr}`, ci: `CI on ${pr}`, agent: `“${byId.get(w.ref)?.name ?? w.ref}”`, slack: "a Slack reply", done: "" }[w.kind];
  return { text: `${s.name} waits on ${what}`, at: w.at };
}
const prKey = (url: string) => url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)?.slice(1).join("#").toLowerCase();
const initials = (name: string) => name.split(/\s+/).filter((w) => /^[a-z0-9]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable=true], .xterm");

function Avatars({ ids, named }: { ids: string[]; named: Map<string, string> }) {
  if (!ids.length) return null;
  return (
    <span className="flex -space-x-1">
      {ids.slice(0, 3).map((id) => (
        <span key={id} title={named.get(id) ?? id} className="grid size-4 place-items-center rounded-full bg-secondary text-[8px] font-medium text-foreground ring-1 ring-card">
          {initials(named.get(id) ?? id)}
        </span>
      ))}
      {ids.length > 3 && <span className="grid size-4 place-items-center rounded-full bg-secondary text-[8px] text-muted-foreground ring-1 ring-card">+{ids.length - 3}</span>}
    </span>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] text-muted-foreground", className)}>{children}</span>;
}

// The user's task board, which sentry:assistant derives from his prompts and the agents' work; he reads it, never edits it.
export function TasksBoard({ tasks, prs, comments, questions, sessions, onOpen, onSettled, onClose }: { tasks: Task[]; prs: QueuedPr[]; comments: OpenComment[]; questions: Question[]; sessions: Session[]; onOpen: (id: string) => void; onSettled: () => void; onClose: () => void }) {
  const [shown, setShown] = useState<number | null>(null);
  // Changes he saw on this page before the next poll brings the server's seen marks back.
  const [seenHere, setSeenHere] = useState<Record<number, number>>({});
  const see = (ids: number[]) => (setSeenHere((m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, Date.now()])) })), api.seen(ids));
  const unseen = (t: Task) => !!t.change && t.change.at > Math.max(t.seen ?? 0, seenHere[t.id] ?? 0);
  useEffect(() => void (shown !== null && see([shown])), [shown]);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState<{ col: number; row: number } | null>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const named = useMemo(() => new Map(sessions.map((s) => [s.id, s.name])), [sessions]);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  // A search reaches everything the board knows about a card, and every word must appear somewhere in it.
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  // The review sentry's queue stages a green PR with no reviewer yet as "needs reviewer": only the user sends it for approval.
  const unreviewed = prs.filter((p) => p.stage === "needs reviewer" && hits(`${p.pr} ${p.title}`)).sort((a, b) => a.created.localeCompare(b.created));
  // Agents' questions wait on him in Needs You, oldest first, and in the dialog of the task their agent works on.
  const pending = questions.filter((q) => q.status === "pending" && hits(q.thread.map((m) => m.text).join(" ") + q.name));
  const questionsOf = (t: Task) => pending.filter((q) => t.sessions.includes(q.session));
  const taskOf = (q: Question) => tasks.findLast((t) => t.sessions.includes(q.session) && t.status !== "done" && t.status !== "dropped");
  const task = tasks.find((t) => t.id === shown);
  const assistant = sessions.find((s) => s.sentry && s.name === "sentry:assistant" && s.running);
  const [chatting, setChatting] = useState(() => store.get("mf.tasksChat") !== "0");
  const toggleChat = () => setChatting((c) => (store.set("mf.tasksChat", c ? "0" : "1"), !c));
  const chat = useRef<TerminalHandle | null>(null);


  const haystack = (t: Task) =>
    [taskKey(t), t.title, t.answer, ...t.timeline.map((e) => e.text), ...t.links, ...t.sessions.map((id) => named.get(id) ?? id)].join("\n");
  const matches = (t: Task) => hits(haystack(t));
  // Dropped tasks stay off the board, except in a search, where they show in Done with their dashed circle.
  const inColumn = (t: Task, status: Task["status"]) => t.status === status || (!!words.length && status === "done" && t.status === "dropped");
  // The task that owns a PR ("owner/repo#n"): one linking it, else one whose agent mentioned it; open tasks first, then the latest.
  const ownerOf = (pr: string) => {
    const ranked = tasks.filter((t) => t.status !== "dropped").sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || b.updated - a.updated);
    const names = (links: string[] = []) => links.some((l) => prKey(l) === pr);
    return ranked.find((t) => names(t.links)) ?? ranked.find((t) => t.sessions.some((id) => names(byId.get(id)?.links)));
  };
  // Updated holds every task created or moved since he last saw it, newest first, beside its place in its own column.
  const updated = tasks.filter((t) => unseen(t) && matches(t)).sort((a, b) => b.change!.at - a.change!.at);
  const columns = [
    { status: "updated" as const, title: "Updated", all: updated, cards: updated },
    ...COLUMNS.map((c) => {
      const all = tasks.filter((t) => inColumn(t, c.status) && matches(t)).sort((a, b) => b.updated - a.updated);
      return { ...c, all, cards: c.status === "done" && !words.length ? all.slice(0, DONE_SHOWN) : all };
    }),
  ];
  const selected = cursor && columns[cursor.col]?.cards[cursor.row];

  // Linear's keys: j/k or ↓/↑ within a column, h/l or ←/→ across, Enter opens, / filters.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (shown !== null || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") return void (e.preventDefault(), filterInput.current?.focus());
    if (e.key === "Enter" && selected) return void (e.preventDefault(), setShown(selected.id));
    if (e.key === "Escape") return void (cursor ? setCursor(null) : onClose());
    const step = ({ j: [0, 1], ArrowDown: [0, 1], k: [0, -1], ArrowUp: [0, -1], l: [1, 0], ArrowRight: [1, 0], h: [-1, 0], ArrowLeft: [-1, 0] } as Record<string, [number, number]>)[e.key];
    if (!step) return;
    e.preventDefault();
    const filled = columns.map((c, i) => (c.cards.length ? i : -1)).filter((i) => i >= 0);
    if (!filled.length) return;
    if (!cursor) return setCursor({ col: filled[0], row: 0 });
    let col = cursor.col;
    if (step[0]) col = filled[filled.indexOf(col) + step[0]] ?? col;
    const rows = columns[col].cards.length;
    const row = step[1] ? Math.min(Math.max(cursor.row + step[1], 0), rows - 1) : Math.min(cursor.row, rows - 1);
    setCursor({ col, row });
  };
  useEffect(() => {
    // The terminal under the board, and the Ask pane as it mounts, take focus; the board's keys need it back.
    requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.blur());
    const onKey = (e: KeyboardEvent) => keys.current(e);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => void document.querySelector(`[data-task="${selected?.id}"]`)?.scrollIntoView({ block: "nearest" }), [selected?.id]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background text-xs">
      <div className="flex h-11 items-center gap-2 border-b px-3">
        <SquareKanban className="size-4 text-[#5e6ad2]" />
        <span className="text-[13px] font-medium text-foreground">Tasks</span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] text-muted-foreground">Board</span>
        <label className="ml-3 flex h-7 w-56 items-center gap-1.5 rounded-md border bg-card px-2 text-muted-foreground focus-within:border-ring">
          <Search className="size-3.5" />
          <input
            ref={filterInput}
            value={filter}
            onChange={(e) => (setFilter(e.target.value), setCursor(null))}
            onKeyDown={(e) => e.key === "Escape" && (setFilter(""), e.currentTarget.blur())}
            placeholder="Search tasks"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
          {!filter && <Kbd>/</Kbd>}
        </label>
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <Kbd>J</Kbd><Kbd>K</Kbd><span>move</span><Kbd>↵</Kbd><span>open</span>
        </span>
        {assistant && (
          <Button variant={chatting ? "secondary" : "ghost"} size="sm" className="h-7" title="Ask the assistant about your tasks and asks" onClick={toggleChat}><Bot /> Ask</Button>
        )}
        <Button variant="ghost" size="icon" className="size-7" title="Close (⌘K)" onClick={onClose}><X /></Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[repeat(8,minmax(15rem,1fr))] gap-3 overflow-x-auto p-3">
          {columns.map((c, col) => {
            const count = c.all.length + (c.status === "you" ? pending.length + (unreviewed.length ? 1 : 0) : 0);
            return (
              <section key={c.status} className="flex min-h-0 flex-col rounded-lg bg-card/40">
                <h3 className="flex h-9 shrink-0 items-center gap-2 px-2.5 text-[13px] font-medium text-foreground">
                  {c.status === "updated" ? <Bell className="size-3.5 text-[#5e6ad2]" /> : <StatusIcon status={c.status} />}
                  {c.title}
                  <span className="font-normal text-muted-foreground">{count}</span>
                  {c.status === "updated" && c.cards.length > 0 && (
                    <button type="button" className="ml-auto text-xs font-normal text-muted-foreground hover:text-foreground" onClick={() => see(c.cards.map((t) => t.id))}>Mark all seen</button>
                  )}
                </h3>
                <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
                  {c.status === "you" && pending.map((q) => {
                    const owner = taskOf(q);
                    return <QuestionCard key={q.id} q={q} task={owner && `${taskKey(owner)} ${owner.title}`} onOpen={(id) => (onClose(), onOpen(id))} onSettled={onSettled} />;
                  })}
                  {c.status === "you" && unreviewed.length > 0 && <UnreviewedPrs prs={unreviewed} />}
                  {c.cards.map((t, row) => (
                    <TaskCard key={t.id} task={t} named={named} change={c.status === "updated" ? t.change : undefined} onSeen={() => see([t.id])} waiting={t.status === "waiting" || t.status === "you" ? waitingOn(t, byId) : null} selected={selected?.id === t.id} onClick={() => (setCursor({ col, row }), setShown(t.id))} />
                  ))}
                  {c.all.length > c.cards.length && <p className="px-2 py-1 text-muted-foreground">{c.all.length - c.cards.length} older not shown</p>}
                </div>
              </section>
            );
          })}
          <CommentsColumn comments={comments.filter((c) => hits(`${c.pr} ${c.body} ${c.title} ${c.path ?? ""}`))} ownerOf={ownerOf} onOpen={(t) => setShown(t.id)} />
        </div>
        {assistant && chatting && (
          <aside className="flex w-[32rem] max-w-[40%] shrink-0 flex-col border-l">
            <p className="flex h-9 items-center gap-1.5 border-b px-3 text-muted-foreground"><Bot className="size-3.5" />Ask the assistant what's on your plate, or whether an ask was answered.</p>
            <div className="min-h-0 flex-1 py-2 pr-1 pl-3"><Terminal key={assistant.id} id={assistant.id} handle={chat} onClose={() => {}} /></div>
          </aside>
        )}
      </div>
      {!!words.length && !columns.some((c) => c.all.length) && !unreviewed.length && !pending.length && <p className="absolute inset-x-0 top-1/2 text-center text-muted-foreground">No task mentions “{filter}”.</p>}
      {!tasks.length && !unreviewed.length && !pending.length && <p className="absolute inset-x-0 top-1/2 text-center text-muted-foreground">No tasks yet. The assistant adds them as you ask agents for things.</p>}
      <Dialog open={!!task} onOpenChange={(o) => !o && setShown(null)}>
        {task && <TaskDetail task={task} questions={questionsOf(task)} named={named} assistant={assistant?.id} onOpen={(id) => (setShown(null), onClose(), onOpen(id))} onSettled={onSettled} />}
      </Dialog>
    </div>
  );
}

function TaskCard({ task: t, named, change, onSeen, waiting, selected, onClick }: { task: Task; named: Map<string, string>; change?: Task["change"]; onSeen: () => void; waiting: { text: string; at: number } | null; selected: boolean; onClick: () => void }) {
  const prs = t.links.flatMap((url) => prLabel(url) ?? []);
  return (
    <button
      type="button"
      data-task={t.id}
      onClick={onClick}
      className={cn("flex shrink-0 flex-col gap-1.5 rounded-md border bg-card px-3 pt-2.5 pb-2 text-left shadow-xs transition-colors hover:border-input", selected && "border-[#5e6ad2] ring-1 ring-[#5e6ad2] ring-inset")}
    >
      <span className="flex items-center justify-between text-muted-foreground">
        <span className="font-mono text-[11px]">{taskKey(t)}</span>
        <Avatars ids={t.sessions} named={named} />
      </span>
      {change && (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-[#5e6ad2]" title={`${change.from ? `${statusTitle(change.from)} → ` : "New in "}${statusTitle(change.to)}`}>
          {change.from ? <><StatusIcon status={change.from} /><ArrowRight className="size-3.5 text-foreground" strokeWidth={2.5} /></> : "New in"}
          <StatusIcon status={change.to} />{statusTitle(change.to)}
          <span className="text-muted-foreground">· {ago(change.at)}</span>
          <span role="button" title="Mark seen" className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={(e) => (e.stopPropagation(), onSeen())}><Check className="size-3.5" /></span>
        </span>
      )}
      <span className="flex items-start gap-2 text-[13px] leading-snug font-medium text-foreground">
        <StatusIcon status={t.status} className="mt-[3px]" />
        <span className="line-clamp-3">{t.title}</span>
      </span>
      {t.timeline.length > 0 && <span className="line-clamp-2 pl-[22px] text-muted-foreground">{t.timeline.at(-1)!.text}</span>}
      {waiting && <span className="line-clamp-1 pl-[22px] text-[#4cb782]" title={waiting.text}><Hourglass className="mr-1 inline size-3 align-[-2px]" />{waiting.text} · {ago(waiting.at)}</span>}
      <span className="flex flex-wrap items-center gap-1 pl-[22px]">
        {t.kind === "question" && <Chip className={t.answer ? "text-[#4cb782]" : undefined}><span className="size-1.5 rounded-full bg-current" />{t.answer ? "Answered" : "Question"}</Chip>}
        {t.prs?.total > 1 && <Chip className={t.prs.merged + t.prs.closed === t.prs.total ? "text-[#5e6ad2]" : undefined}><GitMerge className="size-3" />{t.prs.merged}/{t.prs.total} merged</Chip>}
        {prs.slice(0, 2).map((p) => <Chip key={p}><GitPullRequest className="size-3" />{p}</Chip>)}
        <span className="ml-auto text-muted-foreground">{ago(t.updated)}</span>
      </span>
    </button>
  );
}

// The user's PR comments still open, newest first; each links to the comment on GitHub.
function CommentsColumn({ comments, ownerOf, onOpen }: { comments: OpenComment[]; ownerOf: (pr: string) => Task | undefined; onOpen: (t: Task) => void }) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg bg-card/40">
      <h3 className="flex h-9 shrink-0 items-center gap-2 px-2.5 text-[13px] font-medium text-foreground">
        <MessageSquare className="size-3.5 text-muted-foreground" />
        Your Open Comments
        <span className="font-normal text-muted-foreground">{comments.length}</span>
      </h3>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
        {comments.toSorted((a, b) => b.at - a.at).map((c) => {
          // A comment opens the task taking it on, with GitHub one click aside; one no task owns opens on GitHub.
          const owner = ownerOf(c.pr);
          const card = "flex shrink-0 flex-col gap-1.5 rounded-md border bg-card px-3 pt-2.5 pb-2 text-left shadow-xs hover:border-input";
          const body = (
            <>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="font-mono text-[11px]">{c.pr.replace(/^[^/]+\//, "")}</span>
                <span className="ml-auto">{ago(c.at)}</span>
                {owner && (
                  <a href={c.url} target="_blank" rel="noreferrer" title="Open the comment on GitHub" className="rounded p-0.5 hover:bg-accent hover:text-foreground" onClick={(e) => e.stopPropagation()}>
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </span>
              <span className="line-clamp-4 text-[13px] leading-snug whitespace-pre-wrap text-foreground">{c.body}</span>
              <span className="flex flex-wrap items-center gap-1">
                {owner && <Chip className="max-w-full text-foreground"><StatusIcon status={owner.status} /><span className="truncate" title={owner.title}>{taskKey(owner)} {owner.title}</span></Chip>}
                <Chip className="max-w-full"><span className="truncate" title={c.title}>{c.path ?? c.title}</span></Chip>
                {c.replies > 0 && <Chip>{c.replies === 1 ? "1 reply" : `${c.replies} replies`}</Chip>}
              </span>
            </>
          );
          return owner ? (
            <div key={c.id} role="button" tabIndex={0} className={cn(card, "cursor-pointer")} onClick={() => onOpen(owner)} onKeyDown={(e) => e.key === "Enter" && onOpen(owner)}>{body}</div>
          ) : (
            <a key={c.id} href={c.url} target="_blank" rel="noreferrer" className={card}>{body}</a>
          );
        })}
      </div>
    </section>
  );
}

function UnreviewedPrs({ prs }: { prs: QueuedPr[] }) {
  return (
    <Collapsible className="group shrink-0 rounded-md border bg-card shadow-xs">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium text-foreground">
        <GitPullRequest className="size-3.5 shrink-0 text-sentry" />
        <span className="flex-1">{prs.length === 1 ? "1 PR needs" : `${prs.length} PRs need`} a reviewer</span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col border-t p-1">
        {prs.map((p) => (
          <a key={p.pr} href={p.url} target="_blank" rel="noreferrer" className="flex flex-col gap-0.5 rounded px-2 py-1.5 hover:bg-secondary">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="font-mono text-[11px]">{p.pr.replace(/^[^/]+\//, "")}</span>
              <span className="ml-auto">{ago(Date.parse(p.created))}</span>
            </span>
            <span className="line-clamp-2 text-foreground">{p.title}</span>
          </a>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

const when = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Linear's issue view: the title, answer and activity on the left, the properties in a sidebar.
function TaskDetail({ task, questions, named, assistant, onOpen, onSettled }: { task: Task; questions: Question[]; named: Map<string, string>; assistant?: string; onOpen: (id: string) => void; onSettled: () => void }) {
  const [reply, setReply] = useState("");
  const [sent, setSent] = useState(false);
  const send = () => {
    if (!assistant || !reply.trim()) return;
    api.notify(assistant, `About ${taskKey(task)} "${task.title}": ${reply.trim()}`);
    setReply("");
    setSent(true);
  };
  return (
    <DialogContent className="flex max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-4xl">
      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-7 py-6">
        <DialogDescription className="flex items-center gap-1.5 text-xs">
          Tasks <ChevronRight className="size-3" /> <span className="font-mono">{taskKey(task)}</span>
        </DialogDescription>
        <DialogTitle className="text-xl leading-snug font-semibold">{task.title}</DialogTitle>
        {questions.map((q) => <QuestionCard key={q.id} q={q} onOpen={onOpen} onSettled={onSettled} />)}
        {task.kind === "question" && (
          <section className="rounded-md border bg-card px-4 py-3 text-sm">
            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Answer</h4>
            <p className={cn("whitespace-pre-wrap", !task.answer && "text-muted-foreground")}>{task.answer ?? "Not answered yet."}</p>
          </section>
        )}
        <section className="flex flex-col gap-3">
          <h4 className="border-b pb-2 text-sm font-medium">Activity</h4>
          <ol className="flex flex-col">
            {task.timeline.map((e, i) => (
              <li key={i} className="relative flex gap-3 pb-4 text-[13px] last:pb-0">
                {i < task.timeline.length - 1 && <span className="absolute top-4 bottom-0 left-[6px] w-px bg-border" />}
                <span className="mt-1 size-[13px] shrink-0 rounded-full border-2 border-border bg-background" />
                <span className="min-w-0 flex-1 whitespace-pre-wrap">
                  {e.text}
                  {e.session && (
                    <button type="button" className="ml-1.5 text-muted-foreground hover:text-foreground hover:underline" onClick={() => onOpen(e.session!)}>· {named.get(e.session) ?? e.session}</button>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground" title={new Date(e.at).toLocaleString()}>{when(e.at)}</span>
              </li>
            ))}
          </ol>
        </section>
        {assistant && (
          <section className="flex flex-col gap-1.5">
            <textarea
              value={reply}
              onChange={(e) => (setReply(e.target.value), setSent(false))}
              onPaste={(e) => pasteImages(e, (edit) => (setReply(edit), setSent(false)))}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
              rows={2}
              placeholder="Reply to the assistant about this task…"
              className="w-full resize-none rounded-md border bg-card px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <span className="text-xs text-muted-foreground">{sent ? "Sent to the assistant; it reads it at its next turn." : "↵ sends to the assistant, ⇧↵ for a new line"}</span>
          </section>
        )}
      </div>
      <aside className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-l bg-card/50 px-5 py-6 pr-10 text-[13px]">
        <Property label="Status">
          <span className="flex items-center gap-2"><StatusIcon status={task.status} />{statusTitle(task.status)}</span>
        </Property>
        <Property label="Type">{task.kind === "question" ? (task.answer ? "Question · answered" : "Question") : "Task"}</Property>
        {task.sessions.length > 0 && (
          <Property label="Agents">
            {task.sessions.map((id) => (
              <button key={id} type="button" disabled={!named.has(id)} onClick={() => onOpen(id)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left -mx-1 hover:bg-secondary disabled:opacity-50">
                <Avatars ids={[id]} named={named} />
                <span className="truncate">{named.get(id) ?? id}</span>
              </button>
            ))}
          </Property>
        )}
        {task.links.length > 0 && (
          <Property label="Links">
            {task.links.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-1 py-0.5 -mx-1 hover:bg-secondary">
                {prLabel(url) ? <GitPullRequest className="size-3.5 shrink-0" /> : <ExternalLink className="size-3.5 shrink-0" />}
                <span className="truncate">{prLabel(url) ?? url.replace(/^https?:\/\/(www\.)?/, "")}</span>
              </a>
            ))}
          </Property>
        )}
        <Property label="Created">{when(task.at)}</Property>
        <Property label="Updated">{ago(task.updated) === "now" ? "just now" : `${ago(task.updated)} ago`}</Property>
      </aside>
    </DialogContent>
  );
}

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
