import { ChevronDown, ChevronRight, CornerDownRight, Globe, Link2, Plus, RotateCcw, SlidersHorizontal, Trash2, Unlink, UserPlus, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Call, Mode, Person, Reach, Restriction } from "../../restrictions";
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
  // The tab is in the address (#restrictions/people), so it survives a reload and can be linked to.
  const [tab, setTabState] = useState<"actions" | "people">(location.hash === "#restrictions/people" ? "people" : "actions");
  const setTab = (t: "actions" | "people") => (setTabState(t), history.replaceState(history.state, "", t === "people" ? "#restrictions/people" : "#restrictions"));
  useEffect(() => {
    const follow = () => location.hash.startsWith("#restrictions") && setTabState(location.hash === "#restrictions/people" ? "people" : "actions");
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
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
        <div className="ml-4 flex gap-0.5">
          {(["actions", "people"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={cn("rounded-md px-2 py-1 text-[13px]", tab === t ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              {t === "actions" ? "Actions" : "People"}
            </button>
          ))}
        </div>
        <button onClick={() => (setTab("actions"), setAdding(true))} className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
          <Plus className="size-4" /> New restriction
        </button>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-4">
          <p className="mb-4 px-2.5 text-[13px] text-muted-foreground">
            What your agents do on their own, ask you about first, or never do. Override one for some people, an objective or a folder, and the override wins where it applies: a person named beats teammates, which beats an objective, which beats a folder. Among equals, and across everyone a call reaches, the strictest wins.
          </p>
          <Tester />
          {tab === "people" && <PeopleList list={list} sections={sections} onEdit={edit} onDelete={remove} onAdd={add} onLinked={load} />}
          {tab === "actions" && adding && (
            <section className="mb-5 rounded-xl border p-3">
              <Editor kinds={kinds} onSave={add} onCancel={() => setAdding(false)} />
            </section>
          )}
          {tab === "actions" && sections.map(section => (
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
const personName = (p: Person) => (p.team === true ? "Teammates" : p.team === false ? "Outsiders" : p.name || p.email || p.github || p.slack!);
const isGroup = (p: Person) => p.team !== undefined;
const GROUPS: Person[] = [{ team: true, name: "Teammates" }, { team: false, name: "Outsiders" }];
// How each kind of account reaches someone, in the order a person's actions are listed.
const REACHES: { reach: Reach; label: string }[] = [
  { reach: "slack", label: "On Slack" },
  { reach: "email", label: "By email" },
  { reach: "github", label: "On GitHub" },
];
/** The accounts an action can reach this person by: a group is reached every way. */
const reachable = (p: Person, reach: Reach) => isGroup(p) || !!p[reach];
/** A restriction said of one person: "Approve Liudvikas's PRs", "Message teammates on Slack". */
function forPerson(r: Restriction, p: Person) {
  if (!r.forPerson) return r.label;
  const name = p.team === true ? "teammates" : p.team === false ? "outsiders" : p.slack ? personName(p).split(/\s+/)[0]! : personName(p);
  return r.forPerson.replace("{name's}", /s$/i.test(name) ? `${name}'` : `${name}'s`).replace("{name}", name);
}

/**
 * A person's face: their Slack photo from the server's cache, else their GitHub avatar, else their initials; Teammates is a
 * group icon. The same pictures the threads show.
 */
function PersonFace({ p, className }: { p: Person; className?: string }) {
  const [broken, setBroken] = useState(false);
  const src = p.slack ? `/api/avatar/slack/${p.slack}?name=${encodeURIComponent(p.name ?? "")}` : p.github && `https://avatars.githubusercontent.com/${p.github}?s=40`;
  const box = cn("size-4 shrink-0 rounded-full", className);
  if (isGroup(p)) {
    const Icon = p.team ? Users : Globe;
    return (
      <span className={cn(box, "flex items-center justify-center bg-muted-foreground/15")}>
        <Icon className="size-2.5" />
      </span>
    );
  }
  if (src && !broken) return <img src={src} alt="" onError={() => setBroken(true)} className={cn(box, "object-cover")} />;
  const initials = personName(p).split(/[\s@._-]+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return <span className={cn(box, "flex items-center justify-center bg-tile-2 text-[8px] font-semibold text-tile-ink")}>{initials}</span>;
}

/** What a restriction is narrowed to: its people, objective and folder, as chips. */
function ScopeChips({ r }: { r: Restriction }) {
  const objectives = objectiveStore.use();
  const places = [r.scope?.objective && (objectives.find(o => o.id === r.scope!.objective)?.title ?? r.scope.objective), r.scope?.cwd].filter(Boolean) as string[];
  return (
    <>
      {(r.scope?.people ?? []).map(p => (
        <span key={personName(p)} className={cn(chip, "flex items-center gap-1 pl-0.5")}>
          <PersonFace p={p} />
          {personName(p)}
        </span>
      ))}
      {places.map(c => (
        <span key={c} className={chip}>
          {c}
        </span>
      ))}
    </>
  );
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
        <button onClick={() => setAdding(true)} title={r.reaches ? "Override it for some people, an objective or a folder" : "Override it for an objective or a folder (nobody is on the other end, so not per person)"} className={cn("shrink-0 text-muted-foreground hover:text-foreground", !adding && "opacity-0 group-hover:opacity-100")}>
          {r.reaches ? <UserPlus className="size-4" /> : <SlidersHorizontal className="size-4" />}
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
                  <Editor key={JSON.stringify(o)} r={o} override reach={r.reaches} kinds={kinds} onSave={c => onEdit(o.id, c)} onCancel={() => toggle(o.id)} onDelete={() => onDelete(o.id)} />
                </div>
              )}
            </li>
          ))}
          {adding && (
            <li className="mb-2 rounded-xl border p-3">
              <Editor override reach={r.reaches} kinds={kinds} initialMode={r.mode === "allow" ? "ask" : "allow"} onSave={async c => void (await onAdd({ ...c, parent: r.id }), setAdding(false))} onCancel={() => setAdding(false)} />
            </li>
          )}
        </ol>
      )}
    </li>
  );
}

/** Allow / Ask me / Block. Inherited: the mode comes from a broader rule, so it shows faded, and a click sets one here. */
function ModeToggle({ mode, inherited, onChange }: { mode: Mode; inherited?: boolean; onChange: (m: Mode) => void }) {
  return (
    <div role="radiogroup" className="flex shrink-0 rounded-md border p-0.5 text-xs">
      {MODES.map(m => (
        <button
          key={m.mode}
          role="radio"
          aria-checked={mode === m.mode}
          onClick={() => (inherited || mode !== m.mode) && onChange(m.mode)}
          className={cn("rounded px-2 py-0.5 font-medium", mode === m.mode ? cn(m.on, inherited && "opacity-45") : "text-muted-foreground hover:text-foreground")}
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
function Editor({ r, override, reach, initialMode, kinds, onSave, onCancel, onDelete }: { r?: Restriction; override?: boolean; reach?: Reach; initialMode?: Mode; kinds: string[]; onSave: (r: Partial<Restriction>) => Promise<void>; onCancel: () => void; onDelete?: () => void }) {
  const objectives = objectiveStore.use();
  const [label, setLabel] = useState(r?.label ?? "");
  const [action, setAction] = useState(r?.action ?? "");
  const [mode, setMode] = useState<Mode>(r?.mode ?? initialMode ?? "ask");
  const [people, setPeople] = useState<Person[]>(r?.scope?.people ?? []);
  // A builtin's reach is the catalog's; his own restriction says who, if anyone, is on the other end.
  const [reaches, setReaches] = useState<Reach | "">(r?.reaches ?? "");
  const reachedBy = override ? reach : reaches || undefined;
  const [tools, setTools] = useState((r?.match.tools ?? []).join("\n"));
  const [bash, setBash] = useState((r?.match.bash ?? []).join("\n"));
  const [objective, setObjective] = useState(r?.scope?.objective ?? "");
  const [cwd, setCwd] = useState(r?.scope?.cwd ?? "");
  const [note, setNote] = useState(r?.note ?? "");
  const [error, setError] = useState<string>();
  const save = async () => {
    const named = reachedBy ? people : [];
    const scope = objective || cwd.trim() || named.length ? { ...(objective && { objective }), ...(cwd.trim() && { cwd: cwd.trim() }), ...(named.length && { people: named }) } : undefined;
    try {
      setError(undefined);
      await onSave(override ? { mode, scope, note: note.trim() || undefined } : { label: label.trim(), action: action.trim().toLowerCase(), mode, match: { tools: lines(tools), bash: lines(bash) }, scope, note: note.trim() || undefined, ...(!r?.builtin && { reaches: reaches || undefined }) });
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
      {!override && !r?.builtin && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Who is on the other end</span>
          <select value={reaches} onChange={e => setReaches(e.target.value as Reach | "")} className={field}>
            <option value="">Nobody in particular (it can't be set per person)</option>
            <option value="slack">Someone on Slack</option>
            <option value="email">Someone by email</option>
            <option value="github">A PR's author on GitHub</option>
          </select>
        </label>
      )}
      {reachedBy && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Only for people{override ? "" : " (leave empty for everyone)"}</span>
          <PeoplePicker people={people} reach={reachedBy} onChange={setPeople} />
        </div>
      )}
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

const samePerson = (a: Person, b: Person) =>
  isGroup(a) || isGroup(b) ? a.team === b.team : (!!a.slack && a.slack === b.slack) || (!!a.email && a.email.toLowerCase() === b.email?.toLowerCase()) || (!!a.github && a.github.toLowerCase() === b.github?.toLowerCase());
const sourceOf = (p: Person) => (p.team === true ? "everyone on the team" : p.team === false ? "everyone known not to be on it" : p.slack && p.github ? `Slack · GitHub ${p.github}` : p.slack ? "Slack" : p.email ? "email" : "GitHub");
// An override that is about who, not where: only those apply to a person wherever they are.
const peopleOnly = (o: Restriction) => !!o.scope?.people?.length && !o.scope.objective && !o.scope.cwd;

/**
 * Everyone yarn knows, Teammates first, each opening to what is set for them on every action: what they inherit shows faded,
 * and the toggle sets an override for them alone (one shared with others gives them up first); the arrow puts them back on the
 * broader rule.
 */
function PeopleList({ list, sections, onEdit, onDelete, onAdd, onLinked }: { list: Restriction[]; sections: string[]; onEdit: (id: string, c: Partial<Restriction>) => Promise<void>; onDelete: (id: string) => Promise<void>; onAdd: (r: Partial<Restriction>) => Promise<Restriction>; onLinked: () => Promise<unknown> }) {
  const [known, setKnown] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string>();
  useEffect(() => void knownPeople().then(setKnown), []);
  // Linking or unlinking answers with everyone again, and the server may have given restrictions the other account.
  const relink = async (pair: { slack: string; github: string }, linked: boolean) => {
    const everyone = (await send("/api/restrictions/people/link", linked ? "POST" : "DELETE", pair)) as Person[];
    knownCache = Promise.resolve(everyone);
    setKnown(everyone);
    await onLinked();
  };
  // People named in overrides but never seen on Slack or GitHub (a typed email) are listed too.
  const named = list.flatMap(r => r.scope?.people ?? []).filter(p => !isGroup(p));
  const everyone = [...GROUPS, ...[...known, ...named].filter((p, i, all) => all.findIndex(o => samePerson(o, p)) === i)];
  const q = query.trim().toLowerCase();
  const shown = everyone.filter(p => !q || [personName(p), p.github, p.email].some(x => x?.toLowerCase().includes(q)));
  // Only actions with someone on the other end are set per person; the rest stay on the Actions tab.
  const tops = list.filter(r => !r.parent && r.reaches);
  const overridesFor = (p: Person, parent: string) => list.filter(o => o.parent === parent && peopleOnly(o) && o.scope!.people!.some(x => samePerson(x, p)));
  // What Teammates and Outsiders are set to, for a named person who may be either.
  const groupsOn = (parent: string) =>
    GROUPS.flatMap(g => list.filter(o => o.parent === parent && peopleOnly(o) && o.scope!.people!.some(x => samePerson(x, g))).map(o => `${personName(g)}: ${MODES.find(m => m.mode === o.mode)!.label}`)).join(" · ");

  // Takes them out of overrides they share with others, so the one set here is theirs alone, then sets or clears theirs.
  const set = async (p: Person, parent: string, mode?: Mode) => {
    const mine = overridesFor(p, parent);
    for (const o of mine.filter(o => o.scope!.people!.length > 1)) await onEdit(o.id, { scope: { ...o.scope, people: o.scope!.people!.filter(x => !samePerson(x, p)) } });
    const own = mine.find(o => o.scope!.people!.length === 1);
    if (!mode) return own && onDelete(own.id);
    if (own) return onEdit(own.id, { mode });
    await onAdd({ parent, mode, scope: { people: [p] } });
  };

  return (
    <section>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Filter ${everyone.length} people`} className={cn(field, "mb-2")} />
      <ol className="flex flex-col">
        {shown.map(p => {
          const key = isGroup(p) ? `group-${p.team}` : `${p.slack ?? ""}${p.email ?? ""}${p.github ?? ""}`;
          const count = tops.filter(r => overridesFor(p, r.id).length).length;
          const Chevron = open === key ? ChevronDown : ChevronRight;
          return (
            <li key={key}>
              <div className={cn("group flex min-w-0 items-center gap-2 rounded-lg pr-2.5 hover:bg-muted/60", open === key && "bg-muted/60")}>
                <button onClick={() => setOpen(open === key ? undefined : key)} className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 text-left text-sm">
                  <Chevron className="size-4 shrink-0 text-muted-foreground" />
                  <PersonFace p={p} className="size-6" />
                  <span className="truncate">{personName(p)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{sourceOf(p)}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{count ? `${count} set` : "everyone's rules"}</span>
                </button>
                {!isGroup(p) && !p.email && <LinkAccount p={p} known={known} onLink={relink} />}
              </div>
              {open === key && (
                <div className="mb-3 ml-[26px]">
                  {REACHES.filter(({ reach }) => reachable(p, reach)).map(({ reach, label }) => (
                    <div key={reach} className="mt-2">
                      <h3 className="px-2.5 text-xs font-medium text-muted-foreground">{label}</h3>
                      {tops
                        .filter(r => r.reaches === reach)
                        .map(r => {
                          const own = overridesFor(p, r.id)[0];
                          const groups = !isGroup(p) && groupsOn(r.id);
                          const from = own ? undefined : groups ? `everyone's rule · ${groups}` : "everyone's rule";
                          return (
                            <div key={r.id} className="group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1 text-[13px] hover:bg-muted/60">
                              <span className={cn("min-w-0 flex-1 truncate", !own && "text-muted-foreground")}>{forPerson(r, p)}</span>
                              {from && <span className="shrink-0 text-[11px] text-muted-foreground/70">{from}</span>}
                              {own && (
                                <button onClick={() => void set(p, r.id)} title="Back to the broader rule" className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
                                  <RotateCcw className="size-3.5" />
                                </button>
                              )}
                              <ModeToggle mode={own?.mode ?? r.mode} inherited={!own} onChange={mode => void set(p, r.id, mode)} />
                            </div>
                          );
                        })}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * Joins a Slack user and a GitHub login that are one person, or splits a pair that isn't: a person with both accounts can be
 * unlinked; one with only one picks the other from the accounts nobody holds yet.
 */
function LinkAccount({ p, known, onLink }: { p: Person; known: Person[]; onLink: (pair: { slack: string; github: string }, linked: boolean) => Promise<void> }) {
  const [picking, setPicking] = useState(false);
  if (p.slack && p.github)
    return (
      <button onClick={() => void onLink({ slack: p.slack!, github: p.github! }, false)} title={`Not the same person: unlink GitHub ${p.github}`} className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
        <Unlink className="size-4" />
      </button>
    );
  // A Slack user takes a login no one has; a login takes a Slack user with none.
  const free = known.filter(o => (p.slack ? o.github && !o.slack : o.slack && !o.github));
  if (!picking)
    return (
      <button onClick={() => setPicking(true)} title={p.slack ? "Link their GitHub login" : "Link them to a Slack user"} className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
        <Link2 className="size-4" />
      </button>
    );
  return (
    <select
      autoFocus
      defaultValue=""
      onBlur={() => setPicking(false)}
      onChange={e => {
        const o = free.find(x => (p.slack ? x.github : x.slack) === e.target.value);
        setPicking(false);
        if (o) void onLink({ slack: (p.slack ?? o.slack)!, github: (p.github ?? o.github)! }, true);
      }}
      className={cn(field, "w-48 shrink-0 py-0.5 text-xs")}
    >
      <option value="" disabled>
        {p.slack ? "Their GitHub login…" : "Their Slack user…"}
      </option>
      {free.map(o => (
        <option key={o.github ?? o.slack} value={(p.slack ? o.github : o.slack)!}>
          {personName(o)}
        </option>
      ))}
    </select>
  );
}

// The people the slack and gh sentries know, fetched once a page load.
let knownCache: Promise<Person[]> | undefined;
const knownPeople = () => (knownCache ??= send("/api/restrictions/people", "GET").catch(() => ((knownCache = undefined), [])));

/**
 * Picks people: focusing it lists everyone yarn has seen on Slack and GitHub, Teammates first, and typing filters the list;
 * Enter or a click adds one. An address with an @ adds that email, and a bare word that GitHub login.
 */
function PeoplePicker({ people, reach, onChange }: { people: Person[]; reach: Reach; onChange: (p: Person[]) => void }) {
  const [all, setAll] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void knownPeople().then(setAll), []);
  useEffect(() => {
    if (!listing) return;
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || setListing(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [listing]);
  const q = query.trim().toLowerCase();
  const picked = (p: Person) => people.some(o => samePerson(o, p));
  const offers: Person[] = listing
    ? [
        ...GROUPS,
        ...all.filter(p => p[reach]),
        ...(reach === "email" && /^\S+@\S+\.\S+$/.test(q) ? [{ name: q, email: q }] : []),
        ...(reach === "github" && /^[\w-]+$/.test(q) && !all.some(p => p.github?.toLowerCase() === q) ? [{ name: q, github: q }] : []),
      ].filter(p => !picked(p) && (!q || p.email === q || p.github === q || [personName(p), p.github, p.email].some(x => x?.toLowerCase().includes(q))))
    : [];
  const add = (p: Person) => (onChange([...people, p]), setQuery(""));
  return (
    <div ref={box} className="relative">
      <div className={cn(field, "flex flex-wrap items-center gap-1")}>
        {people.map(p => (
          <span key={personName(p)} className="flex items-center gap-1 rounded bg-muted py-0.5 pr-1.5 pl-0.5 text-xs">
            <PersonFace p={p} />
            {personName(p)}
            {!isGroup(p) && <span className="text-muted-foreground">{p.slack ? "Slack" : p.email ? "email" : "GitHub"}</span>}
            <button onClick={() => onChange(people.filter(o => o !== p))} title="Remove" className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={e => (setQuery(e.target.value), setListing(true))}
          onFocus={() => setListing(true)}
          onKeyDown={e => {
            if (e.key === "Escape" && listing) e.stopPropagation(), setListing(false);
            if (e.key === "Enter" && offers[0]) e.preventDefault(), add(offers[0]);
            if (e.key === "Backspace" && !query && people.length) onChange(people.slice(0, -1));
          }}
          placeholder={people.length ? "" : { slack: "Pick from everyone on Slack, or type a name", email: "Type an email address, or pick Teammates or Outsiders", github: "Pick from everyone on GitHub, or type a login" }[reach]}
          className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {offers.length > 0 && (
        <ol className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-raised">
          {offers.map(p => (
            <li key={`${personName(p)}-${p.slack ?? p.email ?? p.github ?? "team"}`}>
              <button onClick={() => add(p)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted">
                <PersonFace p={p} className="size-5" />
                {personName(p)}
                <span className="text-xs text-muted-foreground">{sourceOf(p)}</span>
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
