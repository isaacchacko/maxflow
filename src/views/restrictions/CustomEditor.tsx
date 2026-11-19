import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useResource, useSettled } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { liveStore } from "@/store";
import { ago } from "@/threads/Replies";
import type { Call, Mode, Restriction } from "../../../shared/restrictions-types";
import { checkCall, previewMatch, type Preview, type Verdict } from "./api";
import { MODE_LOOK, ModeToggle, field, messageOf } from "./look";

const TYPING_SETTLES_MS = 300;
const CHECK_AFTER_TYPING_MS = 150;

const lines = (text: string) =>
  text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

function PreviewBox({ preview }: { preview: Preview | string | undefined }) {
  if (preview === undefined) return <span className="text-muted-foreground">Add a pattern to see which of your agents' recent tool calls it would catch.</span>;
  if (typeof preview === "string") return <span className="text-destructive">{preview}</span>;
  return (
    <>
      <p className={cn("mb-1 font-medium", preview.count === 0 && "text-muted-foreground")}>
        Would have caught {preview.count} of the last {preview.checked} tool calls{preview.count > 0 ? ":" : "."}
      </p>
      <ol className="flex flex-col gap-0.5">
        {preview.caught.map((c, i) => (
          <li key={i} className="flex min-w-0 gap-2">
            <span className="min-w-0 flex-1 truncate font-mono">{c.text}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{hasText(c.at) && ago(Date.parse(c.at))}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function usePreviewWhileTyping(match: { tools: string[]; bash: string[] }) {
  const isEmpty = match.tools.length === 0 && match.bash.length === 0;
  const asked = useSettled(JSON.stringify(match), TYPING_SETTLES_MS);
  const previewed = useResource(isEmpty ? undefined : `preview:${asked}`, async () => {
    const settledMatch: unknown = JSON.parse(asked);
    return previewMatch(settledMatch);
  });
  const answer = previewed.error?.message ?? previewed.value;
  const [lastAnswer, setLastAnswer] = useState<Preview | string>();
  if (answer !== undefined && answer !== lastAnswer) setLastAnswer(answer);
  return isEmpty ? undefined : lastAnswer;
}

function Patterns({ tools, onTools, bash, onBash }: { tools: string; onTools: (v: string) => void; bash: string; onBash: (v: string) => void }) {
  return (
    <div className="flex gap-3">
      <label className="flex flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">Tool names it catches, one pattern a line (the whole name must match)</span>
        <textarea value={tools} onChange={e => onTools(e.target.value)} rows={2} className={cn(field, "resize-y font-mono text-xs")} />
      </label>
      <label className="flex flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">Shell commands it catches, one pattern a line (matched where a command starts, so a file named pkill.md isn't pkill)</span>
        <textarea value={bash} onChange={e => onBash(e.target.value)} rows={2} className={cn(field, "resize-y font-mono text-xs")} />
      </label>
    </div>
  );
}

type EditorProps = { r?: Restriction; onSave: (c: Partial<Restriction>) => Promise<unknown>; onCancel: () => void; onDelete?: () => void };

function EditorButtons({ r, onSave, onCancel, onDelete }: { r: Restriction | undefined; onSave: () => void; onCancel: () => void; onDelete: (() => void) | undefined }) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={onSave} className="rounded-md bg-primary px-3 py-1 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
        {r ? "Save" : "Add rule"}
      </button>
      <button onClick={onCancel} className="rounded-md px-3 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
        Cancel
      </button>
      {onDelete && (
        <button onClick={onDelete} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-destructive">
          <Trash2 className="size-4" /> Delete
        </button>
      )}
    </div>
  );
}

const BLANK_RULE = { label: "", about: "", mode: "ask" as const, tools: "", bash: "" };
const onePatternALine = (patterns: string[] | undefined) => (patterns ?? []).join("\n");

function draftFrom(r: Restriction | undefined) {
  if (!r) return BLANK_RULE;
  return { label: r.label, about: r.about ?? r.note ?? "", mode: r.mode, tools: onePatternALine(r.match.tools), bash: onePatternALine(r.match.bash) };
}

export function CustomEditor({ r, onSave, onCancel, onDelete }: EditorProps) {
  const [initial] = useState(() => draftFrom(r));
  const [label, setLabel] = useState(initial.label);
  const [about, setAbout] = useState(initial.about);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [tools, setTools] = useState(initial.tools);
  const [bash, setBash] = useState(initial.bash);
  const [error, setError] = useState<string>();
  const match = { tools: lines(tools), bash: lines(bash) };
  const preview = usePreviewWhileTyping(match);
  const save = async () => {
    try {
      setError(undefined);
      await onSave({ label: label.trim(), about: hasText(about.trim()) ? about.trim() : undefined, mode, match });
    } catch (error_) {
      setError(messageOf(error_));
    }
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Name</span>
        <input autoFocus={!r} value={label} onChange={e => setLabel(e.target.value)} placeholder="Apply Terraform changes" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">What it covers, in your words</span>
        <input value={about} onChange={e => setAbout(e.target.value)} placeholder="Changing cloud infrastructure with terraform apply" className={field} />
      </label>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Setting</span>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <Patterns tools={tools} onTools={setTools} bash={bash} onBash={setBash} />
      <div className="rounded-lg bg-muted/50 px-2.5 py-2 text-xs">
        <PreviewBox preview={preview} />
      </div>
      {hasText(error) && <p className="text-xs text-destructive">{error}</p>}
      <EditorButtons
        r={r}
        onSave={() => {
          void save();
        }}
        onCancel={onCancel}
        onDelete={onDelete}
      />
    </div>
  );
}

const isToolName = (t: string) => (/^[\w-]+$/.test(t) && t !== t.toLowerCase()) || t.startsWith("mcp__");
const callFor = (t: string): Call => (isToolName(t) ? { tool: t } : { tool: "Bash", input: { command: t } });

function Tester() {
  const [text, setText] = useState("");
  const [verdict, setVerdict] = useState<Verdict>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const check = async (call: Call) => {
    try {
      setVerdict(await checkCall(call));
    } catch {
      setVerdict(undefined);
    }
  };
  const type = (next: string) => {
    setText(next);
    clearTimeout(timer.current);
    const t = next.trim();
    if (!t || !liveStore.get()) {
      setVerdict(undefined);
      return;
    }
    timer.current = setTimeout(() => {
      void check(callFor(t));
    }, CHECK_AFTER_TYPING_MS);
  };
  const m = verdict && MODE_LOOK[verdict.mode];
  return (
    <div className="mb-5 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 focus-within:bg-muted/60">
      <input value={text} onChange={e => type(e.target.value)} placeholder="Try a command or tool name: gh pr merge 12 --auto" className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground" />
      {m && (
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("rounded px-2 py-0.5 font-medium", m.on)}>{m.label}</span>
          {verdict.restriction?.label ?? "nothing matches"}
        </span>
      )}
    </div>
  );
}

export function Advanced({ onAdd }: { onAdd: (r: Partial<Restriction>) => Promise<Restriction> }) {
  const [isOpen, setOpen] = useState(false);
  const [isWriting, setWriting] = useState(false);
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <section className="mb-6 border-t pt-4">
      <button onClick={() => setOpen(!isOpen)} className="flex items-center gap-1.5 px-2.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
        <Chevron className="size-4" /> Advanced
      </button>
      {isOpen && (
        <div className="mt-2 flex flex-col gap-3 px-2.5">
          <p className="text-[13px] text-muted-foreground">For something the actions above don't cover: a rule that matches tools or shell commands by pattern. Test where a command lands, or write a rule.</p>
          <Tester />
          {isWriting ? (
            <div className="rounded-xl border p-3">
              <CustomEditor
                onSave={async c => {
                  await onAdd({ ...c, action: "custom" });
                  setWriting(false);
                }}
                onCancel={() => setWriting(false)}
              />
            </div>
          ) : (
            <button onClick={() => setWriting(true)} className="flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
              <Plus className="size-4" /> Write a custom rule
            </button>
          )}
        </div>
      )}
    </section>
  );
}
