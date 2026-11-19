import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { repoOf } from "./gh";
import { patch } from "./patch";
import { isRecord, stringOr } from "./shared/guards";
import { type Candidate, type Session, isSentry } from "./sessions";
import { tmux, tmuxName } from "./tmux";

const PROJECTS = `${homedir()}/.claude/projects`;
const URL_RE = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/g;
const MAX_CANDIDATES = 40;
const SHELL_LINKS_MS = 5000;
const CONTEXT_CHARS = 200;
const NEWLINE = 10;
const PR_NAMED_WITHOUT_URL_RE = /\b([\w.-]+\/[\w.-]+)#(\d+)\b|\bPR\s*#?(\d{2,})\b|(?<![\w/&#])#(\d{3,})\b/gi;
const GITHUB_PR_URL_RE = /^(https:\/\/github\.com\/)([\w.-]+\/[\w.-]+)(\/pull\/)/i;
const REPO_IN_COMMAND_RE = /(?:--repo[ =]|-R )([\w.-]+\/[\w.-]+)|(?:\bcd |git -C )(~?\/[\w./-]+)/g;

type Mention = { at: number; url: string; len: number };

const repos = new Map<string, string>();
function repoFor(cwd: string) {
  const known = repos.get(cwd);
  if (known !== undefined) return known;
  const repo = repoOf(cwd);
  repos.set(cwd, repo);
  return repo;
}

const withCaseInsensitiveOwnerAndRepoLowercased = (url: string) =>
  url.replace(GITHUB_PR_URL_RE, (_match, head: string, ownerAndRepo: string, pull: string) => `${head}${ownerAndRepo.toLowerCase()}${pull}`);

const isPlainHost = (url: string) => URL.canParse(url) && /^[\w.-]*\w(:\d+)?$/.test(new URL(url).host);

const urlMentions = (text: string): Mention[] =>
  text
    .matchAll(URL_RE)
    .map((m) => ({ at: m.index, url: withCaseInsensitiveOwnerAndRepoLowercased(m[0].replace(/[.,;:!?*_~]+$/, "").replace(/\/$/, "")), len: m[0].length }))
    .filter((c) => isPlainHost(c.url))
    .toArray();

function prMention(m: RegExpExecArray, sessionRepo: string): Mention | undefined {
  const repo = m[1]?.toLowerCase() ?? sessionRepo;
  if (repo === "") return;
  return { at: m.index, url: `https://github.com/${repo}/pull/${m[2] ?? m[3] ?? m[4] ?? ""}`, len: m[0].length };
}

const prMentions = (text: string, sessionRepo: string): Mention[] =>
  text
    .replaceAll(URL_RE, (u) => " ".repeat(u.length))
    .matchAll(PR_NAMED_WITHOUT_URL_RE)
    .map((m) => prMention(m, sessionRepo))
    .filter((c) => c !== undefined)
    .toArray();

function candidatesIn(text: string, role: string, repo: string): Candidate[] {
  const around = (at: number, len: number) =>
    text
      .slice(Math.max(0, at - CONTEXT_CHARS), at + len + CONTEXT_CHARS)
      .replaceAll(/\s+/g, " ")
      .trim();
  return [...urlMentions(text), ...prMentions(text, repo)].toSorted((a, b) => a.at - b.at).map((c) => ({ url: c.url, role, context: around(c.at, c.len) }));
}

function addCandidatesNewestLast(list: Candidate[], found: Candidate[]) {
  for (const c of found) {
    const i = list.findIndex((o) => o.url === c.url);
    if (i !== -1) list.splice(i, 1);
    list.push(c);
  }
  list.splice(0, Math.max(0, list.length - MAX_CANDIDATES));
}

const contentOf = (rec: Record<string, unknown>) => (isRecord(rec["message"]) ? rec["message"]["content"] : undefined);
const ofBlockType = (type: string) => (block: unknown): block is Record<string, unknown> => isRecord(block) && block["type"] === type;
const expandHome = (path: string) => (path.startsWith("~") ? `${homedir()}${path.slice(1)}` : path);

function repoOfLatestCommand(rec: Record<string, unknown>) {
  const content = contentOf(rec);
  if (rec["type"] !== "assistant" || !Array.isArray(content)) return "";
  const hint = content
    .filter(ofBlockType("tool_use"))
    .flatMap((block) => JSON.stringify(block["input"] ?? {}).matchAll(REPO_IN_COMMAND_RE).toArray())
    .at(-1);
  if (hint === undefined) return "";
  const [, repo, dir = ""] = hint;
  return repo === undefined ? repoFor(expandHome(dir)) : repo.toLowerCase();
}

function textOf(rec: Record<string, unknown>) {
  if (Boolean(rec["isMeta"]) || Boolean(rec["isSidechain"]) || (rec["type"] !== "user" && rec["type"] !== "assistant")) return "";
  const content = contentOf(rec);
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(ofBlockType("text"))
    .map((block) => block["text"])
    .join("\n");
}

const hasPossibleMention = (line: string) => line.includes("http") || line.includes("#") || /\bPR\b/i.test(line) || line.includes("tool_use");

function parseRecord(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readFrom(path: string, offset: number) {
  try {
    const size = statSync(path).size;
    const start = size < offset ? 0 : offset;
    const buf = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    return { buf, start };
  } catch {
    return null;
  }
}

class SessionMentions {
  private offset = 0;
  private repo = "";
  found: Candidate[] = [];
  checkedAt = 0;

  private addFromRecord(rec: unknown, cwd: string) {
    if (!isRecord(rec)) return;
    this.repo = repoOfLatestCommand(rec) || this.repo;
    addCandidatesNewestLast(this.found, candidatesIn(textOf(rec), stringOr(rec["type"]), repoFor(cwd) || this.repo));
  }
  readAppendedTranscript(path: string, cwd: string) {
    const read = readFrom(path, this.offset);
    if (read === null) return;
    this.offset = read.start;
    const endOfLastFullLine = read.buf.lastIndexOf(NEWLINE) + 1;
    if (endOfLastFullLine === 0) return;
    this.offset += endOfLastFullLine;
    const lines = read.buf.subarray(0, endOfLastFullLine).toString("utf8").split("\n").filter(hasPossibleMention);
    for (const line of lines) this.addFromRecord(parseRecord(line), cwd);
  }


  rereadScreen(s: Session) {
    this.checkedAt = Date.now();
    this.found = [];
    const lines = tmux("capture-pane", "-p", "-J", "-t", tmuxName(s.id), "-S", "-2000").out.split("\n");
    for (const line of lines) addCandidatesNewestLast(this.found, candidatesIn(line, "screen", repoFor(s.cwd)));
  }

}

const mentionsBySession = new WeakMap<Session, SessionMentions>();
function mentionsOf(s: Session) {
  const known = mentionsBySession.get(s);
  if (known) return known;
  const mentions = new SessionMentions();
  mentionsBySession.set(s, mentions);
  return mentions;
}

const isFilled = (text: string | undefined): text is string => text !== undefined && text !== "";

const resumedChatTranscript = (chatId: string) => Array.from(new Bun.Glob(`*/${chatId}.jsonl`).scanSync(PROJECTS), (f) => `${PROJECTS}/${f}`)[0];

export function candidates(s: Session): Candidate[] {
  if (isSentry(s)) return [];
  const mentions = mentionsOf(s);
  if (!isFilled(s.transcript) && isFilled(s.chatId) && mentions.checkedAt === 0) {
    mentions.checkedAt = Date.now();
    const transcript = resumedChatTranscript(s.chatId);
    if (transcript !== undefined) patch(s, { transcript });
  }
  if (isFilled(s.transcript)) mentions.readAppendedTranscript(s.transcript, s.cwd);
  else if (s.exitCode === null && s.lastOutputAt > mentions.checkedAt && Date.now() - mentions.checkedAt > SHELL_LINKS_MS) mentions.rereadScreen(s);
  return mentions.found;
}
