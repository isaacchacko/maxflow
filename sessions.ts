import type { ServerWebSocket, Subprocess } from "bun";

export type Session = {
  id: string;
  name: string;
  cmd: string[];
  cwd: string;
  createdAt: number;
  lastOutputAt: number;
  proc: Subprocess;
  chunks: Uint8Array[];
  bytes: number;
  clients: Set<ServerWebSocket<WsData>>;
  exitCode: number | null;
  chatId?: string;
  lastScreen?: string;
  inbox: string[];
  // Reported by the Claude Code hooks in hooks/claude-state.sh; unset while no claude runs in the session.
  claude?: { state: ClaudeState; at: number };
  transcript?: string;
  links?: { found: Candidate[]; offset: number; at: number; repo?: string };
  archived?: boolean;
  // The chat an archived agent was stopped in to free its memory; unarchiving resumes it.
  asleep?: string;
  // Whether claude itself runs in the pane, from the process table (checkClaude); unset until the first check.
  claudeUp?: boolean;
  sentry?: boolean;
  // What the agent declared it waits on with `maxflow wait`; it sleeps (archived) from the end of its turn until a message wakes it.
  wait?: Wait;
  // When the inbox last typed messages from agents or sentries (not the user's own request) into the prompt.
  peerTurnAt?: number;
  // When the inbox last pasted into the prompt, and how many times since it pressed Enter again on a paste left unsent.
  pastedAt?: number;
  enterRetries?: number;
  // The inbox messages last pasted, which stay queued until the transcript shows them as a prompt; how often they were sent again.
  sending?: { count: number; text: string; at: number };
  resends?: number;
  // A draft the user left in the prompt while messages waited: what it says and since when, when messages first queued behind it,
  // and the draft cleared out of the way to deliver them, to be typed back once that turn ends (also kept in ~/.maxflow/drafts).
  draft?: { text: string; since: number };
  blockedSince?: number;
  // The thread whose message it was last handed (his reply, a routed request, a feed item): where its ask goes by default.
  handed?: string;
  // The last reply of the turn the Mac's sleep cut off, once it was told to carry on, so each cut-off is carried on once.
  cutOff?: string;
  savedDraft?: string;
  // Where it sits in the routing: a router owns a scope of an objective, a worker is its router's.
  role?: Role;
};
// merged: a router that came in with an objective merged into this one; it keeps its own threads but not the objective's routing.
export type Role = { role: "router" | "worker"; objective: string; parent?: string; scope?: string; merged?: boolean; handedTo?: string };
// awake: a message woke it; it goes back to sleep on the same wait when that turn ends, until the awaited event itself clears it.
// auto: a done the server set when a turn ended with no wait declared, not one the agent ran. An agent wait's ref may name several
// agents, comma-separated; any of them ends it.
// until: ref is the shell it waits on (see Shell), desc what the agent said it waits for.
export type Wait = { kind: "thread" | "approval" | "ci" | "agent" | "slack" | "until" | "done"; ref: string; at: number; desc?: string; awake?: boolean; auto?: boolean };
export type ClaudeState = "working" | "waiting" | "idle";

// Each browser tab gets its own tmux client, so tmux hands it the full terminal state (modes, screen) on connect.
// world: a browser tab following the world (/api/world/ws), not a terminal.
export type WsData = { id: string; pty?: Subprocess; world?: true };

export const sessions = new Map<string, Session>();

export const isSentry = (s: Session) => !!s.sentry;
export const isAgent = (s: Session) => !!s.claude || !!s.chatId || !!s.asleep || s.cmd[0] === "claude";
export const chatOf = (s: Session) => s.chatId ?? s.transcript?.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];

// Candidate URLs a session has mentioned, PRs named by number included, oldest first, each with who wrote it and the text around it, for sentry:graph to judge.
// Agents are read from their transcript, since claude hard-wraps long URLs on screen; shells from tmux history, which -J rejoins.
// Only text the user or claude wrote counts, not tool output.
export type Candidate = { url: string; role: string; context: string };
