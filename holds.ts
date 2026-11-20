import { isRecord } from "./shared/guards";
import { hasState, peekStateJson, writeStateJson } from "./state";

export type Hold = { at: number; by: string; why: string };
type Holds = Record<string, Hold>;

const HOLDS_FILE = "pr-holds.json";
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const PR_KEY = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

const isHolds = (value: unknown): value is Holds => isRecord(value) && Object.values(value).every((h) => isRecord(h) && typeof h["at"] === "number");

export const prKey = (repo: string, n: number | string) => `${repo}#${String(n)}`.toLowerCase();

export function prKeyOf(ref: string, repoHere: () => string): string | undefined {
  const url = PR_URL.exec(ref) ?? PR_KEY.exec(ref);
  if (url) return prKey(url[1] ?? "", url[2] ?? "");
  return /^#?\d+$/.test(ref) ? prKey(repoHere(), ref.replace("#", "")) : undefined;
}

// constraint: a hold gates outward actions, so an unreadable file holds every PR rather than none
const UNREADABLE: Hold = { at: 0, by: "yarn", why: `${HOLDS_FILE} is unreadable, so every PR is held until it's fixed` };

function read(): Holds | undefined {
  const all = peekStateJson(HOLDS_FILE);
  if (isHolds(all)) return all;
  return hasState(HOLDS_FILE) ? undefined : {};
}

export function holds(): Holds {
  const all = read();
  if (all === undefined) throw new Error(UNREADABLE.why);
  return all;
}

export function holdOn(key: string): Hold | undefined {
  const all = read();
  return all === undefined ? UNREADABLE : all[key.toLowerCase()];
}

export const isHeld = (key: string) => holdOn(key) !== undefined;

export function hold(key: string, by: string, why: string) {
  writeStateJson(HOLDS_FILE, { ...holds(), [key.toLowerCase()]: { at: Date.now(), by, why } });
}

export function didUnhold(key: string): boolean {
  const all = holds();
  const kept = Object.entries(all).filter(([held]) => held !== key.toLowerCase());
  if (kept.length === Object.keys(all).length) return false;
  writeStateJson(HOLDS_FILE, Object.fromEntries(kept));
  return true;
}
