import { Globe, Users } from "lucide-react";
import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import type { Person, Reach, Restriction } from "../../../shared/restrictions-types";

export const isGroup = (p: Person) => p.team !== undefined;
export const GROUPS: Person[] = [
  { team: true, name: "Teammates" },
  { team: false, name: "Outsiders" },
];
export const REACHES_IN_LISTING_ORDER: { reach: Reach; label: string }[] = [
  { reach: "slack", label: "On Slack" },
  { reach: "email", label: "By email" },
  { reach: "github", label: "On GitHub" },
];

export function personName(p: Person) {
  if (p.team === true) return "Teammates";
  if (p.team === false) return "Outsiders";
  return [p.name, p.email, p.github, p.slack].find(hasText) ?? "";
}

export const isReachableBy = (p: Person, reach: Reach) => isGroup(p) || hasText(p[reach]);

function nameInALabel(p: Person) {
  if (p.team === true) return "teammates";
  if (p.team === false) return "outsiders";
  return hasText(p.slack) ? (personName(p).split(/\s+/, 1)[0] ?? "") : personName(p);
}

export function labelForPerson(r: Restriction, p: Person) {
  if (!hasText(r.forPerson)) return r.label;
  const name = nameInALabel(p);
  const possessive = /s$/i.test(name) ? `${name}'` : `${name}'s`;
  return r.forPerson.replace("{name's}", () => possessive).replace("{name}", () => name);
}

const isSameId = (a: string | undefined, b: string | undefined) => hasText(a) && a.toLowerCase() === b?.toLowerCase();

export function isSamePerson(a: Person, b: Person) {
  if (isGroup(a) || isGroup(b)) return a.team === b.team;
  return (hasText(a.slack) && a.slack === b.slack) || isSameId(a.email, b.email) || isSameId(a.github, b.github);
}

export function sourceOf(p: Person) {
  if (p.team === true) return "everyone on the team";
  if (p.team === false) return "everyone known not to be on it";
  if (hasText(p.slack)) return hasText(p.github) ? `Slack · GitHub ${p.github}` : "Slack";
  return hasText(p.email) ? "email" : "GitHub";
}

export function accountKind(p: Person) {
  if (hasText(p.slack)) return "Slack";
  return hasText(p.email) ? "email" : "GitHub";
}

export const isAboutWhoNotWhere = (o: Restriction) => (o.scope?.people?.length ?? 0) > 0 && !hasText(o.scope?.objective) && !hasText(o.scope?.cwd);

export const peopleIn = (o: Restriction) => o.scope?.people ?? [];

function faceUrl(p: Person) {
  if (hasText(p.slack)) return `/api/avatar/slack/${p.slack}?name=${encodeURIComponent(p.name ?? "")}`;
  return hasText(p.github) ? `https://avatars.githubusercontent.com/${p.github}?s=40` : undefined;
}

const initialsOf = (p: Person) =>
  personName(p)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .map(w => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function PersonFace({ p, className }: { p: Person; className?: string }) {
  const [isBroken, setBroken] = useState(false);
  const src = faceUrl(p);
  const box = cn("size-4 shrink-0 rounded-full", className);
  if (isGroup(p)) {
    const Icon = p.team === true ? Users : Globe;
    return (
      <span className={cn(box, "flex items-center justify-center bg-muted-foreground/15")}>
        <Icon className="size-2.5" />
      </span>
    );
  }
  if (!isBroken && hasText(src)) return <img src={src} alt="" onError={() => setBroken(true)} className={cn(box, "object-cover")} />;
  return <span className={cn(box, "flex items-center justify-center bg-tile-2 text-[8px] font-semibold text-tile-ink")}>{initialsOf(p)}</span>;
}
