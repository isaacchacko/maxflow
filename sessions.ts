import type { ServerWebSocket, Subprocess } from "bun";

export type Session = {
  id: string;
  name: string;
  cmd: string[];
  cwd: string;
  createdAt: number;
  lastOutputAt: number;
  proc?: Subprocess;
  chunks: Uint8Array[];
  bytes: number;
  clients: Set<ServerWebSocket<WsData>>;
  exitCode: number | null;
  chatId?: string;
  lastScreen?: string;
  inbox: string[];
  claude?: { state: ClaudeState; at: number };
  transcript?: string;
  archived?: boolean;
  asleep?: string;
  sleptAt?: number;
  sleepHeld?: { what: string[]; at: number };
  claudeUp?: boolean;
  sentry?: boolean;
  wait?: Wait;
  peerTurnAt?: number;
  pastedAt?: number;
  enterRetries?: number;
  sending?: { count: number; text: string; at: number };
  resends?: number;
  draft?: { text: string; since: number };
  blockedSince?: number;
  handed?: string;
  cutOff?: string;
  savedDraft?: string;
  role?: Role;
};
export type Role = { role: "router" | "worker" | "owner"; objective: string; thread?: string; parent?: string; scope?: string; merged?: boolean; handedTo?: string; handedFrom?: string };
export type Wait = { kind: "thread" | "approval" | "ci" | "agent" | "slack" | "until" | "done"; ref: string; at: number; desc?: string; awake?: boolean; auto?: boolean };
export type ClaudeState = "working" | "waiting" | "idle";
export type WsData = { id: string; pty?: Subprocess; world?: true; browser?: true; isIsaac?: boolean };

export const sessions = new Map<string, Session>();

const isFilled = (text: string | undefined) => text !== undefined && text !== "";

export const isSentry = (s: Session) => s.sentry === true;
export const isAgent = (s: Session) => s.claude !== undefined || isFilled(s.chatId) || isFilled(s.asleep) || s.cmd[0] === "claude";
export const chatOf = (s: Session) => s.chatId ?? s.transcript?.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
export type Candidate = { url: string; role: string; context: string };
