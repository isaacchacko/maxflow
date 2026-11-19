import { ArrowRight, Check, ChevronLeft, ChevronRight, Link2, MessageSquarePlus, Plus, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useEventListener, useResource } from "@/lib/effects";
import { useKeyedState } from "@/lib/useKeyedState";
import type { Thread } from "@/mock";
import { plain, score, useThreadItems } from "@/components/QuickSwitcher";
import { cn, hasText } from "@/lib/utils";
import { addTodo, deleteTodo, editTodo, isOpen, startTodoThread, tagThread, liveStore, loadTodos, threadStore, TODO_STATES, todoStore, type Todo, type TodoState } from "@/store";
import { useLayerScroll } from "@/threads/jump";
import { ago } from "@/threads/Replies";
import { Avatar, Rich } from "@/threads/Rich";

const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dateOf = (day: string) => {
  const [y = 0, m = 1, d = 1] = day.split("-", 3).map(Number);
  return new Date(y, m - 1, d);
};
const firstOfMonth = (day: string) => dateOf(`${day.slice(0, 8)}01`);
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const STATE_LABEL: Record<TodoState, string> = { todo: "Not started", doing: "In progress", done: "Done", cancelled: "Cancelled" };
const DAY_MS = 86_400_000;
const THREAD_HREF = "#thread/";

const nextState = (state: TodoState) => TODO_STATES[(TODO_STATES.indexOf(state) + 1) % TODO_STATES.length] ?? state;
const firstLine = (text: string) => text.split("\n", 1)[0] ?? "";

function relativeDayName(diff: number) {
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return diff === -1 ? "Yesterday" : undefined;
}

function label(day: string, today: string) {
  const d = dateOf(day);
  const named = relativeDayName(Math.round((d.getTime() - dateOf(today).getTime()) / DAY_MS));
  const date = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  return named === undefined ? date : `${named} · ${date}`;
}

type Ask = { thread: Thread; asks: NonNullable<Thread["asks"]> };

function waitingOnHisAnswer(threads: Thread[]): Ask[] {
  const waiting: Ask[] = [];
  for (const t of threads) if (t.asks && !t.resolved && !t.paused) waiting.push({ thread: t, asks: t.asks });
  return waiting.toSorted((a, b) => a.asks.since.localeCompare(b.asks.since));
}

function NeedsYou({ asks }: { asks: Ask[] }) {
  if (asks.length === 0) return null;
  return (
    <section className="mb-5">
      <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">Needs you · {asks.length}</h2>
      <ol className="flex flex-col">
        {asks.map(({ thread: t, asks: ask }) => {
          const said = t.messages.findLast(m => m.from !== "isaac") ?? t.messages[0];
          return (
            <li key={t.id} data-row={`thread/${t.id}`}>
              <a href={`#thread/${t.id}`} className="flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted/60">
                <Avatar from={said?.from ?? ask.sessionId} small />
                <Rich still text={firstLine(said?.text ?? t.title)} className="min-w-0 flex-1 truncate" />
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(Date.parse(ask.since))}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function CarriedFromEarlier({ carried, today }: { carried: Todo[]; today: string }) {
  if (carried.length === 0) return null;
  return (
    <section className="mt-5">
      <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">From earlier · {carried.length}</h2>
      <ol className="flex flex-col">
        {carried.map(t => (
          <TodoRow
            key={t.id}
            todo={t}
            from={t.day}
            onMove={() => {
              void editTodo(t.id, { day: today });
            }}
          />
        ))}
      </ol>
    </section>
  );
}

export function TodoView() {
  const threads = threadStore.use();
  const todos = todoStore.use();
  const isLive = liveStore.use();
  const today = dayOf(new Date());
  const [day, setDay] = useState(today);
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachScroll = useLayerScroll("todo", scrollRef);
  useResource(isLive ? "todos" : undefined, loadTodos);

  const inOrderAdded = todos.filter(t => t.day === day).toSorted((a, b) => a.at.localeCompare(b.at));
  const openFromDaysGoneBy = day === today ? todos.filter(t => isOpen(t) && t.day < today).toSorted((a, b) => a.day.localeCompare(b.day)) : [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-5">
        <h1 className="text-sm font-medium">Todo</h1>
      </header>
      <div ref={attachScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col-reverse gap-6 px-5 py-4 md:flex-row md:items-start">
          <div className="min-w-0 flex-1">
            <NeedsYou asks={waitingOnHisAnswer(threads)} />
            <div className="mb-2 flex items-baseline gap-2 px-2.5">
              <h2 className="text-base font-semibold">{label(day, today)}</h2>
              {day !== today && (
                <button onClick={() => setDay(today)} className="text-xs text-muted-foreground hover:text-foreground">
                  Back to today
                </button>
              )}
            </div>
            <NewTodo key={day} day={day} />
            <ol className="flex flex-col">
              {inOrderAdded.map(t => (
                <TodoRow key={t.id} todo={t} />
              ))}
            </ol>
            {inOrderAdded.length === 0 && <p className="px-2.5 py-1.5 text-sm text-muted-foreground">Nothing for this day.</p>}
            <CarriedFromEarlier carried={openFromDaysGoneBy} today={today} />
          </div>
          <Calendar day={day} today={today} todos={todos} onPick={setDay} />
        </div>
      </div>
    </div>
  );
}

function NewTodo({ day }: { day: string }) {
  const [text, setText] = useState("");
  const add = () => {
    if (!text.trim()) return;
    void addTodo(text.trim(), day);
    setText("");
  };
  return (
    <div className="mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 focus-within:bg-muted/60">
      <Plus className="size-4 shrink-0 text-muted-foreground" />
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
        placeholder="Add a todo"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

function TodoText({ todo, draft, onDraft, onSave }: { todo: Todo; draft: string | undefined; onDraft: (draft: string | undefined) => void; onSave: () => void }) {
  if (draft === undefined) {
    return (
      <span onClick={() => onDraft(todo.text)} className={cn("min-w-0 flex-1 cursor-text truncate", todo.state === "done" && "text-muted-foreground line-through", todo.state === "cancelled" && "text-muted-foreground/60 line-through")}>
        {todo.text}
      </span>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={e => onDraft(e.target.value)}
      onBlur={onSave}
      onKeyDown={e => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) onSave();
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onDraft(undefined);
      }}
      className="min-w-0 flex-1 bg-transparent outline-none"
    />
  );
}

function TodoRow({ todo, from, onMove }: { todo: Todo; from?: string; onMove?: () => void }) {
  const [draft, setDraft] = useState<string>();
  const [isPicking, setPicking] = useState(false);
  const all = threadStore.use();
  const tagged = todo.threadIds.flatMap(id => all.find(t => t.id === id) ?? []);
  const save = () => {
    const text = draft?.trim();
    setDraft(undefined);
    if (hasText(text) && text !== todo.text) void editTodo(todo.id, { text });
  };
  return (
    <li>
      <div className={cn("group relative flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted/60", isPicking && "bg-muted/60")}>
        <StateBox
          state={todo.state}
          onClick={() => {
            void editTodo(todo.id, { state: nextState(todo.state) });
          }}
        />
        <TodoText todo={todo} draft={draft} onDraft={setDraft} onSave={save} />
        <button onClick={() => setPicking(true)} title="Tag a thread, or start one" className={cn("shrink-0 text-muted-foreground hover:text-foreground", !isPicking && "opacity-0 group-hover:opacity-100")}>
          <Link2 className="size-4" />
        </button>
        {isPicking && <ThreadPicker todo={todo} onClose={() => setPicking(false)} />}
        {hasText(from) && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{dateOf(from).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
        {onMove && (
          <button onClick={onMove} title="Move to today" className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
            <ArrowRight className="size-4" />
          </button>
        )}
        <button
          onClick={() => {
            void deleteTodo(todo.id);
          }}
          title="Delete"
          className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {tagged.length > 0 && (
        <ol className="ml-[26px] flex flex-col">
          {tagged.map(t => (
            <TaggedThread
              key={t.id}
              thread={t}
              onUntag={() => {
                void tagThread(todo.id, t.id, false);
              }}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

const plainFirstLineInOneFace = (text: string) => plain(firstLine(text)).replaceAll(/`|\*\*|~~/g, "").trim();

function TaggedThread({ thread, onUntag }: { thread: Thread; onUntag: () => void }) {
  const last = thread.messages.at(-1);
  const line = last ? plainFirstLineInOneFace(last.text) : undefined;
  const saidUnlessItIsTheTitle = hasText(line) && line !== thread.title ? line : undefined;
  return (
    <li className="group/thread flex min-w-0 items-center rounded-lg hover:bg-muted/60">
      <a href={`#thread/${thread.id}`} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1 text-sm">
        {last && <Avatar from={last.from} small />}
        <span className="max-w-[45%] shrink-0 truncate">{thread.title}</span>
        {hasText(saidUnlessItIsTheTitle) && <span className="min-w-0 flex-1 truncate text-muted-foreground">{saidUnlessItIsTheTitle}</span>}
        {last && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{ago(Date.parse(last.at))}</span>}
      </a>
      <button onClick={onUntag} title="Untag the thread" className="mr-2 shrink-0 text-muted-foreground opacity-0 group-hover/thread:opacity-100 hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </li>
  );
}

type ThreadItem = ReturnType<typeof useThreadItems>[number];
type ScoredItem = ThreadItem & { s: number };

const byScoreThenRank = (a: ScoredItem, b: ScoredItem) => {
  const byScore = b.s - a.s;
  return byScore === 0 ? b.rank - a.rank : byScore;
};

function bestThreadMatches(items: ThreadItem[], query: string) {
  const q = query.trim();
  if (q === "") return items.toSorted((a, b) => b.rank - a.rank).slice(0, 8);
  return items
    .map(i => ({ i, name: score(q, i.label, true), body: score(q, i.text, false) }))
    .filter(({ name, body }) => name !== null || body !== null)
    .map(({ i, name, body }): ScoredItem => ({ ...i, s: Math.max(name ?? 0, (body ?? 0) - 100) }))
    .toSorted(byScoreThenRank)
    .slice(0, 8);
}

function ThreadPicker({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const items = useThreadItems().filter(i => !todo.threadIds.includes(i.href.slice(THREAD_HREF.length)));
  const [query, setQuery] = useState("");
  const [active, setActive] = useKeyedState(query, 0);
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => bestThreadMatches(items, query), [items, query]);
  useEventListener("pointerdown", e => {
    if (e.target instanceof Node && box.current?.contains(e.target) === true) return;
    onClose();
  });
  const newThreadRow = shown.length;
  const pick = (i: number) => {
    onClose();
    const item = shown[i];
    if (item) void tagThread(todo.id, item.href.slice(THREAD_HREF.length), true);
    else void startTodoThread(todo);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(a => Math.min(a + 1, newThreadRow));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(a => Math.max(a - 1, 0));
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      pick(active);
      return;
    }
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  };
  const row = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm";
  return (
    <div ref={box} className="absolute top-full right-2 z-30 mt-1 w-96 max-w-[calc(100%-1rem)] rounded-xl border bg-popover p-1 shadow-raised">
      <input autoFocus value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder="Tag a thread…" className="w-full border-b bg-transparent px-2 pt-1 pb-2 text-sm outline-none placeholder:text-muted-foreground" />
      <ol className="mt-1 flex flex-col">
        {shown.map((item, i) => (
          <li key={item.href}>
            <button onMouseEnter={() => setActive(i)} onClick={() => pick(i)} className={cn(row, i === active && "bg-muted")}>
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          </li>
        ))}
        {query.trim() !== "" && shown.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No thread matches.</li>}
        <li className="mt-1 border-t pt-1">
          <button onMouseEnter={() => setActive(newThreadRow)} onClick={() => pick(newThreadRow)} className={cn(row, active === newThreadRow && "bg-muted")}>
            <MessageSquarePlus className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              New thread: <span className="text-muted-foreground">{todo.text}</span>
            </span>
          </button>
        </li>
      </ol>
    </div>
  );
}

function StateBox({ state, onClick }: { state: TodoState; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`${STATE_LABEL[state]} · click for ${STATE_LABEL[nextState(state)].toLowerCase()}`}
      aria-label={STATE_LABEL[state]}
      className={cn(
        "grid size-4 shrink-0 place-items-center overflow-hidden rounded-[4px] border border-input outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        state === "doing" && "border-link bg-[linear-gradient(to_right,var(--link)_50%,transparent_50%)]",
        state === "done" && "border-primary bg-primary text-primary-foreground",
        state === "cancelled" && "border-muted-foreground/40 text-muted-foreground",
      )}
    >
      {state === "done" && <Check className="size-3.5" />}
      {state === "cancelled" && <X className="size-3.5" />}
    </button>
  );
}

function dotColor(d: string, day: string, today: string) {
  if (d === day) return "bg-primary-foreground";
  return d < today ? "bg-warn" : "bg-link";
}

function DayCell({ d, day, today, hasOpenTodo, onPick }: { d: string; day: string; today: string; hasOpenTodo: boolean; onPick: (day: string) => void }) {
  return (
    <button
      onClick={() => onPick(d)}
      className={cn("relative mx-auto grid size-8 place-items-center rounded-full tabular-nums hover:bg-muted", d === today && "font-semibold text-link", d === day && "bg-primary text-primary-foreground hover:bg-primary")}
    >
      {Number(d.slice(8))}
      {hasOpenTodo && <span className={cn("absolute bottom-1 size-1 rounded-full", dotColor(d, day, today))} />}
    </button>
  );
}

function Calendar({ day, today, todos, onPick }: { day: string; today: string; todos: Todo[]; onPick: (day: string) => void }) {
  const [month, setMonth] = useKeyedState(day, firstOfMonth(day));
  const daysWithOpenTodos = new Set(todos.filter(isOpen).map(t => t.day));
  const blanksBeforeFirst = month.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => dayOf(new Date(month.getFullYear(), month.getMonth(), i + 1)));
  const turn = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));
  return (
    <div className="w-full shrink-0 rounded-xl border p-3 md:sticky md:top-0 md:w-64">
      <div className="mb-2 flex items-center justify-between">
        <span className="pl-1 text-sm font-medium">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        <div className="flex">
          <button onClick={() => turn(-1)} title="Previous month" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <ChevronLeft className="size-4" />
          </button>
          <button onClick={() => turn(1)} title="Next month" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-xs">
        {WEEKDAYS.map((w, i) => (
          <span key={i} className="pb-1 text-muted-foreground">
            {w}
          </span>
        ))}
        {Array.from({ length: blanksBeforeFirst }, (_, i) => (
          <span key={`pad-${i}`} />
        ))}
        {days.map(d => (
          <DayCell key={d} d={d} day={day} today={today} hasOpenTodo={daysWithOpenTodos.has(d)} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}
