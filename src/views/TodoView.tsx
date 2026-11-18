import { ArrowRight, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { addTodo, deleteTodo, editTodo, liveStore, loadTodos, threadStore, todoStore, type Todo } from "@/store";
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

  const onDay = todos.filter(t => t.day === day).sort((a, b) => Number(a.done) - Number(b.done) || a.at.localeCompare(b.at));
  // Open todos from days gone by show under today, so nothing left undone drops out of sight.
  const carried = day === today ? todos.filter(t => !t.done && t.day < today).sort((a, b) => a.day.localeCompare(b.day)) : [];

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

/** Click the text to edit it in place: Enter or leaving the field saves, Escape puts it back. */
function TodoRow({ todo, from, onMove }: { todo: Todo; from?: string; onMove?: () => void }) {
  const [draft, setDraft] = useState<string>();
  const save = () => {
    const text = draft?.trim();
    setDraft(undefined);
    if (text && text !== todo.text) void editTodo(todo.id, { text });
  };
  return (
    <li className="group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted/60">
      <Checkbox checked={todo.done} onCheckedChange={done => void editTodo(todo.id, { done: done === true })} aria-label={todo.done ? "Mark not done" : "Mark done"} />
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
        <span onClick={() => setDraft(todo.text)} className={cn("min-w-0 flex-1 cursor-text truncate", todo.done && "text-muted-foreground line-through")}>
          {todo.text}
        </span>
      )}
      {from && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{dateOf(from).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
      {onMove && (
        <button onClick={onMove} title="Move to today" className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
          <ArrowRight className="size-4" />
        </button>
      )}
      <button onClick={() => void deleteTodo(todo.id)} title="Delete" className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive">
        <Trash2 className="size-4" />
      </button>
    </li>
  );
}

function Calendar({ day, today, todos, onPick }: { day: string; today: string; todos: Todo[]; onPick: (day: string) => void }) {
  const [month, setMonth] = useState(() => dateOf(day.slice(0, 8) + "01"));
  // Picking a day in another month (Back to today) turns the calendar to it.
  useEffect(() => setMonth(m => (dayOf(m).slice(0, 7) === day.slice(0, 7) ? m : dateOf(day.slice(0, 8) + "01"))), [day]);
  const open = new Set(todos.filter(t => !t.done).map(t => t.day));
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
