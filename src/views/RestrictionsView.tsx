import { ChevronDown, ChevronRight, CornerDownRight, Globe, Link2, Pencil, Plus, RotateCcw, Trash2, Unlink, Users, X } from "lucide-react";
import { useRef, useState } from "react";
import { useEventListener, useResource, useSettled } from "@/lib/effects";
import type { Call, Exception, Mode, Person, Reach, Restriction } from "../../restrictions";
import { cn } from "@/lib/utils";
import { liveStore, objectiveStore } from "@/store";
import { useLayerScroll } from "@/threads/jump";
import { ago } from "@/threads/Replies";

// His autonomy restrictions: for each kind of action his agents take, whether they do it on their own, ask him first, or never do
// it. The catalog comes seeded and explains itself; a builtin takes only its setting and the exceptions that make sense for it,
// picked from lists. Patterns on tools and commands belong to his own rules, written under Advanced.

// short: the legend's line. meaning: what the setting does to an agent about to take the action, said of one of it ("message").
const MODES: { mode: Mode; label: string; on: string; dot: string; short: string; meaning: (noun: string) => string }[] = [
  { mode: "allow", label: "Allow", on: "bg-ok/10 text-ok", dot: "bg-ok", short: "Goes ahead on its own", meaning: () => "The agent goes ahead on its own." },
  { mode: "ask", label: "Ask me", on: "bg-warn-soft text-warn", dot: "bg-warn", short: "Stops and asks you first", meaning: noun => `The agent asks you in its thread first; your yes lets that one ${noun} through.` },
  { mode: "deny", label: "Block", on: "bg-destructive/10 text-destructive", dot: "bg-destructive", short: "Is told no", meaning: () => "The agent is told no, and doesn't do it." },
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
  custom: "Your own rules",
};
const kindLabel = (action: string) => KINDS[action] ?? action.charAt(0).toUpperCase() + action.slice(1);

async function send(path: string, method: string, body?: unknown) {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.status === 204 ? null : res.json();
}

export function RestrictionsView() {
  const live = liveStore.use();
  // The tab is in the address (#restrictions/people), so it survives a reload and can be linked to.
  const [tab, setTabState] = useState<"actions" | "people">(location.hash === "#restrictions/people" ? "people" : "actions");
  const setTab = (t: "actions" | "people") => (setTabState(t), history.replaceState(history.state, "", t === "people" ? "#restrictions/people" : "#restrictions"));
  useEventListener("hashchange", () => location.hash.startsWith("#restrictions") && setTabState(location.hash === "#restrictions/people" ? "people" : "actions"));
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachScroll = useLayerScroll("restrictions", scrollRef);
  const loaded = useResource(live ? "restrictions" : undefined, () => send("/api/restrictions", "GET") as Promise<Restriction[]>);
  const list = loaded.value ?? [];
  const setList = (change: (all: Restriction[]) => Restriction[]) => loaded.set(all => change(all ?? []));
  const load = loaded.reload;

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
    setList(all => all.filter(r => r.id !== id && r.parent !== id));
    await send(`/api/restrictions/${id}`, "DELETE").catch(load);
  };
  const add = async (r: Partial<Restriction>) => {
    const saved = (await send("/api/restrictions", "POST", r)) as Restriction;
    setList(all => [...all, saved]);
    return saved;
  };

  const builtins = list.filter(r => r.builtin && !r.parent);
  const custom = list.filter(r => !r.builtin && !r.parent);
  const sections = [...new Set(builtins.map(r => kindLabel(r.action)))];
  const rowProps = { onEdit: edit, onDelete: remove, onAdd: add };
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
      </header>
      <div ref={attachScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-4">
          <p className="mb-3 px-2.5 text-sm text-muted-foreground">What your agents may do without asking you.</p>
          <ul className="mb-6 grid grid-cols-3 divide-x rounded-xl border">
            {MODES.map(m => (
              <li key={m.mode} className="flex flex-col items-start gap-1.5 px-3 py-2.5">
                <span className={cn("w-16 rounded-md py-0.5 text-center text-xs font-medium", m.on)}>{m.label}</span>
                <span className="text-[13px] text-muted-foreground">{m.short}</span>
              </li>
            ))}
          </ul>
          {tab === "people" && <PeopleList list={list} sections={sections} onEdit={edit} onDelete={remove} onAdd={add} onLinked={load} />}
          {tab === "actions" && (
            <>
              {sections.map(section => (
                <section key={section} className="mb-6">
                  <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">{section}</h2>
                  <ol className="flex flex-col divide-y">
                    {builtins
                      .filter(r => kindLabel(r.action) === section)
                      .map(r => (
                        <ActionRow key={r.id} r={r} exceptions={list.filter(o => o.parent === r.id)} {...rowProps} />
                      ))}
                  </ol>
                </section>
              ))}
              {custom.length > 0 && (
                <section className="mb-6">
                  <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">Your own rules</h2>
                  <ol className="flex flex-col divide-y">
                    {custom.map(r => (
                      <ActionRow key={r.id} r={r} exceptions={list.filter(o => o.parent === r.id)} {...rowProps} />
                    ))}
                  </ol>
                </section>
              )}
              <Advanced onAdd={add} />
            </>
          )}
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
  const places = [r.scope?.objective && `on ${objectives.find(o => o.id === r.scope!.objective)?.title ?? r.scope.objective}`, r.scope?.cwd && `in ${r.scope.cwd.split("/").filter(Boolean).at(-1)}`].filter(Boolean) as string[];
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

type RowProps = { onEdit: (id: string, c: Partial<Restriction>) => Promise<void>; onDelete: (id: string) => Promise<void>; onAdd: (r: Partial<Restriction>) => Promise<Restriction> };
// His own rules carry no catalog exceptions; the place ones always make sense for them.
const exceptionsOf = (r: Restriction): Exception[] => (r.builtin ? (r.exceptions ?? []) : ["objective", "repo"]);

/**
 * An action as he reads it: what it covers, an example or two, and what its setting does, with its exceptions under it. A
 * builtin's matchers are the catalog's and never shown; his own rule opens its editor from the pencil.
 */
function ActionRow({ r, exceptions, onEdit, onDelete, onAdd }: RowProps & { r: Restriction; exceptions: Restriction[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const m = MODES.find(x => x.mode === r.mode)!;
  const kinds = exceptionsOf(r);
  if (editing)
    return (
      <li className="rounded-xl border p-3">
        <CustomEditor r={r} onSave={async c => (await onEdit(r.id, c), setEditing(false))} onCancel={() => setEditing(false)} onDelete={() => void onDelete(r.id)} />
      </li>
    );
  return (
    <li data-row={`restriction/${r.id}`} className="group px-2.5 py-3">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            {r.label}
            {!r.builtin && (
              <button onClick={() => setEditing(true)} title="Edit this rule" className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
                <Pencil className="size-3.5" />
              </button>
            )}
          </div>
          {(r.about ?? r.note) && <p className="mt-0.5 text-[13px] text-muted-foreground">{r.about ?? r.note}</p>}
          {r.examples?.length ? <p className="text-[13px] text-muted-foreground/70">e.g. {r.examples.join("; ")}</p> : null}
          <p className="mt-1.5 flex items-start gap-2 text-[13px] text-foreground/80">
            <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", m.dot)} />
            {m.meaning(r.noun ?? "action")}
          </p>
        </div>
        <ModeToggle mode={r.mode} onChange={mode => void onEdit(r.id, { mode })} />
      </div>
      {(exceptions.length > 0 || adding) && (
        <ol className="mt-2 flex flex-col gap-0.5">
          {exceptions.map(o => (
            <li key={o.id} className="group/exception flex min-w-0 items-center gap-2 rounded-md py-0.5 text-[13px]">
              <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">Except</span>
              <ScopeChips r={o} />
              <button onClick={() => void onDelete(o.id)} title="Remove this exception" className="shrink-0 text-muted-foreground opacity-0 group-hover/exception:opacity-100 hover:text-destructive">
                <X className="size-3.5" />
              </button>
              <span className="min-w-0 flex-1" />
              <ModeToggle mode={o.mode} onChange={mode => void onEdit(o.id, { mode })} />
            </li>
          ))}
          {adding && (
            <li className="mt-1 rounded-lg border p-3">
              <ExceptionForm r={r} kinds={kinds} onAdd={async c => (await onAdd({ ...c, parent: r.id }), setAdding(false))} onCancel={() => setAdding(false)} />
            </li>
          )}
        </ol>
      )}
      {kinds.length > 0 && !adding && (
        <button onClick={() => setAdding(true)} className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <Plus className="size-3.5" /> Add an exception
        </button>
      )}
    </li>
  );
}

const KIND_LABEL: Record<Exception, string> = { people: "Some people", objective: "An objective", repo: "A repository" };

// The repositories his agents work in, fetched once a page load.
let reposCache: Promise<{ path: string; name: string }[]> | undefined;
const knownRepos = () => (reposCache ??= send("/api/restrictions/repos", "GET").catch(() => ((reposCache = undefined), [])));

/** An exception, picked from lists: who or where it holds, and its own setting, which starts as the other way round. */
function ExceptionForm({ r, kinds, onAdd, onCancel }: { r: Restriction; kinds: Exception[]; onAdd: (c: Partial<Restriction>) => Promise<void>; onCancel: () => void }) {
  const objectives = objectiveStore.use();
  const [kind, setKind] = useState<Exception>(kinds[0]!);
  const [people, setPeople] = useState<Person[]>([]);
  const [objective, setObjective] = useState("");
  const [repo, setRepo] = useState("");
  const repos = useResource("repos", knownRepos).value ?? [];
  const [mode, setMode] = useState<Mode>(r.mode === "allow" ? "ask" : "allow");
  const [error, setError] = useState<string>();
  const scope = kind === "people" ? people.length && { people } : kind === "objective" ? objective && { objective } : repo && { cwd: repo };
  const add = async () => {
    try {
      await onAdd({ mode, scope: scope || undefined });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      {kinds.length > 1 && (
        <div className="flex gap-1">
          {kinds.map(k => (
            <button key={k} onClick={() => setKind(k)} className={cn("rounded-md px-2 py-0.5 text-xs", kind === k ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}
      {kind === "people" && r.reaches && <PeoplePicker people={people} reach={r.reaches} onChange={setPeople} />}
      {kind === "objective" && (
        <select value={objective} onChange={e => setObjective(e.target.value)} className={field}>
          <option value="">Pick an objective…</option>
          {objectives.map(o => (
            <option key={o.id} value={o.id}>{o.title}</option>
          ))}
        </select>
      )}
      {kind === "repo" && (
        <select value={repo} onChange={e => setRepo(e.target.value)} className={field}>
          <option value="">Pick a repository…</option>
          {repos.map(x => (
            <option key={x.path} value={x.path}>{x.name} ({x.path})</option>
          ))}
        </select>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">There, it's</span>
        <ModeToggle mode={mode} onChange={setMode} />
        <span className="text-xs text-muted-foreground">instead of {MODES.find(x => x.mode === r.mode)!.label}</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button disabled={!scope} onClick={() => void add()} className="rounded-md bg-primary px-3 py-1 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
          Add exception
        </button>
        <button onClick={onCancel} className="rounded-md px-3 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
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
          className={cn("w-14 rounded py-0.5 text-center font-medium", mode === m.mode ? cn(m.on, inherited && "opacity-45") : "text-muted-foreground hover:text-foreground")}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** Writing his own rule, and checking which command or tool name a rule hits, tucked away for when the catalog doesn't cover it. */
function Advanced({ onAdd }: { onAdd: (r: Partial<Restriction>) => Promise<Restriction> }) {
  const [open, setOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="mb-6 border-t pt-4">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 px-2.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
        <Chevron className="size-4" /> Advanced
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-3 px-2.5">
          <p className="text-[13px] text-muted-foreground">For something the actions above don't cover: a rule that matches tools or shell commands by pattern. Test where a command lands, or write a rule.</p>
          <Tester />
          {writing ? (
            <div className="rounded-xl border p-3">
              <CustomEditor onSave={async c => void (await onAdd({ ...c, action: "custom" }), setWriting(false))} onCancel={() => setWriting(false)} />
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

const lines = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean);
const field = "w-full rounded-md border bg-transparent px-2 py-1 text-sm outline-none focus:border-foreground/30";
type Preview = { checked: number; count: number; caught: { tool: string; text: string; at: string }[] };

/**
 * His own rule: a name, what it covers in his words, its setting, and the patterns it matches, with what those would have caught
 * among the tool calls agents made lately, updated as he types.
 */
function CustomEditor({ r, onSave, onCancel, onDelete }: { r?: Restriction; onSave: (c: Partial<Restriction>) => Promise<unknown>; onCancel: () => void; onDelete?: () => void }) {
  const [label, setLabel] = useState(r?.label ?? "");
  const [about, setAbout] = useState(r?.about ?? r?.note ?? "");
  const [mode, setMode] = useState<Mode>(r?.mode ?? "ask");
  const [tools, setTools] = useState((r?.match.tools ?? []).join("\n"));
  const [bash, setBash] = useState((r?.match.bash ?? []).join("\n"));
  const [error, setError] = useState<string>();
  const match = { tools: lines(tools), bash: lines(bash) };
  const empty = !match.tools.length && !match.bash.length;
  const asked = useSettled(JSON.stringify(match), 300);
  const previewed = useResource(empty ? undefined : `preview:${asked}`, () => send("/api/restrictions/preview", "POST", { match: JSON.parse(asked) }) as Promise<Preview>);
  // The last answer stays up while he types the next.
  const answer = previewed.error?.message ?? previewed.value;
  const [kept, setKept] = useState<Preview | string>();
  if (answer !== undefined && answer !== kept) setKept(answer);
  const preview = empty ? undefined : kept;
  const save = async () => {
    try {
      setError(undefined);
      await onSave({ label: label.trim(), about: about.trim() || undefined, mode, match });
    } catch (e) {
      setError((e as Error).message);
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
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Tool names it catches, one pattern a line (the whole name must match)</span>
          <textarea value={tools} onChange={e => setTools(e.target.value)} rows={2} className={cn(field, "resize-y font-mono text-xs")} />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Shell commands it catches, one pattern a line (matched where a command starts, so a file named pkill.md isn't pkill)</span>
          <textarea value={bash} onChange={e => setBash(e.target.value)} rows={2} className={cn(field, "resize-y font-mono text-xs")} />
        </label>
      </div>
      <div className="rounded-lg bg-muted/50 px-2.5 py-2 text-xs">
        {preview === undefined ? (
          <span className="text-muted-foreground">Add a pattern to see which of your agents' recent tool calls it would catch.</span>
        ) : typeof preview === "string" ? (
          <span className="text-destructive">{preview}</span>
        ) : (
          <>
            <p className={cn("mb-1 font-medium", !preview.count && "text-muted-foreground")}>
              Would have caught {preview.count} of the last {preview.checked} tool calls{preview.count ? ":" : "."}
            </p>
            <ol className="flex flex-col gap-0.5">
              {preview.caught.map((c, i) => (
                <li key={i} className="flex min-w-0 gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono">{c.text}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{c.at && ago(Date.parse(c.at))}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <button onClick={() => void save()} className="rounded-md bg-primary px-3 py-1 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
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
  const people = useResource("people", knownPeople);
  const known = people.value ?? [];
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string>();
  // Linking or unlinking answers with everyone again, and the server may have given restrictions the other account.
  const relink = async (pair: { slack: string; github: string }, linked: boolean) => {
    const everyone = (await send("/api/restrictions/people/link", linked ? "POST" : "DELETE", pair)) as Person[];
    knownCache = Promise.resolve(everyone);
    people.set(() => everyone);
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
              <div className={cn("group flex min-w-0 items-center gap-3 rounded-lg pr-2.5 hover:bg-muted/60", open === key && "bg-muted/60")}>
                <button onClick={() => setOpen(open === key ? undefined : key)} className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 text-left text-sm">
                  <Chevron className="size-4 shrink-0 text-muted-foreground" />
                  <PersonFace p={p} className="size-6" />
                  <span className="truncate">{personName(p)}</span>
                  <span className="truncate text-xs text-muted-foreground">{sourceOf(p)}</span>
                </button>
                {!isGroup(p) && !p.email && <LinkAccount p={p} known={known} onLink={relink} />}
                <span className="shrink-0 text-xs text-muted-foreground">{count ? `${count} set` : "everyone's rules"}</span>
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
  const all = useResource("people", knownPeople).value ?? [];
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEventListener("pointerdown", e => listing && !box.current?.contains(e.target as Node) && setListing(false));
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
  // How yarn joined their accounts is the listing's business, not the restriction's.
  const add = ({ linked: _, ...p }: Person & { linked?: string }) => (onChange([...people, p]), setQuery(""));
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
  const timer = useRef(0);
  const type = (next: string) => {
    setText(next);
    clearTimeout(timer.current);
    const t = next.trim();
    if (!t || !liveStore.get()) return setVerdict(undefined);
    const call: Call = /^[\w-]+$/.test(t) && t !== t.toLowerCase() || t.startsWith("mcp__") ? { tool: t } : { tool: "Bash", input: { command: t } };
    timer.current = window.setTimeout(() => void send("/api/restrictions/check", "POST", call).then(setVerdict, () => setVerdict(undefined)), 150);
  };
  const m = verdict && MODES.find(x => x.mode === verdict.mode)!;
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
