import { isSamePerson, type Person, type Restriction } from "./restrictions";
import { isRecord } from "./shared/guards";
import { ghStatusTable, hasState, readStateJson, slackMessagesTable, writeStateJson } from "./state";

type Pair = { slack: string; github: string };
type Links = { links: Pair[]; unlinks: Pair[]; ghNames: Record<string, string | null> };
type Linked = "auto" | "manual";
type ProfileLookup = { stdout: ReadableStream<Uint8Array>; exited: Promise<number> };

const LINKS_FILE = "people-links.json";

const isPartialLinks = (value: unknown): value is Partial<Links> => isRecord(value);
const loadLinks = (): Links => ({ links: [], unlinks: [], ghNames: {}, ...readStateJson(LINKS_FILE, isPartialLinks) });
const saveLinks = (l: Links) => {
  writeStateJson(LINKS_FILE, l);
};
const isSamePair = (a: Pair, b: Pair) => a.slack === b.slack && a.github.toLowerCase() === b.github.toLowerCase();
const isSet = (value: string | null | undefined): value is string => value !== undefined && value !== null && value !== "";

const slug = (s: string) => s.normalize("NFD").replaceAll(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const wordCount = (s: string) => s.trim().split(/\s+/).length;

function slackNamesById() {
  const slack = new Map<string, string>();
  for (const { msgs } of Object.values(slackMessagesTable.all())) for (const m of msgs) if (m.bot !== true && /^[UW]/.test(m.uid)) slack.set(m.uid, m.who);
  return slack;
}

const loginOf = (author: unknown) => (isRecord(author) && typeof author["login"] === "string" ? author["login"] : undefined);
const authorsOf = (connection: unknown): unknown[] => {
  const nodes = isRecord(connection) ? connection["nodes"] : undefined;
  return Array.isArray(nodes) ? nodes.map((n) => (isRecord(n) ? n["author"] : undefined)) : [];
};

function loginsOn(entry: unknown) {
  const pr = isRecord(entry) ? entry["pr"] : undefined;
  if (!isRecord(pr)) return [];
  return [pr["author"], ...authorsOf(pr["reviews"]), ...authorsOf(pr["comments"])].map((author) => loginOf(author));
}

function githubLoginsByKey() {
  const github = new Map<string, string>();
  const statuses: Record<string, unknown> = ghStatusTable.all();
  for (const entry of Object.values(statuses))
    for (const login of loginsOn(entry)) if (isSet(login) && !login.endsWith("[bot]")) github.set(login.toLowerCase(), login);
  return github;
}

const lookingUp = new Set<string>();

async function recordProfileName(login: string, lookup: ProfileLookup) {
  const out = await new Response(lookup.stdout).text();
  if ((await lookup.exited) !== 0) return;
  const l = loadLinks();
  const name = out.trim();
  l.ghNames[login.toLowerCase()] = name === "" ? null : name;
  saveLinks(l);
  lookingUp.delete(login);
}

function lookUpProfileNamesInTheBackground(logins: string[]) {
  for (const login of logins) {
    if (lookingUp.has(login)) continue;
    lookingUp.add(login);
    const lookup = Bun.spawn(["timeout", "-s", "KILL", "15", "gh", "api", `users/${login}`, "--jq", '.name // ""'], { stdout: "pipe", stderr: "ignore" });
    void recordProfileName(login, lookup);
  }
}

type Paired = Map<string, { github: string; linked: Linked }>;
const takenLogins = (pairs: Paired) => new Set(pairs.values().map((p) => p.github.toLowerCase()));

function doesNameFit(name: string, login: string, profile: string | null | undefined) {
  if (wordCount(name) < 2) return false;
  return slug(name) === slug(login) || (isSet(profile) && wordCount(profile) >= 2 && slug(profile) === slug(name));
}

function linkAutomatically(pairs: Paired, slack: Map<string, string>, github: Map<string, string>, l: Links) {
  for (const [key, login] of github) {
    if (takenLogins(pairs).has(key)) continue;
    const fits = [...slack].filter(([uid, name]) => !pairs.has(uid) && doesNameFit(name, login, l.ghNames[key]));
    const uid = fits.length === 1 ? fits[0]?.[0] : undefined;
    if (uid !== undefined && l.unlinks.every((u) => !isSamePair(u, { slack: uid, github: login }))) pairs.set(uid, { github: login, linked: "auto" });
  }
}

export function people(): (Person & { linked?: Linked })[] {
  const slack = slackNamesById();
  const github = githubLoginsByKey();
  const l = loadLinks();
  lookUpProfileNamesInTheBackground(github.values().filter((g) => !Reflect.has(l.ghNames, g.toLowerCase())).toArray());
  const pairs: Paired = new Map();
  for (const p of l.links) if (slack.has(p.slack)) pairs.set(p.slack, { github: github.get(p.github.toLowerCase()) ?? p.github, linked: "manual" });
  linkAutomatically(pairs, slack, github, l);
  const linked = takenLogins(pairs);
  const slackPeople = [...slack].map(([uid, name]) => {
    const pair = pairs.get(uid);
    return { name, slack: uid, ...(pair && { github: pair.github, linked: pair.linked }) };
  });
  const githubOnly = [...github].filter(([key]) => !linked.has(key)).map(([, login]) => ({ name: login, github: login }));
  return [...slackPeople, ...githubOnly].toSorted((a, b) => a.name.localeCompare(b.name));
}

export function link(pair: Pair, isLinked: boolean) {
  const l = loadLinks();
  l.links = l.links.filter((p) => !isSamePair(p, pair) && p.slack !== pair.slack && p.github.toLowerCase() !== pair.github.toLowerCase());
  l.unlinks = l.unlinks.filter((p) => !isSamePair(p, pair));
  (isLinked ? l.links : l.unlinks).push(pair);
  saveLinks(l);
}

const isTheUnlinkedPair = (p: Person, unlinked: Pair | undefined) =>
  unlinked !== undefined && p.slack === unlinked.slack && p.github?.toLowerCase() === unlinked.github.toLowerCase();

export function backfill(list: Restriction[], unlinked?: Pair) {
  const everyone = hasState(".") ? people() : [];
  const named = list.flatMap((r) => r.scope?.people ?? []);
  let hasChanged = false;
  for (const person of named) {
    if (person.team === true) continue;
    if (isTheUnlinkedPair(person, unlinked)) {
      delete person.github;
      hasChanged = true;
      continue;
    }
    const match = everyone.find((o) => isSamePerson(o, person));
    const slack = match?.slack;
    const github = match?.github;
    if (isSet(slack) && !isSet(person.slack)) {
      person.slack = slack;
      hasChanged = true;
    }
    if (!isSet(github) || isSet(person.github)) continue;
    person.github = github;
    hasChanged = true;
  }
  return hasChanged;
}
