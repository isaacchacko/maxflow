import { X } from "lucide-react";
import { useRef, useState } from "react";
import { useEventListener, useResource } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import type { Person, Reach } from "../../../shared/restrictions-types";
import { knownPeople } from "./api";
import { field } from "./look";
import { GROUPS, PersonFace, accountKind, isGroup, personName, isSamePerson, sourceOf } from "./people";

const PICKER_HINT: Record<Reach, string> = {
  slack: "Pick from everyone on Slack, or type a name",
  email: "Type an email address, or pick Teammates or Outsiders",
  github: "Pick from everyone on GitHub, or type a login",
};

function typedAccount(all: Person[], reach: Reach, q: string): Person[] {
  if (reach === "email" && /^\S+@\S+\.\S+$/.test(q)) return [{ name: q, email: q }];
  if (reach === "github" && /^[\w-]+$/.test(q) && all.every(p => p.github?.toLowerCase() !== q)) return [{ name: q, github: q }];
  return [];
}

const isMatch = (p: Person, q: string) => q === "" || p.email === q || p.github === q || [personName(p), p.github, p.email].some(x => x?.toLowerCase().includes(q) === true);

function offersFor(all: Person[], picked: Person[], reach: Reach, q: string) {
  return [...GROUPS, ...all.filter(p => hasText(p[reach])), ...typedAccount(all, reach, q)].filter(p => picked.every(o => !isSamePerson(o, p)) && isMatch(p, q));
}

const withoutHowItWasLinked = ({ linked: _, ...p }: Person & { linked?: string }): Person => p;

function PickedPerson({ p, onRemove }: { p: Person; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1 rounded bg-muted py-0.5 pr-1.5 pl-0.5 text-xs">
      <PersonFace p={p} />
      {personName(p)}
      {!isGroup(p) && <span className="text-muted-foreground">{accountKind(p)}</span>}
      <button onClick={onRemove} title="Remove" className="text-muted-foreground hover:text-foreground">
        <X className="size-3" />
      </button>
    </span>
  );
}

function Offers({ offers, onAdd }: { offers: Person[]; onAdd: (p: Person) => void }) {
  if (offers.length === 0) return null;
  return (
    <ol className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-raised">
      {offers.map(p => (
        <li key={`${personName(p)}-${p.slack ?? p.email ?? p.github ?? "team"}`}>
          <button onClick={() => onAdd(p)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted">
            <PersonFace p={p} className="size-5" />
            {personName(p)}
            <span className="text-xs text-muted-foreground">{sourceOf(p)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function PeoplePicker({ people, reach, onChange }: { people: Person[]; reach: Reach; onChange: (p: Person[]) => void }) {
  const all = useResource("people", knownPeople).value ?? [];
  const [query, setQuery] = useState("");
  const [isListing, setListing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEventListener("pointerdown", e => {
    if (!isListing) return;
    if (e.target instanceof Node && box.current?.contains(e.target) === true) return;
    setListing(false);
  });
  const offers = isListing ? offersFor(all, people, reach, query.trim().toLowerCase()) : [];
  const add = (p: Person) => {
    onChange([...people, withoutHowItWasLinked(p)]);
    setQuery("");
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const [first] = offers;
    if (isListing && e.key === "Escape") {
      e.stopPropagation();
      setListing(false);
      return;
    }
    if (first && e.key === "Enter") {
      e.preventDefault();
      add(first);
      return;
    }
    if (query === "" && e.key === "Backspace" && people.length > 0) onChange(people.slice(0, -1));
  };
  return (
    <div ref={box} className="relative">
      <div className={cn(field, "flex flex-wrap items-center gap-1")}>
        {people.map(p => (
          <PickedPerson key={personName(p)} p={p} onRemove={() => onChange(people.filter(o => o !== p))} />
        ))}
        <input
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setListing(true);
          }}
          onFocus={() => setListing(true)}
          onKeyDown={onKeyDown}
          placeholder={people.length > 0 ? "" : PICKER_HINT[reach]}
          className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Offers offers={offers} onAdd={add} />
    </div>
  );
}
