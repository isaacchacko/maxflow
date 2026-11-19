import { ArrowUpToLine, AtSign, Bold, Code, Ellipsis, Italic, Link2, List, ListOrdered, Plus, SendHorizontal, Smile, SquareCode, Strikethrough, Type, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useEventListener } from "@/lib/effects";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";
import { EmojiPanel, useEmojiComplete } from "./Emoji";
import { useMentionPicker } from "./Mention";
import { Markdown } from "./Rich";

/** The server keeps a pasted image as a file and returns its path, which the message carries as markdown for the agent to Read. */
async function upload(file: File) {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": file.type }, body: file });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { path } = (await res.json()) as { path: string };
  return path;
}

const preview = (path: string) => `/api/uploads/${path.split("/").at(-1)}`;

/**
 * Adds a quote (markdown) to a composer's draft, ahead of what he types; the composer with that draft key takes it and focuses.
 * With no such composer drawn yet (a subthread still opening), the quote waits for it.
 */
const waiting = new Map<string, string>();
export function quoteInto(draftKey: string, markdown: string) {
  if (dispatchEvent(new CustomEvent("composer-quote", { detail: { draftKey, markdown }, cancelable: true }))) waiting.set(draftKey, [waiting.get(draftKey), markdown].filter(Boolean).join("\n\n"));
}

/** A quote as markdown: the passage, then a link back to the message it came from, which draws as a chip. */
export const quoted = (text: string, thread: string, message: string) => `${text.trim().split("\n").map(l => `> ${l}`).join("\n")}\n>\n> — [[msg:${thread}/${message}]]`;

const imagesIn = (files: FileList | undefined) => [...(files ?? [])].filter(f => f.type.startsWith("image/"));

type Edit = { value: string; start: number; end: number };
// Markdown around the selection, or taken off when it is already there: Slack's toolbar toggles the same way.
function wrap({ value, start, end }: Edit, before: string, after = before): Edit {
  const sel = value.slice(start, end);
  if (value.slice(start - before.length, start) === before && value.slice(end, end + after.length) === after)
    return { value: value.slice(0, start - before.length) + sel + value.slice(end + after.length), start: start - before.length, end: end - before.length };
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length)
    return { value: value.slice(0, start) + sel.slice(before.length, sel.length - after.length) + value.slice(end), start, end: end - before.length - after.length };
  return { value: value.slice(0, start) + before + sel + after + value.slice(end), start: start + before.length, end: end + before.length };
}
// Each selected line gets the list's marker, or loses it when every one has it.
function list({ value, start, end }: Edit, ordered: boolean): Edit {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const to = value.indexOf("\n", end) < 0 ? value.length : value.indexOf("\n", end);
  const lines = value.slice(from, to).split("\n");
  const marked = (l: string) => (ordered ? /^\d+\. /.test(l) : /^[-*] /.test(l));
  const next = lines.every(marked) ? lines.map(l => l.replace(ordered ? /^\d+\. / : /^[-*] /, "")) : lines.map((l, i) => (ordered ? `${i + 1}. ` : "- ") + l.replace(/^(\d+\. |[-*] )/, ""));
  const text = next.join("\n");
  return { value: value.slice(0, from) + text + value.slice(to), start: from, end: from + text.length };
}
function link({ value, start, end }: Edit): Edit {
  const sel = value.slice(start, end);
  // A selected URL becomes the link's target; otherwise the selection is its label and "url" is selected to type over.
  if (/^https?:\/\/\S+$/.test(sel)) return { value: `${value.slice(0, start)}[](${sel})${value.slice(end)}`, start: start + 1, end: start + 1 };
  const text = `[${sel || "text"}](url)`;
  const at = start + text.length - 4;
  return { value: value.slice(0, start) + text + value.slice(end), start: at, end: at + 3 };
}
const codeBlock = (e: Edit) => wrap(e, "```\n", "\n```");

type Format = { label: string; keys?: string; icon: React.ComponentType<{ className?: string }>; apply: (e: Edit) => Edit };
const FORMATS: Format[] = [
  { label: "Bold", keys: "⌘B", icon: Bold, apply: e => wrap(e, "**") },
  { label: "Italic", keys: "⌘I", icon: Italic, apply: e => wrap(e, "_") },
  { label: "Strikethrough", keys: "⌘⇧X", icon: Strikethrough, apply: e => wrap(e, "~~") },
  // No ⌘K: that is the quick switcher's, in this box too.
  { label: "Link", icon: Link2, apply: link },
  { label: "Numbered list", keys: "⌘⇧7", icon: ListOrdered, apply: e => list(e, true) },
  { label: "Bulleted list", keys: "⌘⇧8", icon: List, apply: e => list(e, false) },
  { label: "Code", keys: "⌘⇧C", icon: Code, apply: e => wrap(e, "`") },
  { label: "Code block", keys: "⌘⌥⇧C", icon: SquareCode, apply: codeBlock },
];
// The shortcut a key press means inside the box, by its physical key so ⇧7 is 7 whatever the layout prints.
function formatFor(e: React.KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey)) return undefined;
  const k = e.code.replace(/^(Key|Digit)/, "").toLowerCase();
  const name = e.shiftKey
    ? e.altKey ? (k === "c" ? "Code block" : undefined) : ({ x: "Strikethrough", 7: "Numbered list", 8: "Bulleted list", c: "Code" } as Record<string, string>)[k]
    : e.altKey ? undefined : ({ b: "Bold", i: "Italic" } as Record<string, string>)[k];
  return FORMATS.find(f => f.label === name);
}

const tool = "flex size-7 items-center justify-center rounded-md text-muted-foreground/80 hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground";

// Whether the formatting row shows, one choice for every box, as Slack's Aa remembers it.
const FORMAT_KEY = "composer:format";
const formatShown = () => { try { return localStorage.getItem(FORMAT_KEY) === "1"; } catch { return false; } };

/**
 * A message box drawn as Slack's: one rounded box that lights up while focused, the text, and one row under it: + to attach an image,
 * Aa to show the formatting row (which wraps the selection in markdown; its shortcuts work hidden too), emoji, @ to mention an agent or thread, ⋯ for the box's rarer `tools` (a thread's subthread nudge; `toolsOn` tints it while one
 * is on), and send. It grows with its text up to 40% of the
 * window, and takes images pasted or dropped on it: each is uploaded at once, and its path is kept with the draft so a reload keeps it.
 */
export function Composer({ onSend, onRaise, className, autoFocus, agent, draftKey, tools, toolsOn, placeholder = "Message" }: { onSend: (text: string) => unknown; onRaise?: (text: string) => unknown; className?: string; autoFocus?: boolean; agent: string; draftKey: string; tools?: React.ReactNode; toolsOn?: boolean; placeholder?: string }) {
  const [draft, setDraft] = usePersistentDraft(draftKey);
  const [imageDraft, setImageDraft] = usePersistentDraft(`${draftKey}:images`);
  const images = imageDraft.split("\n").filter(Boolean);
  const setImages = (paths: string[]) => setImageDraft(paths.join("\n"));
  const [quote, setQuote] = usePersistentDraft(`${draftKey}:quote`);
  // With a quote in the box, he can send it to the top of Threads as a new thread instead of replying here (`onRaise`).
  const [raising, setRaising] = useState(false);
  if (raising && !quote) setRaising(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [emoji, setEmoji] = useState(false);
  const [more, setMore] = useState(false);
  const [formatting, setFormatting] = useState(formatShown);
  const toggleFormatting = () =>
    setFormatting(on => {
      try { localStorage.setItem(FORMAT_KEY, on ? "0" : "1"); } catch {}
      return !on;
    });
  // Quoted, he types next: the box takes focus with the caret after his text, and takes it again a frame later in case the
  // click that quoted (a menu closing, a selection clearing) hands focus back to where it came from.
  const take = (markdown: string) => {
    setQuote(prev => [prev, markdown].filter(Boolean).join("\n\n"));
    const focusEnd = () => {
      const el = input.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    };
    focusEnd();
    requestAnimationFrame(focusEnd);
  };
  useEventListener("composer-quote", e => {
    const { detail } = e as CustomEvent<{ draftKey: string; markdown: string }>;
    if (detail.draftKey !== draftKey) return;
    e.preventDefault();
    take(detail.markdown);
  });
  // A quote sent here before this box was on screen waits for it.
  const attachInput = useCallback(
    (el: HTMLTextAreaElement | null) => {
      input.current = el;
      const pending = el && waiting.get(draftKey);
      if (pending) waiting.delete(draftKey), take(pending);
    },
    [draftKey],
  );
  const mention = useMentionPicker(input, draft, setDraft, draftKey.match(/^thread:([\w-]+)$/)?.[1]);
  const emojiComplete = useEmojiComplete(input, draft, setDraft);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState("");

  async function attach(files: File[]) {
    if (!files.length) return;
    setUploading(n => n + files.length);
    try {
      const paths = await Promise.all(files.map(upload));
      setImageDraft(prev => [...prev.split("\n").filter(Boolean), ...paths].join("\n"));
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(n => n - files.length);
    }
  }

  const empty = !draft.trim() && !images.length && !quote;
  function send(e: React.FormEvent) {
    e.preventDefault();
    if (uploading || empty) return;
    if (raising && onRaise) onRaise([draft.trim(), quote, ...images.map(path => `![image](${path})`)].filter(Boolean).join("\n\n"));
    else onSend([quote && `${quote}\n`, draft.trim(), ...images.map(path => `![image](${path})`)].filter(Boolean).join("\n"));
    setRaising(false);
    setDraft("");
    setQuote("");
    setImages([]);
    setError("");
  }

  // An edit to the text at the selection, which stays selected (or the caret where the edit leaves it) and the box focused.
  function edit(change: (e: Edit) => Edit) {
    const el = input.current;
    if (!el) return;
    const next = change({ value: el.value, start: el.selectionStart, end: el.selectionEnd });
    setDraft(next.value);
    requestAnimationFrame(() => (el.focus(), el.setSelectionRange(next.start, next.end), mention.track()));
  }
  const insert = (text: string) => edit(({ value, start, end }) => ({ value: value.slice(0, start) + text + value.slice(end), start: start + text.length, end: start + text.length }));
  // An @ opens the thread picker only at a word's start.
  const at = () => edit(({ value, start, end }) => {
    const pad = start > 0 && !/\s/.test(value[start - 1]!) ? " @" : "@";
    return { value: value.slice(0, start) + pad + value.slice(end), start: start + pad.length, end: start + pad.length };
  });
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <form
      onSubmit={send}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        const files = imagesIn(e.dataTransfer.files);
        if (files.length) e.preventDefault(), void attach(files);
      }}
      className={cn("flex flex-col gap-1", className)}
    >
      <div data-composer className="relative flex flex-col rounded-xl border border-border bg-card transition-[border-color,box-shadow] focus-within:border-foreground/35 focus-within:shadow-[0_1px_6px_rgb(0_0_0/0.08)]">
        {formatting && (
        <div className="flex items-center gap-0.5 px-1.5 pt-1" data-agent={`${agent}-format`}>
          {FORMATS.map((f, i) => (
            <span key={f.label} className="contents">
              {(i === 3 || i === 4 || i === 6) && <span className="mx-1 h-4 w-px bg-border" />}
              <button type="button" tabIndex={-1} aria-label={f.label} title={f.keys ? `${f.label} (${f.keys})` : f.label} onMouseDown={keep} onClick={() => edit(f.apply)} className={tool}>
                <f.icon className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
        )}
        {(images.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-2" data-agent={`${agent}-images`}>
            {images.map((path, n) => (
              <div key={path} className="relative">
                <img src={preview(path)} alt="" className="h-20 max-w-40 rounded-lg border object-cover" />
                <button type="button" aria-label="Remove image" onClick={() => setImages(images.filter((_, m) => m !== n))} className="absolute top-1 right-1 rounded-full bg-card/90 p-0.5 hover:bg-muted">
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {uploading > 0 && <div className="flex h-20 w-20 items-center justify-center rounded-lg border text-xs text-muted-foreground">uploading…</div>}
          </div>
        )}
        {quote && (
          <div className="relative mx-3 mt-2 max-h-32 overflow-y-auto pr-6" data-agent={`${agent}-quote`}>
            <Markdown text={quote} className="text-xs" />
            <button type="button" aria-label="Remove quote" onClick={() => setQuote("")} className="absolute top-0 right-0 rounded-md p-0.5 hover:bg-muted">
              <X className="size-3" />
            </button>
          </div>
        )}
        {quote && onRaise && (
          <button
            type="button"
            data-agent={`${agent}-raise`}
            aria-pressed={raising}
            onMouseDown={e => e.preventDefault()}
            onClick={() => setRaising(r => !r)}
            className={cn("mx-3 mt-1.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs", raising ? "bg-link/10 text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
          >
            <ArrowUpToLine className="size-3" />
            {raising ? "Sends as a new thread in Threads" : "Post as a new thread"}
          </button>
        )}
        {/* The @ picker places itself by the caret, measured from the text's own top. */}
        <div className="relative">
        <textarea
          ref={attachInput}
          rows={1}
          autoFocus={autoFocus}
          data-agent={agent}
          value={draft}
          onChange={e => (setDraft(e.target.value), mention.track(), emojiComplete.track())}
          onSelect={() => (mention.track(), emojiComplete.track())}
          // The @ picker takes its keys first while it is open, then the formatting shortcuts. Enter sends, Shift+Enter is a new line;
          // Enter that confirms an IME composition is neither. Escape in an empty box leaves it, so the next Escape climbs a level.
          onKeyDown={e => {
            if (mention.onKeyDown(e) || emojiComplete.onKeyDown(e)) return;
            const f = formatFor(e);
            if (f) return e.preventDefault(), edit(f.apply);
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault(), e.currentTarget.form?.requestSubmit();
            else if (e.key === "Escape" && !draft) e.currentTarget.blur();
          }}
          onPaste={e => {
            const files = imagesIn(e.clipboardData.files);
            if (files.length) e.preventDefault(), void attach(files);
          }}
          placeholder={placeholder}
          // It grows with what he types, up to 40% of the window, then scrolls.
          className="block max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 [field-sizing:content] text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />
        {mention.panel}
        {emojiComplete.panel}
        </div>
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <button type="button" aria-label="Attach an image" title="Attach an image" onMouseDown={keep} onClick={() => fileInput.current?.click()} className={cn(tool, "rounded-full bg-muted/70")}>
            <Plus className="size-3.5" />
          </button>
          <button type="button" aria-label="Formatting" title={formatting ? "Hide formatting" : "Show formatting"} aria-pressed={formatting} onMouseDown={keep} onClick={toggleFormatting} className={tool}>
            <Type className="size-3.5" />
          </button>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={e => (void attach(imagesIn(e.target.files ?? undefined)), (e.target.value = ""))} />
          <span className="relative">
            <button type="button" aria-label="Emoji" title="Emoji" aria-expanded={emoji} onMouseDown={keep} onClick={() => setEmoji(o => !o)} className={tool}>
              <Smile className="size-3.5" />
            </button>
            {emoji && (
              <Popover onClose={() => setEmoji(false)} agent="composer-emoji">
                <EmojiPanel onPick={e => (insert(e), setEmoji(false))} />
              </Popover>
            )}
          </span>
          <button type="button" aria-label="Mention an agent or thread" title="Mention an agent or thread (@)" onMouseDown={keep} onClick={at} className={tool}>
            <AtSign className="size-3.5" />
          </button>
          {tools && (
            <span className="relative">
              <button type="button" aria-label="More" title="More" aria-expanded={more} onMouseDown={keep} onClick={() => setMore(o => !o)} className={cn(tool, toolsOn && "text-link")}>
                <Ellipsis className="size-3.5" />
              </button>
              {more && <Popover onClose={() => setMore(false)} className="w-72 p-1">{tools}</Popover>}
            </span>
          )}
          <button type="submit" aria-label="Send" title="Send (Return)" disabled={empty || uploading > 0} onMouseDown={keep} className="ml-auto flex h-7 w-8 items-center justify-center rounded-md bg-ok text-white transition-colors disabled:bg-transparent disabled:text-muted-foreground/50">
            <SendHorizontal className="size-3.5" />
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

/** A small panel above a bottom-row button, closed by a click elsewhere or Esc. */
function Popover({ onClose, className, children, agent }: { onClose: () => void; className?: string; children: React.ReactNode; agent?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEventListener("mousedown", e => ref.current && !ref.current.parentElement?.contains(e.target as Node) && onClose());
  useEventListener("keydown", e => e.key === "Escape" && onClose());
  return (
    <div ref={ref} data-agent={agent} className={cn("absolute bottom-9 left-0 z-20 rounded-xl border bg-card shadow-card", className)}>
      {children}
    </div>
  );
}
