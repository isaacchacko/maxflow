import { type Event, onPublish, query } from "./bus";
import { isOwnComment } from "./gh";
import { isRecord } from "./shared/guards";
import { readStateJson, writeStateJson } from "./state";

const FEEDBACK_FILE = "pr-feedback.json";
const PR_EVENT = /^gh\/[^/]+\/[^/]+\/pr\/\d+\/(\w+)$/;
const POSTS = new Set(["comment", "thread", "review"]);

export type PrFeedback = { id: string; at: number; url: string; body: string; told: string[]; replied: number | null; pushed: number | null };

const isFeedback = (value: unknown): value is Record<string, PrFeedback> => isRecord(value);
const feedback = new Map(Object.entries(readStateJson(FEEDBACK_FILE, isFeedback) ?? {}));

const textIn = (data: Record<string, unknown>, key: string) => (typeof data[key] === "string" ? data[key] : "");
const toldIn = (data: Record<string, unknown>) => (Array.isArray(data["told"]) ? data["told"].filter((x): x is string => typeof x === "string") : []);

function recordHisComment(pr: string, ev: Event, data: Record<string, unknown>) {
  if (textIn(data, "body").trim() === "" || feedback.get(pr)?.id === textIn(data, "id")) return;
  feedback.set(pr, { id: textIn(data, "id"), at: ev.at, url: textIn(data, "url"), body: textIn(data, "body").slice(0, 300), told: toldIn(data), replied: null, pushed: null });
}

function recordAnswer(pr: string, kind: string, ev: Event) {
  const was = feedback.get(pr);
  if (!was || ev.at < was.at) return;
  if (kind === "push") feedback.set(pr, { ...was, pushed: was.pushed ?? ev.at });
  else feedback.set(pr, { ...was, replied: was.replied ?? ev.at });
}

function isAgentPost(kind: string, data: Record<string, unknown>) {
  return POSTS.has(kind) && data["who"] === null && !textIn(data, "author").endsWith("[bot]");
}

function take(ev: Event): boolean {
  const kind = PR_EVENT.exec(ev.topic)?.[1];
  const data = isRecord(ev.data) ? ev.data : {};
  const pr = textIn(data, "pr");
  if (kind === undefined || pr === "") return false;
  const who = typeof data["who"] === "string" ? data["who"] : undefined;
  if (POSTS.has(kind) && isOwnComment(who)) recordHisComment(pr, ev, data);
  else if (kind === "push" || isAgentPost(kind, data)) recordAnswer(pr, kind, ev);
  else return false;
  return true;
}

const save = () => {
  writeStateJson(FEEDBACK_FILE, Object.fromEntries(feedback));
};

export function keepPrFeedback() {
  void query("gh/**", 0, 0).then((kept) => {
    if (kept.map(take).includes(true)) save();
  });
  onPublish.add((ev) => {
    if (take(ev)) save();
  });
}

export const feedbackOn = (pr: string) => feedback.get(pr) ?? null;
