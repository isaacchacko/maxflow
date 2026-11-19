import { isRecord } from "../../../shared/guards";
import type { Call, Mode, Person, Restriction } from "../../../shared/restrictions-types";

export type Repo = { path: string; name: string };
export type Preview = { checked: number; count: number; caught: { tool: string; text: string; at: string }[] };
export type Verdict = { mode: Mode; restriction?: Restriction };

const isRestriction = (value: unknown): value is Restriction => isRecord(value) && typeof value["id"] === "string";
const isPerson = (value: unknown): value is Person => isRecord(value);
const isRepo = (value: unknown): value is Repo => isRecord(value) && typeof value["path"] === "string";
const isPreview = (value: unknown): value is Preview => isRecord(value) && typeof value["count"] === "number" && Array.isArray(value["caught"]);
const isVerdict = (value: unknown): value is Verdict => isRecord(value) && typeof value["mode"] === "string";
const listOf =
  <T>(isItem: (value: unknown) => value is T) =>
  (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(isItem);

function expected<T>(value: unknown, isExpected: (value: unknown) => value is T, what: string): T {
  if (!isExpected(value)) throw new Error(`The server didn't answer with ${what}`);
  return value;
}

async function send(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  const answer: unknown = await res.json();
  return answer;
}

export const loadRestrictions = async () => expected(await send("/api/restrictions", "GET"), listOf(isRestriction), "restrictions");
export const patchRestriction = async (id: string, change: Partial<Restriction>) => send(`/api/restrictions/${id}`, "PATCH", change);
export const deleteRestriction = async (id: string) => send(`/api/restrictions/${id}`, "DELETE");
export const postRestriction = async (r: Partial<Restriction>) => expected(await send("/api/restrictions", "POST", r), isRestriction, "a restriction");
export const previewMatch = async (match: unknown) => expected(await send("/api/restrictions/preview", "POST", { match }), isPreview, "a preview");
export const checkCall = async (call: Call) => expected(await send("/api/restrictions/check", "POST", call), isVerdict, "a verdict");
export const linkPeople = async (pair: { slack: string; github: string }, isLinked: boolean) =>
  expected(await send("/api/restrictions/people/link", isLinked ? "POST" : "DELETE", pair), listOf(isPerson), "people");

const oncePerPageLoad: { repos?: Promise<Repo[]> | undefined; people?: Promise<Person[]> | undefined } = {};

async function fetchRepos() {
  try {
    return expected(await send("/api/restrictions/repos", "GET"), listOf(isRepo), "repositories");
  } catch {
    oncePerPageLoad.repos = undefined;
    return [];
  }
}

async function fetchPeople() {
  try {
    return expected(await send("/api/restrictions/people", "GET"), listOf(isPerson), "people");
  } catch {
    oncePerPageLoad.people = undefined;
    return [];
  }
}

export const knownRepos = async () => (oncePerPageLoad.repos ??= fetchRepos());
export const knownPeople = async () => (oncePerPageLoad.people ??= fetchPeople());
export const rememberPeople = (everyone: Person[]) => {
  oncePerPageLoad.people = Promise.resolve(everyone);
};
