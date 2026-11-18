import { AtSign, Bold, Code, Italic, Link2, List, ListOrdered, Plus, SendHorizontal, Smile, SquareCode, Strikethrough, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";
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

// The emoji a click puts in, the ones people reach for.
const EMOJI = "👍 👎 🙏 🙌 👏 👀 🎉 🚀 🔥 ✅ ❌ ⚠️ 💯 ❤️ 😄 😂 😅 🙂 😉 🤔 😬 😭 😱 🤯 🫠 🫡 🤝 💪 👋 ☕ 💡 🐛 🛠️ 📌 📝 ⏳".split(" ");

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

type Format = { label: string; keys: string; icon: React.ComponentType<{ className?: string }>; apply: (e: Edit) => Edit };
const FORMATS: Format[] = [
  { label: "Bold", keys: "⌘B", icon: Bold, apply: e => wrap(e, "**") },
  { label: "Italic", keys: "⌘I", icon: Italic, apply: e => wrap(e, "_") },
  { label: "Strikethrough", keys: "⌘⇧X", icon: Strikethrough, apply: e => wrap(e, "~~") },
  { label: "Link", keys: "⌘K", icon: Link2, apply: link },
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
    : e.altKey ? undefined : ({ b: "Bold", i: "Italic", k: "Link" } as Record<string, string>)[k];
  return FORMATS.find(f => f.label === name);
}

const tool = "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground";

/**
 * A message box drawn as Slack's: one rounded box that lights up while focused, a formatting row on top that wraps the selection in
 * markdown (and its shortcuts, ⌘K among them only while the box has focus), the text, and a bottom row to attach an image, pick an
 * emoji, mention a thread, the box's own `tools` (a thread's subthread nudge) and send. It grows with its text up to 40% of the
 * window, and takes images pasted or dropped on it: each is uploaded at once, and its path is kept with the draft so a reload keeps it.
 */
export function Composer({ onSend, className, autoFocus, agent, draftKey, tools, placeholder = "Message" }: { onSend: (text: string) => unknown; className?: string; autoFocus?: boolean; agent: string; draftKey: string; tools?: React.ReactNode; placeholder?: string }) {
  const [draft, setDraft] = usePersistentDraft(draftKey);
  const [imageDraft, setImageDraft] = usePersistentDraft(`${draftKey}:images`);
  const images = imageDraft.split("\n").filter(Boolean);
  const setImages = (paths: string[]) => setImageDraft(paths.join("\n"));
  const [quote, setQuote] = usePersistentDraft(`${draftKey}:quote`);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [emoji, setEmoji] = useState(false);
  // It grows with what he types, up to 40% of the window, then scrolls.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, innerHeight * 0.4)}px`;
  }, [draft]);
  useEffect(() => {
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
    const onQuote = (e: Event) => {
      const { detail } = e as CustomEvent<{ draftKey: string; markdown: string }>;
      if (detail.draftKey !== draftKey) return;
      e.preventDefault();
      take(detail.markdown);
    };
    const pending = waiting.get(draftKey);
    if (pending) waiting.delete(draftKey), take(pending);
    addEventListener("composer-quote", onQuote);
    return () => removeEventListener("composer-quote", onQuote);
  }, [draftKey]);
  const mention = useMentionPicker(input, draft, setDraft, draftKey.match(/^thread:([\w-]+)$/)?.[1]);
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
    onSend([quote && `${quote}\n`, draft.trim(), ...images.map(path => `![image](${path})`)].filter(Boolean).join("\n"));
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
        <div className="flex items-center gap-0.5 px-1.5 pt-1" data-agent={`${agent}-format`}>
          {FORMATS.map((f, i) => (
            <span key={f.label} className="contents">
              {(i === 3 || i === 4 || i === 6) && <span className="mx-1 h-4 w-px bg-border" />}
              <button type="button" tabIndex={-1} aria-label={f.label} title={`${f.label} (${f.keys})`} onMouseDown={keep} onClick={() => edit(f.apply)} className={tool}>
                <f.icon className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
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
        {/* The @ picker places itself by the caret, measured from the text's own top. */}
        <div className="relative">
        <textarea
          ref={input}
          rows={1}
          autoFocus={autoFocus}
          data-agent={agent}
          value={draft}
          onChange={e => (setDraft(e.target.value), mention.track())}
          onSelect={mention.track}
          // The @ picker takes its keys first while it is open, then the formatting shortcuts. Enter sends, Shift+Enter is a new line;
          // Enter that confirms an IME composition is neither. Escape in an empty box leaves it, back to the keys that move through the page.
          onKeyDown={e => {
            if (mention.onKeyDown(e)) return;
            const f = formatFor(e);
            // ⌘K here is the link, not the switcher, which listens on the window first and leaves a key from this box alone.
            if (f) return e.preventDefault(), edit(f.apply);
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault(), e.currentTarget.form?.requestSubmit();
            else if (e.key === "Escape" && !draft) e.currentTarget.blur();
          }}
          onPaste={e => {
            const files = imagesIn(e.clipboardData.files);
            if (files.length) e.preventDefault(), void attach(files);
          }}
          placeholder={placeholder}
          className="block w-full resize-none overflow-y-auto bg-transparent px-3 py-1.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />
        {mention.panel}
        </div>
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <button type="button" aria-label="Attach an image" title="Attach an image" onMouseDown={keep} onClick={() => fileInput.current?.click()} className={cn(tool, "rounded-full bg-muted/70")}>
            <Plus className="size-4" />
          </button>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={e => (void attach(imagesIn(e.target.files ?? undefined)), (e.target.value = ""))} />
          <span className="relative">
            <button type="button" aria-label="Emoji" title="Emoji" aria-expanded={emoji} onMouseDown={keep} onClick={() => setEmoji(o => !o)} className={tool}>
              <Smile className="size-4" />
            </button>
            {emoji && <EmojiPicker onPick={e => (insert(e), setEmoji(false))} onClose={() => setEmoji(false)} />}
          </span>
          <button type="button" aria-label="Mention a thread" title="Mention a thread (@)" onMouseDown={keep} onClick={at} className={tool}>
            <AtSign className="size-4" />
          </button>
          {tools}
          <span className="ml-auto truncate px-2 text-[11px] text-muted-foreground/70">{draft && <><b className="font-semibold">Shift + Return</b> for a new line</>}</span>
          <button type="submit" aria-label="Send" title="Send (Return)" disabled={empty || uploading > 0} onMouseDown={keep} className="flex h-7 w-8 items-center justify-center rounded-md bg-ok text-white transition-colors disabled:bg-transparent disabled:text-muted-foreground/50">
            <SendHorizontal className="size-4" />
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("mousedown", away);
    addEventListener("keydown", esc);
    return () => (removeEventListener("mousedown", away), removeEventListener("keydown", esc));
  }, [onClose]);
  return (
    <div ref={ref} data-agent="composer-emoji" className="absolute bottom-9 left-0 z-20 grid w-64 grid-cols-8 gap-0.5 rounded-xl border bg-card p-1.5 shadow-card">
      {EMOJI.map(e => (
        <button key={e} type="button" onMouseDown={ev => ev.preventDefault()} onClick={() => onPick(e)} className="flex size-7 items-center justify-center rounded-md text-base hover:bg-muted">
          {e}
        </button>
      ))}
    </div>
  );
}
