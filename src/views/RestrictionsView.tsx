import { ChevronDown, ChevronRight, CornerDownRight, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Call, Mode, Person, Restriction } from "../../restrictions";
import { cn } from "@/lib/utils";
import { liveStore, objectiveStore } from "@/store";
import { useLayerScroll } from "@/threads/jump";

// His autonomy restrictions: for each kind of action his agents take, whether they do it on their own, ask him first, or never do
// it. The catalog comes seeded; he edits builtins, adds his own, and overrides one for some people, an objective or a folder,
// shown nested under it.

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
    return saved;
  };

  // Kinds in the catalog's order, then his own in the order he added them; the PR kinds share one section.
  const kinds = [...new Set(list.map(r => r.action))];
  const tops = list.filter(r => !r.parent);
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
            What your agents do on their own, ask you about first, or never do. Override one for some people, an objective or a folder, and the override wins where it applies: a person named beats teammates, which beats an objective, which beats a folder. Among equals, and across everyone a call reaches, the strictest wins.
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
                {tops
                  .filter(r => kindLabel(r.action) === section)
                  .map(r => (
                    <Row key={r.id} r={r} kinds={kinds} open={open} setOpen={setOpen} overrides={list.filter(o => o.parent === r.id)} onEdit={edit} onDelete={id => void remove(id)} onAdd={add} />
                  ))}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

const chip = "max-w-48 shrink-0 truncate rounded bg-muted px-1.5 text-[11px] text-muted-foreground";
const personName = (p: Person) => (p.team ? "Teammates" : p.name || p.email || p.github || p.slack!);

/** What a restriction is narrowed to: its people, objective and folder, as chips. */
function ScopeChips({ r }: { r: Restriction }) {
  const objectives = objectiveStore.use();
  const chips = [...(r.scope?.people ?? []).map(personName), r.scope?.objective && (objectives.find(o => o.id === r.scope!.objective)?.title ?? r.scope.objective), r.scope?.cwd].filter(Boolean) as string[];
  return chips.map(c => (
    <span key={c} className={chip}>
      {c}
    </span>
  ));
}

type RowProps = { r: Restriction; kinds: string[]; open?: string; setOpen: (id?: string) => void; overrides: Restriction[]; onEdit: (id: string, c: Partial<Restriction>) => Promise<void>; onDelete: (id: string) => void; onAdd: (r: Partial<Restriction>) => Promise<Restriction> };

/** A restriction, with its overrides indented under it; the person icon on hover adds one. */
function Row({ r, kinds, open, setOpen, overrides, onEdit, onDelete, onAdd }: RowProps) {
  const [adding, setAdding] = useState(false);
  const toggle = (id: string) => setOpen(open === id ? undefined : id);
  const Chevron = open === r.id ? ChevronDown : ChevronRight;
  return (
    <li data-row={`restriction/${r.id}`}>
      <div className={cn("group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted/60", open === r.id && "bg-muted/60")}>
        <button onClick={() => toggle(r.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Chevron className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{r.label}</span>
          {!r.builtin && <span className={chip}>Custom</span>}
          <ScopeChips r={r} />
        </button>
        <button onClick={() => setAdding(true)} title="Override it for some people, an objective or a folder" className={cn("shrink-0 text-muted-foreground hover:text-foreground", !adding && "opacity-0 group-hover:opacity-100")}>
          <UserPlus className="size-4" />
        </button>
        <ModeToggle mode={r.mode} onChange={mode => void onEdit(r.id, { mode })} />
      </div>
      {open === r.id && (
        <div className="mb-2 ml-[26px] rounded-xl border p-3">
          <Editor key={JSON.stringify(r)} r={r} kinds={kinds} onSave={c => onEdit(r.id, c)} onCancel={() => toggle(r.id)} onDelete={() => onDelete(r.id)} />
        </div>
      )}
      {(overrides.length > 0 || adding) && (
        <ol className="ml-[26px] flex flex-col">
          {overrides.map(o => (
            <li key={o.id} data-row={`restriction/${o.id}`}>
              <div className={cn("group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1 text-[13px] hover:bg-muted/60", open === o.id && "bg-muted/60")}>
                <button onClick={() => toggle(o.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-muted-foreground">For</span>
                  <ScopeChips r={o} />
                  {o.label !== r.label && <span className="truncate text-muted-foreground">{o.label}</span>}
                </button>
                <ModeToggle mode={o.mode} onChange={mode => void onEdit(o.id, { mode })} />
              </div>
              {open === o.id && (
                <div className="mb-2 ml-[22px] rounded-xl border p-3">
                  <Editor key={JSON.stringify(o)} r={o} override kinds={kinds} onSave={c => onEdit(o.id, c)} onCancel={() => toggle(o.id)} onDelete={() => onDelete(o.id)} />
                </div>
              )}
            </li>
          ))}
          {adding && (
            <li className="mb-2 rounded-xl border p-3">
              <Editor override kinds={kinds} initialMode={r.mode === "allow" ? "ask" : "allow"} onSave={async c => void (await onAdd({ ...c, parent: r.id }), setAdding(false))} onCancel={() => setAdding(false)} />
            </li>
          )}
        </ol>
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

/**
 * Edits a restriction, or makes a new one when there is none. Matchers are one regex a line. An override has no label, kind or
 * matchers of its own: it is who and where its parent is set differently for.
 */
function Editor({ r, override, initialMode, kinds, onSave, onCancel, onDelete }: { r?: Restriction; override?: boolean; initialMode?: Mode; kinds: string[]; onSave: (r: Partial<Restriction>) => Promise<void>; onCancel: () => void; onDelete?: () => void }) {
  const objectives = objectiveStore.use();
  const [label, setLabel] = useState(r?.label ?? "");
  const [action, setAction] = useState(r?.action ?? "");
  const [mode, setMode] = useState<Mode>(r?.mode ?? initialMode ?? "ask");
  const [people, setPeople] = useState<Person[]>(r?.scope?.people ?? []);
  const [tools, setTools] = useState((r?.match.tools ?? []).join("\n"));
  const [bash, setBash] = useState((r?.match.bash ?? []).join("\n"));
  const [objective, setObjective] = useState(r?.scope?.objective ?? "");
  const [cwd, setCwd] = useState(r?.scope?.cwd ?? "");
  const [note, setNote] = useState(r?.note ?? "");
  const [error, setError] = useState<string>();
  const save = async () => {
    const scope = objective || cwd.trim() || people.length ? { ...(objective && { objective }), ...(cwd.trim() && { cwd: cwd.trim() }), ...(people.length && { people }) } : undefined;
    try {
      setError(undefined);
      await onSave(override ? { mode, scope, note: note.trim() || undefined } : { label: label.trim(), action: action.trim().toLowerCase(), mode, match: { tools: lines(tools), bash: lines(bash) }, scope, note: note.trim() || undefined });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      {!override && (
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
      )}
      {!r && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Mode</span>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
      )}
      {!override && (
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
      )}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Only for people{override ? "" : " (leave empty for everyone)"}</span>
        <PeoplePicker people={people} onChange={setPeople} />
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
          {r ? "Save" : override ? "Add override" : "Add restriction"}
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

// The people the slack and gh sentries know, fetched once a page load.
let known: Promise<Person[]> | undefined;
const knownPeople = () => (known ??= send("/api/restrictions/people", "GET").catch(() => ((known = undefined), [])));

/**
 * Picks people: type to search the Slack users and GitHub logins yarn has seen, Enter or a click adds one; an address with
 * an @ adds that email, and Teammates stands for everyone on the team.
 */
function PeoplePicker({ people, onChange }: { people: Person[]; onChange: (p: Person[]) => void }) {
  const [all, setAll] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => void knownPeople().then(setAll), []);
  const q = query.trim().toLowerCase();
  const picked = (p: Person) => people.some(o => (p.team ? o.team : personName(o) === personName(p)));
  const offers: Person[] = q
    ? [
        ...("teammates".includes(q) ? [{ team: true, name: "Teammates" }] : []),
        ...all.filter(p => [p.name, p.github, p.email].some(x => x?.toLowerCase().includes(q))).slice(0, 6),
        ...(/^\S+@\S+\.\S+$/.test(q) ? [{ name: q, email: q }] : []),
        ...(/^[\w-]+$/.test(q) && !all.some(p => p.github?.toLowerCase() === q) ? [{ name: q, github: q }] : []),
      ].filter(p => !picked(p))
    : [];
  const add = (p: Person) => (onChange([...people, p]), setQuery(""));
  return (
    <div className="relative">
      <div className={cn(field, "flex flex-wrap items-center gap-1")}>
        {people.map(p => (
          <span key={personName(p)} className="flex items-center gap-1 rounded bg-muted px-1.5 text-xs">
            {p.team && <Users className="size-3" />}
            {personName(p)}
            {!p.team && <span className="text-muted-foreground">{p.slack ? "Slack" : p.email ? "email" : "GitHub"}</span>}
            <button onClick={() => onChange(people.filter(o => o !== p))} title="Remove" className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && offers[0]) e.preventDefault(), add(offers[0]);
            if (e.key === "Backspace" && !query && people.length) onChange(people.slice(0, -1));
          }}
          placeholder={people.length ? "" : "A name, an email, a GitHub login, or teammates"}
          className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {offers.length > 0 && (
        <ol className="absolute inset-x-0 top-full z-10 mt-1 rounded-lg border bg-popover p-1 shadow-raised">
          {offers.map(p => (
            <li key={`${personName(p)}-${p.slack ?? p.email ?? p.github ?? "team"}`}>
              <button onClick={() => add(p)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted">
                {p.team && <Users className="size-3.5" />}
                {personName(p)}
                <span className="text-xs text-muted-foreground">{p.team ? "everyone on the team" : p.slack ? "Slack" : p.email ? "email" : "GitHub"}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
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
