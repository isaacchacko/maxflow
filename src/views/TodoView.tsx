import { ArrowRight, Check, ChevronLeft, ChevronRight, Link2, MessageSquarePlus, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Thread } from "@/mock";
import { score, useThreadItems } from "@/components/QuickSwitcher";
import { cn } from "@/lib/utils";
import { addTodo, deleteTodo, editTodo, isOpen, startTodoThread, tagThread, liveStore, loadTodos, threadStore, TODO_STATES, todoStore, type Todo, type TodoState } from "@/store";
import { useLayerScroll } from "@/threads/jump";
import { ago } from "@/threads/Replies";
import { Avatar, Rich } from "@/threads/Rich";

// His todo list, a day at a time, beside a month calendar: clicking a day shows its todos, and days with open ones carry a dot.
// Agents waiting on his answer stay on top as a strip, since the sidebar's Todo count is theirs.

/** A day as YYYY-MM-DD in his local time, the key todos are kept under. */
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dateOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d);
};
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const STATE_LABEL: Record<TodoState, string> = { todo: "Not started", doing: "In progress", done: "Done", cancelled: "Cancelled" };

function label(day: string, today: string) {
  const d = dateOf(day);
  const diff = Math.round((d.getTime() - dateOf(today).getTime()) / 86_400_000);
  const named = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : undefined;
  const date = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  return named ? `${named} · ${date}` : date;
}

export function TodoView() {
  const threads = threadStore.use();
  const todos = todoStore.use();
  const live = liveStore.use();
  const today = dayOf(new Date());
  const [day, setDay] = useState(today);
  const asks = threads.filter(t => t.asks && !t.resolved && !t.paused).sort((a, b) => a.asks!.since.localeCompare(b.asks!.since));
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayerScroll("todo", scrollRef);
  useEffect(() => void loadTodos(), [live]);

  // In the order they were added, whatever their state, so a click on a box never moves its row.
  const onDay = todos.filter(t => t.day === day).sort((a, b) => a.at.localeCompare(b.at));
  // Open todos from days gone by show under today, so nothing left undone drops out of sight.
  const carried = day === today ? todos.filter(t => isOpen(t) && t.day < today).sort((a, b) => a.day.localeCompare(b.day)) : [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-5">
        <h1 className="text-sm font-medium">Todo</h1>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col-reverse gap-6 px-5 py-4 md:flex-row md:items-start">
          <div className="min-w-0 flex-1">
            {asks.length > 0 && (
              <section className="mb-5">
                <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">Needs you · {asks.length}</h2>
                <ol className="flex flex-col">
                  {asks.map(t => {
                    const said = t.messages.findLast(m => m.from !== "isaac") ?? t.messages[0];
                    return (
                      <li key={t.id} data-row={`thread/${t.id}`}>
                        <a href={`#thread/${t.id}`} className="flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted/60">
                          <Avatar from={said?.from ?? t.asks!.sessionId} small />
                          <Rich still text={(said?.text ?? t.title).split("\n")[0]!} className="min-w-0 flex-1 truncate" />
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(Date.parse(t.asks!.since))}</span>
                        </a>
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}
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
              {onDay.map(t => (
                <TodoRow key={t.id} todo={t} />
              ))}
            </ol>
            {!onDay.length && <p className="px-2.5 py-1.5 text-sm text-muted-foreground">Nothing for this day.</p>}
            {carried.length > 0 && (
              <section className="mt-5">
                <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">From earlier · {carried.length}</h2>
                <ol className="flex flex-col">
                  {carried.map(t => (
                    <TodoRow key={t.id} todo={t} from={t.day} onMove={() => void editTodo(t.id, { day: today })} />
                  ))}
                </ol>
              </section>
            )}
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

/**
 * Click the text to edit it in place: Enter or leaving the field saves, Escape puts it back. The threads tagged on it, by him or
 * by agents, are rows indented under it.
 */
function TodoRow({ todo, from, onMove }: { todo: Todo; from?: string; onMove?: () => void }) {
  const [draft, setDraft] = useState<string>();
  const [picking, setPicking] = useState(false);
  const all = threadStore.use();
  const tagged = todo.threadIds.flatMap(id => all.find(t => t.id === id) ?? []);
  const save = () => {
    const text = draft?.trim();
    setDraft(undefined);
    if (text && text !== todo.text) void editTodo(todo.id, { text });
  };
  return (
    <li>
    <div className={cn("group relative flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted/60", picking && "bg-muted/60")}>
      <StateBox state={todo.state} onClick={() => void editTodo(todo.id, { state: TODO_STATES[(TODO_STATES.indexOf(todo.state) + 1) % TODO_STATES.length]! })} />
      {draft !== undefined ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) save();
            if (e.key === "Escape") e.stopPropagation(), setDraft(undefined);
          }}
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      ) : (
        <span onClick={() => setDraft(todo.text)} className={cn("min-w-0 flex-1 cursor-text truncate", todo.state === "done" && "text-muted-foreground line-through", todo.state === "cancelled" && "text-muted-foreground/60 line-through")}>
          {todo.text}
        </span>
      )}
      <button onClick={() => setPicking(true)} title="Tag a thread, or start one" className={cn("shrink-0 text-muted-foreground hover:text-foreground", !picking && "opacity-0 group-hover:opacity-100")}>
        <Link2 className="size-4" />
      </button>
      {picking && <ThreadPicker todo={todo} onClose={() => setPicking(false)} />}
      {from && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{dateOf(from).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
      {onMove && (
        <button onClick={onMove} title="Move to today" className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
          <ArrowRight className="size-4" />
        </button>
      )}
      <button onClick={() => void deleteTodo(todo.id)} title="Delete" className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive">
        <Trash2 className="size-4" />
      </button>
    </div>
    {tagged.length > 0 && (
      <ol className="ml-[26px] flex flex-col">
        {tagged.map(t => (
          <TaggedThread key={t.id} thread={t} onUntag={() => void tagThread(todo.id, t.id, false)} />
        ))}
      </ol>
    )}
    </li>
  );
}

/** A thread tagged on a todo: its title, then who spoke last and what they said; it opens the thread. */
function TaggedThread({ thread, onUntag }: { thread: Thread; onUntag: () => void }) {
  const last = thread.messages.at(-1);
  // A thread he started from a line has that line as its title and its one message; it reads once.
  const said = last && last.text.split("\n")[0]!.trim() !== thread.title ? last.text.split("\n")[0]! : undefined;
  return (
    <li className="group/thread flex min-w-0 items-center rounded-lg hover:bg-muted/60">
      <a href={`#thread/${thread.id}`} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1 text-[13px]">
        {last && <Avatar from={last.from} small />}
        <span className="max-w-[45%] shrink-0 truncate font-medium">{thread.title}</span>
        {said && <Rich still text={said} className="min-w-0 flex-1 truncate text-muted-foreground" />}
        {last && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{ago(Date.parse(last.at))}</span>}
      </a>
      <button onClick={onUntag} title="Untag the thread" className="mr-2 shrink-0 text-muted-foreground opacity-0 group-hover/thread:opacity-100 hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </li>
  );
}

/**
 * Tags a thread on a todo, beside any it has: type to search titles and opening messages the way ⌘K does, ↑↓ to move, Enter to
 * pick; the last row starts a new thread from the todo's text instead. Esc or a click outside closes it.
 */
function ThreadPicker({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const items = useThreadItems().filter(i => !todo.threadIds.includes(i.href.slice("#thread/".length)));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const q = query.trim();
    if (!q) return [...items].sort((a, b) => b.rank - a.rank).slice(0, 8);
    return items
      .flatMap(i => {
        const name = score(q, i.label, true), body = score(q, i.text, false);
        return name === null && body === null ? [] : [{ ...i, s: Math.max(name ?? 0, (body ?? 0) - 100) }];
      })
      .sort((a, b) => b.s - a.s || b.rank - a.rank)
      .slice(0, 8);
  }, [items, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || onClose();
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [onClose]);
  // The new-thread row sits after the matches, at index shown.length.
  const pick = (i: number) => {
    onClose();
    if (i < shown.length) void tagThread(todo.id, shown[i]!.href.slice("#thread/".length), true);
    else void startTodoThread(todo);
  };
  const row = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm";
  return (
    <div ref={box} className="absolute top-full right-2 z-30 mt-1 w-96 max-w-[calc(100%-1rem)] rounded-xl border bg-popover p-1 shadow-raised">
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") e.preventDefault(), setActive(a => Math.min(a + 1, shown.length));
          if (e.key === "ArrowUp") e.preventDefault(), setActive(a => Math.max(a - 1, 0));
          if (e.key === "Enter" && !e.nativeEvent.isComposing) pick(active);
          if (e.key === "Escape") e.stopPropagation(), onClose();
        }}
        placeholder="Tag a thread…"
        className="w-full border-b bg-transparent px-2 pt-1 pb-2 text-sm outline-none placeholder:text-muted-foreground"
      />
      <ol className="mt-1 flex flex-col">
        {shown.map((item, i) => (
          <li key={item.href}>
            <button onMouseEnter={() => setActive(i)} onClick={() => pick(i)} className={cn(row, i === active && "bg-muted")}>
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          </li>
        ))}
        {query.trim() && !shown.length && <li className="px-2 py-1.5 text-sm text-muted-foreground">No thread matches.</li>}
        <li className="mt-1 border-t pt-1">
          <button onMouseEnter={() => setActive(shown.length)} onClick={() => pick(shown.length)} className={cn(row, active === shown.length && "bg-muted")}>
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

/** Its box: empty to start, half filled in progress, a check when done, a cross when cancelled; a click steps it to the next. */
function StateBox({ state, onClick }: { state: TodoState; onClick: () => void }) {
  const next = TODO_STATES[(TODO_STATES.indexOf(state) + 1) % TODO_STATES.length]!;
  return (
    <button
      onClick={onClick}
      title={`${STATE_LABEL[state]} · click for ${STATE_LABEL[next].toLowerCase()}`}
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

function Calendar({ day, today, todos, onPick }: { day: string; today: string; todos: Todo[]; onPick: (day: string) => void }) {
  const [month, setMonth] = useState(() => dateOf(day.slice(0, 8) + "01"));
  // Picking a day in another month (Back to today) turns the calendar to it.
  useEffect(() => setMonth(m => (dayOf(m).slice(0, 7) === day.slice(0, 7) ? m : dateOf(day.slice(0, 8) + "01"))), [day]);
  const open = new Set(todos.filter(isOpen).map(t => t.day));
  const first = month.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array(first).fill(undefined), ...Array.from({ length: days }, (_, i) => dayOf(new Date(month.getFullYear(), month.getMonth(), i + 1)))] as (string | undefined)[];
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
        {cells.map((d, i) =>
          d ? (
            <button
              key={d}
              onClick={() => onPick(d)}
              className={cn(
                "relative mx-auto grid size-8 place-items-center rounded-full tabular-nums hover:bg-muted",
                d === today && "font-semibold text-link",
                d === day && "bg-primary text-primary-foreground hover:bg-primary",
              )}
            >
              {Number(d.slice(8))}
              {open.has(d) && <span className={cn("absolute bottom-1 size-1 rounded-full", d === day ? "bg-primary-foreground" : d < today ? "bg-warn" : "bg-link")} />}
            </button>
          ) : (
            <span key={`pad-${i}`} />
          ),
        )}
      </div>
    </div>
  );
}
