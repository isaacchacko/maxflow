export type ReviewPr = {
  url: string;
  title: string;
  author: string;
  why: "review" | "assigned";
  requested: number;
  updated: number;
  gone?: number | undefined;
  agent?: string | undefined;
  risk?: string | undefined;
};
export type Question = { key: string; at: number; who: string; text: string; link: string };
export type Routed = {
  task: number;
  key: string;
  source: "slack" | "slack bot" | "ci" | "github" | "review request";
  who: string;
  where: string;
  text: string;
  link: string;
  at?: number | undefined;
  user?: string | undefined;
  raw?: string | undefined;
};
export type Said = { at: number; who: string; text: string; mine?: boolean; user?: string | undefined; raw?: string | undefined; link?: string | undefined };
export type State = {
  seq: number;
  tasks: Record<string, number>;
  prs: Record<string, ReviewPr>;
  questions: Record<string, Question>;
  answered: Record<string, number>;
  seen: string[];
  flagged: string[];
  alerts: Record<string, { count: number; noted: number }>;
  open: Record<string, string>;
  reruns: string[];
  batch: Routed[];
  batchAt: number;
  feedThreads: Record<string, string>;
  dmBursts: Record<string, { start: number; last: number }>;
  convo: Record<string, Said[]>;
  ctxSent: Record<string, number>;
  prsAt: number;
  stallAt: number;
};

export const state: State = {
  seq: 0,
  tasks: {},
  prs: {},
  questions: {},
  answered: {},
  seen: [],
  flagged: [],
  alerts: {},
  open: {},
  reruns: [],
  batch: [],
  batchAt: 0,
  feedThreads: {},
  dmBursts: {},
  convo: {},
  ctxSent: {},
  prsAt: 0,
  stallAt: 0,
};

export const slackNamesById: Record<string, string> = {};
