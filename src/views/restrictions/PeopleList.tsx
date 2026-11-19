import { ChevronDown, ChevronRight, Link2, RotateCcw, Unlink } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { useState } from "react";
import { useResource } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import type { Mode, Person, Restriction } from "../../../shared/restrictions-types";
import { knownPeople, linkPeople, rememberPeople } from "./api";
import type { RowProps } from "./ActionRow";
import { MODE_LOOK, ModeToggle, field } from "./look";
import { GROUPS, PersonFace, REACHES_IN_LISTING_ORDER, isAboutWhoNotWhere, isGroup, isReachableBy, labelForPerson, peopleIn, personName, isSamePerson, sourceOf } from "./people";

type Pair = { slack: string; github: string };
type Overrides = { overridesFor: (p: Person, parent: string) => Restriction[]; groupsOn: (parent: string) => string; set: (p: Person, parent: string, mode?: Mode) => Promise<void> };

const keyOf = (p: Person) => (isGroup(p) ? `group-${String(p.team)}` : `${p.slack ?? ""}${p.email ?? ""}${p.github ?? ""}`);

function freeOtherAccounts(p: Person, known: Person[]) {
  return known.filter(o => (hasText(p.slack) ? hasText(o.github) && !hasText(o.slack) : hasText(o.slack) && !hasText(o.github)));
}

function LinkAccount({ p, known, onLink }: { p: Person; known: Person[]; onLink: (pair: Pair, isLinked: boolean) => Promise<void> }) {
  const [isPicking, setPicking] = useState(false);
  if (hasText(p.slack) && hasText(p.github)) {
    const pair = { slack: p.slack, github: p.github };
    return (
      <button
        onClick={() => {
          void onLink(pair, false);
        }}
        title={`Not the same person: unlink GitHub ${p.github}`}
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
      >
        <Unlink className="size-4" />
      </button>
    );
  }
  const free = freeOtherAccounts(p, known);
  const otherOf = (o: Person) => (hasText(p.slack) ? o.github : o.slack) ?? "";
  if (!isPicking) {
    return (
      <button onClick={() => setPicking(true)} title={hasText(p.slack) ? "Link their GitHub login" : "Link them to a Slack user"} className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
        <Link2 className="size-4" />
      </button>
    );
  }
  return (
    <NativeSelect
      wrapperClassName="w-48 shrink-0"
      autoFocus
      defaultValue=""
      onBlur={() => setPicking(false)}
      onChange={e => {
        const o = free.find(x => otherOf(x) === e.target.value);
        setPicking(false);
        if (o) void onLink({ slack: p.slack ?? o.slack ?? "", github: p.github ?? o.github ?? "" }, true);
      }}
      className={cn(field, "py-0.5 text-xs")}
    >
      <option value="" disabled>
        {hasText(p.slack) ? "Their GitHub login…" : "Their Slack user…"}
      </option>
      {free.map(o => (
        <option key={o.github ?? o.slack} value={otherOf(o)}>
          {personName(o)}
        </option>
      ))}
    </NativeSelect>
  );
}

function inheritedFrom(own: Restriction | undefined, groups: string) {
  if (own) return;
  return hasText(groups) ? `everyone's rule · ${groups}` : "everyone's rule";
}

function PersonAction({ p, r, o }: { p: Person; r: Restriction; o: Overrides }) {
  const own = o.overridesFor(p, r.id)[0];
  const from = inheritedFrom(own, isGroup(p) ? "" : o.groupsOn(r.id));
  return (
    <div className="group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1 text-[13px] hover:bg-muted/60">
      <span className={cn("min-w-0 flex-1 truncate", !own && "text-muted-foreground")}>{labelForPerson(r, p)}</span>
      {hasText(from) && <span className="shrink-0 text-[11px] text-muted-foreground/70">{from}</span>}
      {own && (
        <button
          onClick={() => {
            void o.set(p, r.id);
          }}
          title="Back to the broader rule"
          className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
      <ModeToggle
        mode={own?.mode ?? r.mode}
        isInherited={!own}
        onChange={mode => {
          void o.set(p, r.id, mode);
        }}
      />
    </div>
  );
}

function PersonActions({ p, tops, o }: { p: Person; tops: Restriction[]; o: Overrides }) {
  return (
    <div className="mb-3 ml-[26px]">
      {REACHES_IN_LISTING_ORDER.filter(({ reach }) => isReachableBy(p, reach)).map(({ reach, label }) => (
        <div key={reach} className="mt-2">
          <h3 className="px-2.5 text-xs font-medium text-muted-foreground">{label}</h3>
          {tops
            .filter(r => r.reaches === reach)
            .map(r => (
              <PersonAction key={r.id} p={p} r={r} o={o} />
            ))}
        </div>
      ))}
    </div>
  );
}

type PersonRowProps = { p: Person; isOpen: boolean; onOpen: () => void; known: Person[]; onLink: (pair: Pair, isLinked: boolean) => Promise<void>; tops: Restriction[]; o: Overrides };

function PersonRow({ p, isOpen, onOpen, known, onLink, tops, o }: PersonRowProps) {
  const count = tops.filter(r => o.overridesFor(p, r.id).length > 0).length;
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <li>
      <div className={cn("group flex min-w-0 items-center gap-3 rounded-lg pr-2.5 hover:bg-muted/60", isOpen && "bg-muted/60")}>
        <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 text-left text-sm">
          <Chevron className="size-4 shrink-0 text-muted-foreground" />
          <PersonFace p={p} className="size-6" />
          <span className="truncate">{personName(p)}</span>
          <span className="truncate text-xs text-muted-foreground">{sourceOf(p)}</span>
        </button>
        {!isGroup(p) && !hasText(p.email) && <LinkAccount p={p} known={known} onLink={onLink} />}
        <span className="shrink-0 text-xs text-muted-foreground">{count > 0 ? `${count} set` : "everyone's rules"}</span>
      </div>
      {isOpen && <PersonActions p={p} tops={tops} o={o} />}
    </li>
  );
}

function useOverrides(list: Restriction[], { onEdit, onDelete, onAdd }: RowProps): Overrides {
  const overridesFor = (p: Person, parent: string) => list.filter(o => o.parent === parent && isAboutWhoNotWhere(o) && peopleIn(o).some(x => isSamePerson(x, p)));
  const groupsOn = (parent: string) =>
    GROUPS.flatMap(g => overridesFor(g, parent).map(o => `${personName(g)}: ${MODE_LOOK[o.mode].label}`)).join(" · ");
  const set = async (p: Person, parent: string, mode?: Mode) => {
    const mine = overridesFor(p, parent);
    const sharedWithOthers = mine.filter(x => peopleIn(x).length > 1);
    for (const o of sharedWithOthers) await onEdit(o.id, { scope: { ...o.scope, people: peopleIn(o).filter(x => !isSamePerson(x, p)) } });
    const own = mine.find(o => peopleIn(o).length === 1);
    if (mode === undefined) {
      if (own) await onDelete(own.id);
      return;
    }
    if (own) {
      await onEdit(own.id, { mode });
      return;
    }
    await onAdd({ parent, mode, scope: { people: [p] } });
  };
  return { overridesFor, groupsOn, set };
}

function everyoneKnown(known: Person[], list: Restriction[]) {
  const namedInOverridesOnly = list.flatMap(r => r.scope?.people ?? []).filter(p => !isGroup(p));
  return [...GROUPS, ...[...known, ...namedInOverridesOnly].filter((p, i, all) => all.findIndex(o => isSamePerson(o, p)) === i)];
}

const isMatchingQuery = (p: Person, q: string) => q === "" || [personName(p), p.github, p.email].some(x => x?.toLowerCase().includes(q) === true);

export function PeopleList({ list, onLinked, ...row }: RowProps & { list: Restriction[]; onLinked: () => Promise<unknown> }) {
  const people = useResource("people", knownPeople);
  const known = people.value ?? [];
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string>();
  const relink = async (pair: Pair, isLinked: boolean) => {
    const everyone = await linkPeople(pair, isLinked);
    rememberPeople(everyone);
    people.set(() => everyone);
    await onLinked();
  };
  const everyone = everyoneKnown(known, list);
  const q = query.trim().toLowerCase();
  const tops = list.filter(r => !hasText(r.parent) && r.reaches !== undefined);
  const o = useOverrides(list, row);
  return (
    <section>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Filter ${everyone.length} people`} className={cn(field, "mb-2")} />
      <ol className="flex flex-col">
        {everyone
          .filter(p => isMatchingQuery(p, q))
          .map(p => {
            const key = keyOf(p);
            return <PersonRow key={key} p={p} isOpen={openKey === key} onOpen={() => setOpenKey(openKey === key ? undefined : key)} known={known} onLink={relink} tops={tops} o={o} />;
          })}
      </ol>
    </section>
  );
}

