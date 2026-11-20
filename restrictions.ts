import { homedir } from "node:os";
import { hasState, readStateText, writeStateText } from "./state";
import { CATALOG_WORDS, SEED } from "./restrictions-catalog";
import { commandStarts, shellText } from "./restrictions-shell";
import type { Call, Person, Restriction } from "./shared/restrictions-types";

export type { Call, Exception, Mode, Person, Reach, Restriction } from "./shared/restrictions-types";
export { SEED } from "./restrictions-catalog";

export const MODES = ["allow", "ask", "deny"] as const;
const MODE_NAMES: ReadonlySet<string> = new Set(MODES);
const REACHES: ReadonlySet<string> = new Set(["slack", "email", "github"]);

const RESTRICTIONS_FILE = "restrictions.json";
const SEEDED_IDS_FILE = "restrictions-seeded.json";
const writeStateFile = (name: string, text: string) => {
  writeStateText(name, text);
};

const isSet = (value: string | null | undefined): value is string => value !== undefined && value !== null && value !== "";
const hasAny = (values: readonly unknown[] | undefined) => (values?.length ?? 0) > 0;

export const saveRestrictions = (list: Restriction[]) => {
  writeStateFile(RESTRICTIONS_FILE, JSON.stringify(list, null, 2));
};

function seedCatalog() {
  saveRestrictions(SEED);
  writeStateFile(SEEDED_IDS_FILE, JSON.stringify(SEED.map((r) => r.id)));
  return structuredClone(SEED);
}

function parsedList(text: string): Restriction[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) throw new TypeError(`${RESTRICTIONS_FILE} holds no list of restrictions`);
  return parsed as Restriction[];
}

function seededIdsIn(seededText: string, list: Restriction[]): Set<string> {
  try {
    const parsed: unknown = JSON.parse(seededText);
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set(list.map((r) => r.id));
  }
  return new Set(list.map((r) => r.id));
}

function followingCatalog(kept: Restriction, builtin: Restriction): Restriction {
  const next = { ...kept };
  if (isSet(builtin.reaches)) {
    next.reaches = builtin.reaches;
    if (builtin.forPerson !== undefined) next.forPerson = builtin.forPerson;
  } else {
    delete next.reaches;
    delete next.forPerson;
  }
  const words = CATALOG_WORDS[builtin.id];
  if (words !== undefined) Object.assign(next, words);
  if (builtin.id === "mallory-phone" && next.label === "Mallory to his phone") next.label = builtin.label;
  return next;
}

function mergeCatalog(list: Restriction[], seeded: Set<string>): Restriction[] {
  const followedIds = new Set<string>();
  const merged = list.map((kept) => {
    const builtin = SEED.find((s) => s.id === kept.id);
    if (builtin === undefined || followedIds.has(kept.id)) return kept;
    followedIds.add(kept.id);
    return followingCatalog(kept, builtin);
  });
  for (const builtin of SEED) {
    const isNewToHim = !followedIds.has(builtin.id) && !seeded.has(builtin.id);
    if (isNewToHim && (!isSet(builtin.parent) || merged.some((o) => o.id === builtin.parent))) merged.push(structuredClone(builtin));
    seeded.add(builtin.id);
  }
  return merged;
}

export function loadRestrictions(): Restriction[] {
  if (!hasState(RESTRICTIONS_FILE)) return seedCatalog();
  const text = readStateText(RESTRICTIONS_FILE);
  const list = text === undefined ? undefined : parsedList(text);
  if (text === undefined || list === undefined) return structuredClone(SEED);
  const seededText = readStateText(SEEDED_IDS_FILE) ?? "";
  const seeded = seededIdsIn(seededText, list);
  const merged = mergeCatalog(list, seeded);
  // constraint: every hook process loads this on every tool call, so it writes only what the catalog changed
  if (JSON.stringify([...seeded]) !== seededText) writeStateFile(SEEDED_IDS_FILE, JSON.stringify([...seeded]));
  if (JSON.stringify(merged, null, 2) !== text) saveRestrictions(merged);
  return merged;
}

type RestrictionDraft = Partial<Restriction>;

const overriddenIn = (r: RestrictionDraft, list: Restriction[]) => list.find((o) => o.id === r.parent);
const patternsOf = (r: RestrictionDraft) => [...(r.match?.tools ?? []), ...(r.match?.bash ?? []), ...(r.match?.paths ?? [])];

function namingProblem(r: RestrictionDraft): string | null {
  if (!isSet(r.label?.trim())) return "label required";
  if (!isSet(r.action?.trim())) return "action required";
  if (!MODE_NAMES.has(r.mode ?? "")) return `mode: one of ${MODES.join(", ")}`;
  if (isSet(r.reaches) && !REACHES.has(r.reaches)) return "reaches: slack, email or github";
  return null;
}

function overrideProblem(r: RestrictionDraft, list: Restriction[]): string | null {
  if (!isSet(r.parent)) return null;
  if (list.every((o) => o.id !== r.parent || isSet(o.parent))) return `no restriction ${r.parent} to override`;
  if (!isSet(r.scope?.objective) && !isSet(r.scope?.cwd) && !hasAny(r.scope?.people)) return "an override needs people, an objective or a folder";
  return null;
}

const isUnidentified = (p: Person) => p.team === undefined && !isSet(p.slack) && !isSet(p.email) && !isSet(p.github);

function peopleProblem(r: RestrictionDraft, list: Restriction[]): string | null {
  const reaches = isSet(r.parent) ? overriddenIn(r, list)?.reaches : r.reaches;
  if (hasAny(r.scope?.people) && !isSet(reaches)) return "nobody is on the other end of this action, so it can't be set per person";
  if ((r.scope?.people ?? []).some((p) => isUnidentified(p))) return "a person needs a Slack id, an email or a GitHub login";
  return null;
}

function regexProblem(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (error) {
    return `bad regex ${pattern}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function matcherProblem(r: RestrictionDraft): string | null {
  const patterns = patternsOf(r);
  if (!isSet(r.parent) && patterns.length === 0) return "match needs a tools or bash regex";
  for (const pattern of patterns) {
    const problem = regexProblem(pattern);
    if (problem !== null) return problem;
  }
  return null;
}

export function invalid(r: RestrictionDraft, list: Restriction[] = []): string | undefined {
  const problem = namingProblem(r) ?? overrideProblem(r, list) ?? peopleProblem(r, list) ?? matcherProblem(r);
  return problem ?? undefined;
}

const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, () => homedir());

const isUnder = (cwd: string, prefix: string) => {
  const p = expandHome(prefix).replace(/\/+$/, "");
  return cwd === p || cwd.startsWith(`${p}/`);
};

function doesRegexMatch(pattern: string, text: string) {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

const doesWholeMatch = (pattern: string, text: string) => doesRegexMatch(`^(?:${pattern})$`, text);

function doesMatchAtACommandStart(pattern: string, command: string, starts: number[]) {
  try {
    const re = new RegExp(pattern, "y");
    return starts.some((start) => {
      re.lastIndex = start;
      return re.test(command);
    });
  } catch {
    return false;
  }
}

const lower = (s?: string) => s?.toLowerCase();

export const isSamePerson = (a: Person, b: Person) =>
  (isSet(a.slack) && a.slack === b.slack) || (isSet(a.email) && lower(a.email) === lower(b.email)) || (isSet(a.github) && lower(a.github) === lower(b.github));

const FIT_BY_NAME = 3;
const FIT_AS_TEAMMATE_OR_OUTSIDER = 2;
const FIT_WITHOUT_PEOPLE = 1;
const NO_FIT = 0;

function personFit(r: Restriction, who?: Person) {
  const people = r.scope?.people ?? [];
  if (people.length === 0) return FIT_WITHOUT_PEOPLE;
  if (!who) return NO_FIT;
  if (people.some((p) => p.team === undefined && isSamePerson(p, who))) return FIT_BY_NAME;
  return people.some((p) => p.team !== undefined && p.team === who.team) ? FIT_AS_TEAMMATE_OR_OUTSIDER : NO_FIT;
}

const matcherOf = (r: Restriction, list: Restriction[]) => (isSet(r.parent) ? list.find((o) => o.id === r.parent)?.match : r.match);

function isOnAMatchedPath(matcher: Restriction["match"], call: Call) {
  const paths = matcher.paths ?? [];
  if (paths.length === 0) return true;
  const path = call.input?.["file_path"] ?? call.input?.["notebook_path"];
  return typeof path === "string" && paths.some((p) => doesRegexMatch(p, path));
}

function doesBashMatch(matcher: Restriction["match"], call: Call) {
  const command = call.input?.["command"];
  if (typeof command !== "string" || call.tool !== "Bash") return false;
  const shown = shellText(command);
  const starts = commandStarts(shown);
  return (matcher.bash ?? []).some((p) => doesMatchAtACommandStart(p, shown, starts));
}

export function doesMatch(r: Restriction, call: Call, list: Restriction[] = []) {
  const matcher = matcherOf(r, list);
  if (matcher === undefined) return false;
  const isToolMatched = (matcher.tools ?? []).some((p) => doesWholeMatch(p, call.tool)) && isOnAMatchedPath(matcher, call);
  return isToolMatched || doesBashMatch(matcher, call);
}

function doesApply(r: Restriction, call: Call, who?: Person) {
  const objective = r.scope?.objective;
  const cwd = r.scope?.cwd;
  const isOnObjective = !isSet(objective) || objective === call.objective;
  const isInFolder = !isSet(cwd) || (isSet(call.cwd) && isUnder(call.cwd, cwd));
  return isOnObjective && isInFolder && personFit(r, who) > NO_FIT;
}

function personWeight(fit: number) {
  if (fit === FIT_BY_NAME) return 4e6;
  return fit === FIT_AS_TEAMMATE_OR_OUTSIDER ? 2e6 : 0;
}

function specificity(r: Restriction, who?: Person) {
  const cwd = r.scope?.cwd;
  return personWeight(personFit(r, who)) + (isSet(r.scope?.objective) ? 1e6 : 0) + (isSet(cwd) ? expandHome(cwd).length + 1 : 0);
}

type Verdict = { mode: (typeof MODES)[number]; restriction?: Restriction; person?: Person | undefined };

const strictness = (r: { mode: (typeof MODES)[number] }) => MODES.indexOf(r.mode);

function judge(list: Restriction[], call: Call, who?: Person): Verdict {
  const hits = list.filter((r) => doesMatch(r, call, list) && doesApply(r, call, who));
  const best = hits.toSorted((a, b) => {
    const bySpecificity = specificity(b, who) - specificity(a, who);
    return bySpecificity === 0 ? strictness(b) - strictness(a) : bySpecificity;
  })[0];
  return best ? { mode: best.mode, restriction: best, person: who } : { mode: "allow", person: who };
}

export function resolve(list: Restriction[], call: Call): Verdict {
  const people = call.people ?? [];
  const verdicts = people.length > 0 ? people.map((who) => judge(list, call, who)) : [judge(list, call)];
  return verdicts.reduce((a, b) => (strictness(b) > strictness(a) ? b : a));
}
