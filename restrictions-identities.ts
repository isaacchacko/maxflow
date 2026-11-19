import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./instance";
import { samePerson, type Person, type Restriction } from "./restrictions";
import { ghStatusTable } from "./state";

// The people his restrictions can name, one per human: each Slack user the slack sentry has heard from, joined to their GitHub
// login when the two are clearly the same person, or when he linked them by hand. A login joins a Slack user automatically
// when the user's full name (two words or more) spells the login ("Felix Bose", felix-bose) or is the name on the login's
// GitHub profile, and only when exactly one Slack user fits. He can link a miss or unlink a wrong match; both are kept in
// people-links.json, with the GitHub profile names looked up so far.
type Pair = { slack: string; github: string };
type Links = { links: Pair[]; unlinks: Pair[]; ghNames: Record<string, string | null> };

const file = (dir: string) => join(dir, "people-links.json");
const read = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const loadLinks = (dir: string): Links => ({ links: [], unlinks: [], ghNames: {}, ...read<Partial<Links>>(file(dir), {}) });
const saveLinks = (l: Links, dir: string) => writeFileSync(file(dir), JSON.stringify(l, null, 2));
const samePair = (a: Pair, b: Pair) => a.slack === b.slack && a.github.toLowerCase() === b.github.toLowerCase();

const slug = (s: string) => s.normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const words = (s: string) => s.trim().split(/\s+/).length;

function seen(dir: string) {
  const slack = new Map<string, string>();
  const store = read<Record<string, { msgs: { uid: string; who: string; bot?: boolean }[] }>>(join(dir, "slack-messages.json"), {});
  for (const { msgs } of Object.values(store)) for (const m of msgs) if (!m.bot && /^[UW]/.test(m.uid)) slack.set(m.uid, m.who);
  const github = new Map<string, string>();
  type Login = { login: string } | null | undefined;
  const gh = ghStatusTable.all() as Record<string, { pr?: { author?: Login; reviews?: { nodes: { author: Login }[] }; comments?: { nodes: { author: Login }[] } } }>;
  for (const { pr } of Object.values(gh))
    for (const a of [pr?.author, ...(pr?.reviews?.nodes ?? []).map((n) => n.author), ...(pr?.comments?.nodes ?? []).map((n) => n.author)])
      if (a?.login && !a.login.endsWith("[bot]")) github.set(a.login.toLowerCase(), a.login);
  return { slack, github };
}

// GitHub profile names, looked up once a login, in the background; a lookup that fails is tried again on the next listing.
const looking = new Set<string>();
function lookUpNames(logins: string[], dir: string) {
  for (const login of logins) {
    if (looking.has(login)) continue;
    looking.add(login);
    const p = Bun.spawn(["timeout", "-s", "KILL", "15", "gh", "api", `users/${login}`, "--jq", ".name // \"\""], { stdout: "pipe", stderr: "ignore" });
    void new Response(p.stdout).text().then(async (out) => {
      if ((await p.exited) === 0) {
        const l = loadLinks(dir);
        l.ghNames[login.toLowerCase()] = out.trim() || null;
        saveLinks(l, dir);
      }
      looking.delete(login);
    });
  }
}

/** Everyone, one entry a person: name, Slack id and GitHub login where known; linked says how the two were joined. */
export function people(dir = STATE_DIR): (Person & { linked?: "auto" | "manual" })[] {
  const { slack, github } = seen(dir);
  const l = loadLinks(dir);
  lookUpNames([...github.values()].filter((g) => !(g.toLowerCase() in l.ghNames)), dir);
  const pairs = new Map<string, { github: string; linked: "auto" | "manual" }>();
  for (const p of l.links) if (slack.has(p.slack)) pairs.set(p.slack, { github: github.get(p.github.toLowerCase()) ?? p.github, linked: "manual" });
  const taken = () => new Set([...pairs.values()].map((p) => p.github.toLowerCase()));
  for (const [key, login] of github) {
    if (taken().has(key)) continue;
    const profile = l.ghNames[key];
    const fits = [...slack].filter(([uid, name]) => !pairs.has(uid) && words(name) >= 2 && (slug(name) === slug(login) || (!!profile && words(profile) >= 2 && slug(profile) === slug(name))));
    if (fits.length === 1 && !l.unlinks.some((u) => samePair(u, { slack: fits[0]![0], github: login }))) pairs.set(fits[0]![0], { github: login, linked: "auto" });
  }
  const linked = taken();
  return [
    ...[...slack].map(([uid, name]) => ({ name, slack: uid, ...(pairs.has(uid) && { github: pairs.get(uid)!.github, linked: pairs.get(uid)!.linked }) })),
    ...[...github].filter(([key]) => !linked.has(key)).map(([, login]) => ({ name: login, github: login })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** Links a Slack user to a GitHub login, or unlinks them; an unlink also stops the automatic match from coming back. */
export function link(pair: Pair, linked: boolean, dir = STATE_DIR) {
  const l = loadLinks(dir);
  l.links = l.links.filter((p) => !samePair(p, pair) && p.slack !== pair.slack && p.github.toLowerCase() !== pair.github.toLowerCase());
  l.unlinks = l.unlinks.filter((p) => !samePair(p, pair));
  (linked ? l.links : l.unlinks).push(pair);
  saveLinks(l, dir);
}

/**
 * Gives every person a restriction names both of their accounts, so it applies whichever one a call reaches; after an unlink,
 * an entry holding both keeps its Slack id. Answers whether anything changed.
 */
export function backfill(list: Restriction[], unlinked?: Pair, dir = STATE_DIR) {
  const everyone = existsSync(dir) ? people(dir) : [];
  let changed = false;
  for (const r of list)
    for (const p of r.scope?.people ?? []) {
      if (p.team) continue;
      if (unlinked && p.slack === unlinked.slack && p.github?.toLowerCase() === unlinked.github.toLowerCase()) {
        delete p.github;
        changed = true;
        continue;
      }
      const m = everyone.find((o) => samePerson(o, p));
      if (m?.slack && !p.slack) (p.slack = m.slack), (changed = true);
      if (m?.github && !p.github) (p.github = m.github), (changed = true);
    }
  return changed;
}
