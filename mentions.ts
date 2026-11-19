import { closeSync, openSync, readSync, statSync } from "node:fs";
import { repoOf } from "./gh";
import { tmux, tmuxName } from "./tmux";
import { type Candidate, type Session, isSentry } from "./sessions";

const PROJECTS = `${process.env.HOME}/.claude/projects`;
const URL_RE = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/g;
const MAX_CANDIDATES = 40, SHELL_LINKS_MS = 5000, CONTEXT_CHARS = 200;
// A PR named without its URL: owner/repo#n, PR n, PR #n, or a bare #n of 3+ digits, which resolves against the session's repo.
const PR_REF_RE = /\b([\w.-]+\/[\w.-]+)#(\d+)\b|\bPR\s*#?(\d{2,})\b|(?<![\w/&#])#(\d{3,})\b/gi;
const repos = new Map<string, string>();
const repoFor = (cwd: string) => repos.get(cwd) ?? repos.set(cwd, repoOf(cwd)).get(cwd)!;
// GitHub's owner and repo are case-insensitive; one spelling keeps a PR to one node.
const canonical = (url: string) => url.replace(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//i, (m, r) => m.replace(r, r.toLowerCase()));
function candidatesIn(text: string, role: string, repo: string): Candidate[] {
  const around = (at: number, len: number) => text.slice(Math.max(0, at - CONTEXT_CHARS), at + len + CONTEXT_CHARS).replace(/\s+/g, " ").trim();
  const urls = [...text.matchAll(URL_RE)]
    .map((m) => ({ at: m.index, url: canonical(m[0].replace(/[.,;:!?*_~]+$/, "").replace(/\/$/, "")), len: m[0].length }))
    .filter((c) => URL.canParse(c.url) && /^[\w.-]*\w(:\d+)?$/.test(new URL(c.url).host));
  const prs = [...text.replace(URL_RE, (u) => " ".repeat(u.length)).matchAll(PR_REF_RE)].flatMap((m) => {
    const r = m[1]?.toLowerCase() ?? repo;
    return r ? [{ at: m.index, url: `https://github.com/${r}/pull/${m[2] ?? m[3] ?? m[4]}`, len: m[0].length }] : [];
  });
  return [...urls, ...prs].sort((a, b) => a.at - b.at).map((c) => ({ url: c.url, role, context: around(c.at, c.len) }));
}
// A URL mentioned again moves to the end with its newest context, so the cap drops the stalest ones.
const addCandidates = (list: Candidate[], found: Candidate[]) => {
  for (const c of found) {
    const i = list.findIndex((o) => o.url === c.url);
    if (i >= 0) list.splice(i, 1);
    list.push(c);
  }
  list.splice(0, Math.max(0, list.length - MAX_CANDIDATES));
};
// The repo a session's latest command worked in (gh -R/--repo, cd, git -C), for resolving bare PR numbers when its folder is no checkout.
const REPO_HINT_RE = /(?:--repo[ =]|-R )([\w.-]+\/[\w.-]+)|(?:\bcd |git -C )(~?\/[\w./-]+)/g;
function repoHint(rec: any) {
  const calls = rec.type === "assistant" && Array.isArray(rec.message?.content) ? rec.message.content.filter((b: any) => b?.type === "tool_use") : [];
  const hints = calls.flatMap((b: any) => [...JSON.stringify(b.input ?? {}).matchAll(REPO_HINT_RE)]);
  const m = hints.at(-1);
  return m ? (m[1]?.toLowerCase() ?? repoFor(m[2].replace(/^~/, process.env.HOME!))) : "";
}
function textOf(rec: any) {
  if (rec.isMeta || rec.isSidechain || (rec.type !== "user" && rec.type !== "assistant")) return "";
  const c = rec.message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
}
export function candidates(s: Session): Candidate[] {
  if (isSentry(s)) return [];
  const l = (s.links ??= { found: [], offset: 0, at: 0 });
  // A resumed chat's transcript is known from its id before any hook reports it.
  if (!s.transcript && s.chatId && !l.at) (l.at = Date.now()), (s.transcript = [...new Bun.Glob(`*/${s.chatId}.jsonl`).scanSync(PROJECTS)].map((f) => `${PROJECTS}/${f}`)[0]);
  if (s.transcript) {
    // Only what was appended since the last read: the whole transcript (often tens of MB) was read on every world before.
    let buf: Buffer;
    try {
      const size = statSync(s.transcript).size;
      if (size < l.offset) l.offset = 0;
      buf = Buffer.alloc(size - l.offset);
      const fd = openSync(s.transcript, "r");
      try {
        readSync(fd, buf, 0, buf.length, l.offset);
      } finally {
        closeSync(fd);
      }
    } catch {
      return l.found;
    }
    // Stop at the last full line; a half-written record is read next time.
    const end = buf.lastIndexOf(10) + 1;
    if (end > 0) {
      l.offset += end;
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes("http") && !line.includes("#") && !/\bPR\b/i.test(line) && !line.includes("tool_use")) continue;
        try {
          const rec = JSON.parse(line);
          l.repo = repoHint(rec) || l.repo;
          addCandidates(l.found, candidatesIn(textOf(rec), rec.type, repoFor(s.cwd) || l.repo || ""));
        } catch {}
      }
    }
  } else if (s.exitCode === null && s.lastOutputAt > l.at && Date.now() - l.at > SHELL_LINKS_MS) {
    l.at = Date.now();
    l.found = [];
    for (const line of tmux("capture-pane", "-p", "-J", "-t", tmuxName(s.id), "-S", "-2000").out.split("\n")) addCandidates(l.found, candidatesIn(line, "screen", repoFor(s.cwd)));
  }
  return l.found;
}
