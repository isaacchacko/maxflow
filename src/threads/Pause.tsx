import { AlarmClock, Play } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { createStore, setPaused, threadStore } from "@/store";
import { setSeen } from "./seen";
import { CHIPS, formatWhen, parseWhen } from "./when";

const pausing = createStore<string | undefined>(undefined);
/** Asks him until when to put a thread away: from its menus, its header's button, or p. */
export const openPause = (threadId: string) => pausing.set(threadId);

/** "until Tue Nov 17, 9:00 AM", and what agents posted meanwhile. */
export const pausedLabel = (p: NonNullable<Thread["paused"]>) => `until ${formatWhen(p.until)}${p.posts ? ` · ${p.posts} new` : ""}`;

/**
 * A small box over the page: he types when ("tomorrow 9am", "in 2h", "monday", "after lunch") and sees the time it lands on
 * before Enter confirms it, or picks a chip. A paused thread offers to come back now.
 */
export function PauseDialog() {
  const id = pausing.use();
  const thread = threadStore.use().find(t => t.id === id);
  const [said, setSaid] = useState("");
  const [now, setNow] = useState(() => new Date());
  useEffect(() => (setSaid(""), setNow(new Date())), [id]);
  const at = parseWhen(said, now);
  const close = () => pausing.set(undefined);
  const pause = (until: Date, words: string) => (close(), void setPaused(id!, { until: until.getTime(), said: words }));

  return (
    <Dialog.Root open={!!thread} onOpenChange={o => o || close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Content
          data-agent="pause"
          aria-describedby={undefined}
          // Its keys are its own: the digits don't switch views, and Escape only closes it.
          onKeyDown={e => e.stopPropagation()}
          onEscapeKeyDown={e => e.stopPropagation()}
          onCloseAutoFocus={e => e.preventDefault()}
          className="fixed top-[20%] left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-3 rounded-2xl border bg-card p-4 shadow-raised outline-none"
        >
          {thread && (
            <>
              <Dialog.Title className="flex items-center gap-2 text-sm font-medium">
                <AlarmClock className="size-4 text-muted-foreground" />
                <span className="truncate">Pause “{thread.title}”</span>
              </Dialog.Title>
              <form
                onSubmit={e => {
                  e.preventDefault();
                  if (at) pause(at, said.trim());
                }}
                className="flex flex-col gap-1.5"
              >
                <input
                  autoFocus
                  data-agent="pause-input"
                  value={said}
                  onChange={e => (setSaid(e.target.value), setNow(new Date()))}
                  placeholder="tomorrow 9am, in 2h, monday, after lunch…"
                  className="w-full rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
                />
                <p data-agent="pause-resolved" className={cn("px-1 text-xs tabular-nums", at ? "text-foreground" : "text-muted-foreground")}>
                  {at ? `Back ${formatWhen(at, now)}` : said.trim() ? "No time I can read in that" : "Until when?"}
                </p>
              </form>
              <div className="flex flex-wrap gap-1.5">
                {CHIPS.map(c => {
                  const until = parseWhen(c.said, now);
                  return (
                    <button
                      key={c.label}
                      data-agent={`pause-chip:${c.label}`}
                      disabled={!until}
                      title={until && formatWhen(until, now)}
                      onClick={() => until && pause(until, c.label)}
                      className="rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground hover:border-ring hover:text-foreground disabled:opacity-40"
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              {thread.paused && (
                <p className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
                  <span className="flex-1">Paused {pausedLabel(thread.paused)}</span>
                  <button data-agent="pause-unpause" onClick={() => (close(), void setPaused(thread.id, null))} className="flex items-center gap-1 rounded-full border px-2.5 py-0.5 hover:border-ring hover:text-foreground">
                    <Play className="size-3" />
                    Unpause
                  </button>
                </p>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Which resurfacing this browser has already marked unread, so a reload doesn't mark it again after he read it.
const handled = (id: string) => `resurfaced:${id}`;

/** A thread back from its pause is unread from where he paused it (its last message at least), so it sorts up with the red line. */
export function useResurfacing() {
  const threads = threadStore.use();
  useEffect(() => {
    for (const t of threads) {
      if (!t.resurfaced) continue;
      try {
        if (localStorage.getItem(handled(t.id)) === t.resurfaced.at) continue;
        localStorage.setItem(handled(t.id), t.resurfaced.at);
      } catch {
        continue;
      }
      setSeen(t.id, Math.max(t.parentId ? 0 : 1, Math.min(t.resurfaced.from, t.messages.length - 1)));
    }
  }, [threads]);
}

/** Back from a pause and not yet read: the inbox lifts it to the top. */
export const freshlyBack = (t: Thread, unread: number) => !!t.resurfaced && unread > 0;
