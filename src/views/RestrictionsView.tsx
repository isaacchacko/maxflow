import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Call, Mode, Restriction } from "../../restrictions";
import { cn } from "@/lib/utils";
import { liveStore, objectiveStore } from "@/store";
import { useLayerScroll } from "@/threads/jump";

// His autonomy restrictions: for each kind of action his agents take, whether they do it on their own, ask him first, or never do
// it. The catalog comes seeded; he edits builtins, adds his own, and scopes one to an objective or a folder to override the rest.

const MODES: { mode: Mode; label: string; on: string }[] = [
  { mode: "allow", label: "Allow", on: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  { mode: "ask", label: "Ask me", on: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  { mode: "deny", label: "Block", on: "bg-red-500/15 text-red-700 dark:text-red-400" },
];
const KINDS: Record<string, string> = {
  message: "Message people",
  review: "Pull requests",
  approve: "Pull requests",
  merge: "Pull requests",
  reviewers: "Pull requests",
  pr: "Pull requests",
  push: "Push",
  jobs: "Start jobs and deploys",
  linear: "Linear",
  delete: "Delete",
  processes: "Processes",
  money: "Spend money",
};
const kindLabel = (action: string) => KINDS[action] ?? action.charAt(0).toUpperCase() + action.slice(1);

async function send(path: string, method: string, body?: unknown) {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.status === 204 ? null : res.json();
}

export function RestrictionsView() {
  const live = liveStore.use();
  const [list, setList] = useState<Restriction[]>([]);
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayerScroll("restrictions", scrollRef);
  const load = async () => liveStore.get() && setList(await send("/api/restrictions", "GET"));
  useEffect(() => void load(), [live]);

  // A change shows at once; one the server refuses is put back by fetching the list again, and the error is thrown to the editor.
  const edit = async (id: string, change: Partial<Restriction>) => {
    setList(all => all.map(r => (r.id === id ? { ...r, ...change } : r)));
    try {
      await send(`/api/restrictions/${id}`, "PATCH", change);
    } catch (e) {
      await load();
      throw e;
    }
  };
  const remove = async (id: string) => {
    setList(all => all.filter(r => r.id !== id));
    await send(`/api/restrictions/${id}`, "DELETE").catch(load);
  };
  const add = async (r: Partial<Restriction>) => {
    const saved = (await send("/api/restrictions", "POST", r)) as Restriction;
    setList(all => [...all, saved]);
    setAdding(false);
  };

  // Kinds in the catalog's order, then his own in the order he added them; the PR kinds share one section.
  const kinds = [...new Set(list.map(r => r.action))];
  const sections = [...new Set(kinds.map(kindLabel))];
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-5">
        <h1 className="text-sm font-medium">Restrictions</h1>
        <button onClick={() => setAdding(true)} className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
          <Plus className="size-4" /> New restriction
        </button>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-4">
          <p className="mb-4 px-2.5 text-[13px] text-muted-foreground">
            What your agents do on their own, ask you about first, or never do. One scoped to an objective or a folder beats one that applies everywhere; among equals, the strictest wins.
          </p>
          <Tester />
          {adding && (
            <section className="mb-5 rounded-xl border p-3">
              <Editor kinds={kinds} onSave={add} onCancel={() => setAdding(false)} />
            </section>
          )}
          {sections.map(section => (
            <section key={section} className="mb-5">
              <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">{section}</h2>
              <ol className="flex flex-col">
                {list
                  .filter(r => kindLabel(r.action) === section)
                  .map(r => (
                    <Row key={r.id} r={r} kinds={kinds} open={open === r.id} onToggle={() => setOpen(open === r.id ? undefined : r.id)} onEdit={c => edit(r.id, c)} onDelete={() => void remove(r.id)} />
                  ))}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ r, kinds, open, onToggle, onEdit, onDelete }: { r: Restriction; kinds: string[]; open: boolean; onToggle: () => void; onEdit: (c: Partial<Restriction>) => Promise<void>; onDelete: () => void }) {
  const objectives = objectiveStore.use();
  const scope = [r.scope?.objective && (objectives.find(o => o.id === r.scope!.objective)?.title ?? r.scope.objective), r.scope?.cwd].filter(Boolean);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li data-row={`restriction/${r.id}`}>
      <div className={cn("group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted/60", open && "bg-muted/60")}>
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Chevron className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{r.label}</span>
          {!r.builtin && <span className="shrink-0 rounded bg-muted px-1.5 text-[11px] text-muted-foreground">Custom</span>}
          {scope.map(s => (
            <span key={s} className="max-w-48 shrink-0 truncate rounded bg-muted px-1.5 text-[11px] text-muted-foreground">{s}</span>
          ))}
        </button>
        <ModeToggle mode={r.mode} onChange={mode => void onEdit({ mode })} />
      </div>
      {open && (
        <div className="mb-2 ml-[26px] rounded-xl border p-3">
          <Editor key={JSON.stringify(r)} r={r} kinds={kinds} onSave={onEdit} onCancel={onToggle} onDelete={onDelete} />
        </div>
      )}
    </li>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div role="radiogroup" className="flex shrink-0 rounded-md border p-0.5 text-xs">
      {MODES.map(m => (
        <button
          key={m.mode}
          role="radio"
          aria-checked={mode === m.mode}
          onClick={() => mode !== m.mode && onChange(m.mode)}
          className={cn("rounded px-2 py-0.5 font-medium", mode === m.mode ? m.on : "text-muted-foreground hover:text-foreground")}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

const lines = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean);
const field = "w-full rounded-md border bg-transparent px-2 py-1 text-sm outline-none focus:border-foreground/30";

/** Edits a restriction, or makes a new one when there is none. Matchers are one regex a line. */
function Editor({ r, kinds, onSave, onCancel, onDelete }: { r?: Restriction; kinds: string[]; onSave: (r: Partial<Restriction>) => Promise<void>; onCancel: () => void; onDelete?: () => void }) {
  const objectives = objectiveStore.use();
  const [label, setLabel] = useState(r?.label ?? "");
  const [action, setAction] = useState(r?.action ?? "");
  const [mode, setMode] = useState<Mode>(r?.mode ?? "ask");
  const [tools, setTools] = useState((r?.match.tools ?? []).join("\n"));
  const [bash, setBash] = useState((r?.match.bash ?? []).join("\n"));
  const [objective, setObjective] = useState(r?.scope?.objective ?? "");
  const [cwd, setCwd] = useState(r?.scope?.cwd ?? "");
  const [note, setNote] = useState(r?.note ?? "");
  const [error, setError] = useState<string>();
  const save = async () => {
    const scope = objective || cwd.trim() ? { ...(objective && { objective }), ...(cwd.trim() && { cwd: cwd.trim() }) } : undefined;
    try {
      setError(undefined);
      await onSave({ label: label.trim(), action: action.trim().toLowerCase(), mode, match: { tools: lines(tools), bash: lines(bash) }, scope, note: note.trim() || undefined });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">What it is</span>
          <input autoFocus={!r} value={label} onChange={e => setLabel(e.target.value)} placeholder="Post in a customer channel" className={field} />
        </label>
        <label className="flex w-44 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Kind</span>
          <input value={action} onChange={e => setAction(e.target.value)} list="restriction-kinds" placeholder="message" className={field} />
          <datalist id="restriction-kinds">
            {kinds.map(k => (
              <option key={k} value={k}>{kindLabel(k)}</option>
            ))}
          </datalist>
        </label>
      </div>
      {!r && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Mode</span>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
      )}
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Tools, one regex a line, matching the whole tool name</span>
          <textarea value={tools} onChange={e => setTools(e.target.value)} rows={Math.max(2, lines(tools).length)} placeholder="mcp__claude_ai_Slack__slack_send_message" className={cn(field, "resize-y font-mono text-xs")} />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Bash commands, one regex a line, found anywhere in the command</span>
          <textarea value={bash} onChange={e => setBash(e.target.value)} rows={Math.max(2, lines(bash).length)} placeholder="\bgh\s+pr\s+merge\b" className={cn(field, "resize-y font-mono text-xs")} />
        </label>
      </div>
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Only on objective</span>
          <select value={objective} onChange={e => setObjective(e.target.value)} className={field}>
            <option value="">Any objective</option>
            {objectives.map(o => (
              <option key={o.id} value={o.id}>{o.title}</option>
            ))}
            {objective && !objectives.some(o => o.id === objective) && <option value={objective}>{objective}</option>}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Only under folder</span>
          <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="Anywhere, or ~/Programs/arch" className={cn(field, "font-mono text-xs")} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Note</span>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Why it's set this way" className={cn(field, "resize-y")} />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <button onClick={() => void save()} className="rounded-md bg-primary px-3 py-1 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
          {r ? "Save" : "Add restriction"}
        </button>
        <button onClick={onCancel} className="rounded-md px-3 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
          Cancel
        </button>
        {r?.builtin && <span className="text-xs text-muted-foreground">Built in</span>}
        {onDelete && (
          <button onClick={onDelete} title="Delete" className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-destructive">
            <Trash2 className="size-4" /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

/** Which restriction a command or tool would hit, the way the enforcement hook decides it. A word with no spaces is a tool name. */
function Tester() {
  const [text, setText] = useState("");
  const [verdict, setVerdict] = useState<{ mode: Mode; restriction?: Restriction }>();
  useEffect(() => {
    const t = text.trim();
    if (!t || !liveStore.get()) return setVerdict(undefined);
    const call: Call = /^[\w-]+$/.test(t) && t !== t.toLowerCase() || t.startsWith("mcp__") ? { tool: t } : { tool: "Bash", input: { command: t } };
    const timer = setTimeout(() => void send("/api/restrictions/check", "POST", call).then(setVerdict, () => setVerdict(undefined)), 150);
    return () => clearTimeout(timer);
  }, [text]);
  const m = verdict && MODES.find(x => x.mode === verdict.mode)!;
  return (
    <div className="mb-5 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 focus-within:bg-muted/60">
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Try a command or tool name: gh pr merge 12 --auto" className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground" />
      {m && (
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("rounded px-2 py-0.5 font-medium", m.on)}>{m.label}</span>
          {verdict.restriction?.label ?? "nothing matches"}
        </span>
      )}
    </div>
  );
}
