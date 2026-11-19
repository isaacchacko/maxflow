import { CornerDownRight, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { useResource } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import type { Objective } from "@/mock";
import { objectiveStore } from "@/store";
import type { Exception, Mode, Person, Restriction } from "../../../shared/restrictions-types";
import { knownRepos } from "./api";
import { CustomEditor } from "./CustomEditor";
import { MODE_LOOK, ModeToggle, chip, field, messageOf } from "./look";
import { PeoplePicker } from "./PeoplePicker";
import { PersonFace, personName } from "./people";

export type RowProps = { onEdit: (id: string, c: Partial<Restriction>) => Promise<void>; onDelete: (id: string) => Promise<void>; onAdd: (r: Partial<Restriction>) => Promise<Restriction> };

const PLACE_EXCEPTIONS: Exception[] = ["objective", "repo"];
const exceptionsOf = (r: Restriction): Exception[] => (r.builtin === true ? (r.exceptions ?? []) : PLACE_EXCEPTIONS);
const KIND_LABEL: Record<Exception, string> = { people: "Some people", objective: "An objective", repo: "A repository" };

function placesOf(scope: Restriction["scope"], objectives: Objective[]) {
  const { objective, cwd } = scope ?? {};
  const places: string[] = [];
  if (hasText(objective)) places.push(`on ${objectives.find(o => o.id === objective)?.title ?? objective}`);
  if (hasText(cwd)) places.push(`in ${String(cwd.split("/").findLast(Boolean))}`);
  return places;
}

function ScopeChips({ r }: { r: Restriction }) {
  const objectives = objectiveStore.use();
  return (
    <>
      {(r.scope?.people ?? []).map(p => (
        <span key={personName(p)} className={cn(chip, "flex items-center gap-1 pl-0.5")}>
          <PersonFace p={p} />
          {personName(p)}
        </span>
      ))}
      {placesOf(r.scope, objectives).map(c => (
        <span key={c} className={chip}>
          {c}
        </span>
      ))}
    </>
  );
}

function exceptionScope(kind: Exception, people: Person[], objective: string, repo: string): Restriction["scope"] {
  if (kind === "people") return people.length > 0 ? { people } : undefined;
  if (kind === "objective") return hasText(objective) ? { objective } : undefined;
  return hasText(repo) ? { cwd: repo } : undefined;
}

function KindPicker({ kinds, kind, onKind }: { kinds: Exception[]; kind: Exception; onKind: (k: Exception) => void }) {
  if (kinds.length <= 1) return null;
  return (
    <div className="flex gap-1">
      {kinds.map(k => (
        <button key={k} onClick={() => onKind(k)} className={cn("rounded-md px-2 py-0.5 text-xs", kind === k ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
          {KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );
}

function PlacePicker({ kind, objective, onObjective, repo, onRepo }: { kind: Exception; objective: string; onObjective: (id: string) => void; repo: string; onRepo: (path: string) => void }) {
  const objectives = objectiveStore.use();
  const repos = useResource("repos", knownRepos).value ?? [];
  if (kind === "objective") {
    return (
      <select value={objective} onChange={e => onObjective(e.target.value)} className={field}>
        <option value="">Pick an objective…</option>
        {objectives.map(o => (
          <option key={o.id} value={o.id}>
            {o.title}
          </option>
        ))}
      </select>
    );
  }
  if (kind !== "repo") return null;
  return (
    <select value={repo} onChange={e => onRepo(e.target.value)} className={field}>
      <option value="">Pick a repository…</option>
      {repos.map(x => (
        <option key={x.path} value={x.path}>
          {x.name} ({x.path})
        </option>
      ))}
    </select>
  );
}

function ExceptionForm({ r, kinds, onAdd, onCancel }: { r: Restriction; kinds: Exception[]; onAdd: (c: Partial<Restriction>) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<Exception>(kinds[0] ?? "people");
  const [people, setPeople] = useState<Person[]>([]);
  const [objective, setObjective] = useState("");
  const [repo, setRepo] = useState("");
  const [mode, setMode] = useState<Mode>(r.mode === "allow" ? "ask" : "allow");
  const [error, setError] = useState<string>();
  const scope = exceptionScope(kind, people, objective, repo);
  const add = async () => {
    try {
      await onAdd({ mode, scope });
    } catch (error_) {
      setError(messageOf(error_));
    }
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      <KindPicker kinds={kinds} kind={kind} onKind={setKind} />
      {kind === "people" && r.reaches !== undefined && <PeoplePicker people={people} reach={r.reaches} onChange={setPeople} />}
      <PlacePicker kind={kind} objective={objective} onObjective={setObjective} repo={repo} onRepo={setRepo} />
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">There, it's</span>
        <ModeToggle mode={mode} onChange={setMode} />
        <span className="text-xs text-muted-foreground">instead of {MODE_LOOK[r.mode].label}</span>
      </div>
      {hasText(error) && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          disabled={!scope}
          onClick={() => {
            void add();
          }}
          className="rounded-md bg-primary px-3 py-1 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
          Add exception
        </button>
        <button onClick={onCancel} className="rounded-md px-3 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}

function ExceptionRow({ o, onEdit, onDelete }: { o: Restriction; onEdit: RowProps["onEdit"]; onDelete: RowProps["onDelete"] }) {
  return (
    <li className="group/exception flex min-w-0 items-center gap-2 rounded-md py-0.5 text-[13px]">
      <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">Except</span>
      <ScopeChips r={o} />
      <button
        onClick={() => {
          void onDelete(o.id);
        }}
        title="Remove this exception"
        className="shrink-0 text-muted-foreground opacity-0 group-hover/exception:opacity-100 hover:text-destructive"
      >
        <X className="size-3.5" />
      </button>
      <span className="min-w-0 flex-1" />
      <ModeToggle
        mode={o.mode}
        onChange={mode => {
          void onEdit(o.id, { mode });
        }}
      />
    </li>
  );
}

function ActionText({ r, onEditRule }: { r: Restriction; onEditRule: () => void }) {
  const m = MODE_LOOK[r.mode];
  const about = r.about ?? r.note;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 text-sm font-medium">
        {r.label}
        {r.builtin !== true && (
          <button onClick={onEditRule} title="Edit this rule" className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
            <Pencil className="size-3.5" />
          </button>
        )}
      </div>
      {hasText(about) && <p className="mt-0.5 text-[13px] text-muted-foreground">{about}</p>}
      {r.examples && r.examples.length > 0 ? <p className="text-[13px] text-muted-foreground/70">e.g. {r.examples.join("; ")}</p> : null}
      <p className="mt-1.5 flex items-start gap-2 text-[13px] text-foreground/80">
        <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", m.dot)} />
        {m.whatItDoesTo(r.noun ?? "action")}
      </p>
    </div>
  );
}

export function ActionRow({ r, exceptions, onEdit, onDelete, onAdd }: RowProps & { r: Restriction; exceptions: Restriction[] }) {
  const [isAdding, setAdding] = useState(false);
  const [isEditing, setEditing] = useState(false);
  const kinds = exceptionsOf(r);
  if (isEditing) {
    return (
      <li className="rounded-xl border p-3">
        <CustomEditor
          r={r}
          onSave={async c => {
            await onEdit(r.id, c);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          onDelete={() => {
            void onDelete(r.id);
          }}
        />
      </li>
    );
  }
  return (
    <li data-row={`restriction/${r.id}`} className="group px-2.5 py-3">
      <div className="flex items-start gap-4">
        <ActionText r={r} onEditRule={() => setEditing(true)} />
        <ModeToggle
          mode={r.mode}
          onChange={mode => {
            void onEdit(r.id, { mode });
          }}
        />
      </div>
      {(exceptions.length > 0 || isAdding) && (
        <ol className="mt-2 flex flex-col gap-0.5">
          {exceptions.map(o => (
            <ExceptionRow key={o.id} o={o} onEdit={onEdit} onDelete={onDelete} />
          ))}
          {isAdding && (
            <li className="mt-1 rounded-lg border p-3">
              <ExceptionForm
                r={r}
                kinds={kinds}
                onAdd={async c => {
                  await onAdd({ ...c, parent: r.id });
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            </li>
          )}
        </ol>
      )}
      {kinds.length > 0 && !isAdding && (
        <button onClick={() => setAdding(true)} className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <Plus className="size-3.5" /> Add an exception
        </button>
      )}
    </li>
  );
}
