import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { LIVE } from "./instance";
import { stateDirectory } from "./state";

export const DOCS_DIR = process.env["MAXFLOW_DOCS"] ?? (LIVE ? join(homedir(), "Docs") : stateDirectory("docs"));
const OBSIDIAN_REGISTRY = join(homedir(), "Library/Application Support/obsidian/obsidian.json");
const ISAAC = "isaac";
const AGENT_EMAIL = "docs@maxflow.local";

export type Entry = { who: string; text: string };
export type CommentThread = { line: number; entries: Entry[]; isOpen: boolean };
export type DocSummary = { path: string; owner?: string; open: number };

export const obsidianUrl = (path: string) => `obsidian://open?path=${encodeURIComponent(join(DOCS_DIR, path))}`;

function git(args: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync(["git", ...args], { cwd: DOCS_DIR, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args[0] ?? ""}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function registerWithObsidian() {
  type ObsidianRegistry = { vaults?: Record<string, { path: string; ts?: number }> };
  if (!LIVE || !existsSync(dirname(OBSIDIAN_REGISTRY))) return;
  const registry = (existsSync(OBSIDIAN_REGISTRY) ? JSON.parse(readFileSync(OBSIDIAN_REGISTRY, "utf8")) : {}) as ObsidianRegistry;
  const vaults = registry.vaults ?? {};
  if (Object.values(vaults).some((v) => v.path === DOCS_DIR)) return;
  vaults[crypto.randomUUID().replaceAll("-", "").slice(0, 16)] = { path: DOCS_DIR, ts: Date.now() };
  writeFileSync(OBSIDIAN_REGISTRY, JSON.stringify({ ...registry, vaults }));
}

function writeIfMissing(path: string, text: string) {
  if (!existsSync(join(DOCS_DIR, path))) writeFileSync(join(DOCS_DIR, path), text);
}

export function ensureVault() {
  mkdirSync(join(DOCS_DIR, ".obsidian"), { recursive: true });
  writeIfMissing(".obsidian/app.json", "{}\n");
  writeIfMissing(".gitignore", ".obsidian/workspace*.json\n.trash/\n.DS_Store\n");
  if (!existsSync(join(DOCS_DIR, ".git"))) {
    git(["init", "-q"]);
    didCommit(["."], "vault created");
  }
  registerWithObsidian();
}

export const uncommitted = () =>
  git(["status", "--porcelain", "-uall"])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));

export function didCommit(paths: string[], message: string, author = ISAAC) {
  git(["add", "-A", "--", ...paths]);
  if (git(["diff", "--cached", "--name-only"]).trim() === "") return false;
  git(["commit", "-q", "-m", message], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: AGENT_EMAIL, GIT_COMMITTER_NAME: "maxflow", GIT_COMMITTER_EMAIL: AGENT_EMAIL });
  return true;
}

export function docPath(path: string) {
  const withExtension = /\.\w+$/.test(path) ? path : `${path}.md`;
  const inVault = relative(DOCS_DIR, resolve(DOCS_DIR, withExtension));
  if (inVault === "" || inVault.startsWith("..") || /^\.(git|obsidian)(\/|$)/.test(inVault)) throw new Error(`${path} is not a doc in ${DOCS_DIR}`);
  return inVault;
}

export const ownerOf = (text: string) => /^---\n[\s\S]*?^owner:\s*(\S+)[\s\S]*?^---$/m.exec(text)?.[1];

export function withOwner(text: string, owner: string) {
  if (ownerOf(text) !== undefined) return text;
  return text.startsWith("---\n") ? `---\nowner: ${owner}\n${text.slice(4)}` : `---\nowner: ${owner}\n---\n${text}`;
}

const CALLOUT = /^\[!(comment|reply)\][+-]?\s*(.*)$/i;
const quoted = (line: string) => /^>\s?(.*)$/.exec(line)?.[1];
const signed = (name: string | undefined) => (name === undefined || name.trim() === "" ? ISAAC : name.trim());

function addLine(thread: CommentThread, inner: string) {
  const nested = quoted(inner);
  const reply = nested === undefined ? null : CALLOUT.exec(nested);
  if (reply) {
    thread.entries.push({ who: signed(reply[2]), text: "" });
    return;
  }
  const last = thread.entries.at(-1);
  if (last) last.text = `${last.text}\n${nested ?? inner}`.trim();
}

export function commentsIn(text: string): CommentThread[] {
  const threads: CommentThread[] = [];
  let current: CommentThread | undefined;
  for (const [i, line] of text.split("\n").entries()) {
    const inner = quoted(line);
    const start = inner === undefined ? null : CALLOUT.exec(inner);
    if (start?.[1]?.toLowerCase() === "comment") {
      current = { line: i + 1, entries: [{ who: signed(start[2]), text: "" }], isOpen: false };
      threads.push(current);
    } else if (current && inner !== undefined) addLine(current, inner);
    else current = undefined;
  }
  return threads.map((t) => ({ ...t, isOpen: t.entries.at(-1)?.who.toLowerCase() === ISAAC }));
}

function walk(dir: string): string[] {
  const found: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) found.push(...walk(path));
    else if (e.name.endsWith(".md")) found.push(relative(DOCS_DIR, path));
  }
  return found;
}

function summary(path: string): DocSummary {
  const text = readFileSync(join(DOCS_DIR, path), "utf8");
  const owner = ownerOf(text);
  return { path, ...(owner !== undefined && { owner }), open: commentsIn(text).filter((t) => t.isOpen).length };
}

export const listDocs = (): DocSummary[] => (existsSync(DOCS_DIR) ? walk(DOCS_DIR).toSorted((a, b) => a.localeCompare(b)).map((path) => summary(path)) : []);

export const readDoc = (path: string) => readFileSync(join(DOCS_DIR, docPath(path)), "utf8");

export function writeDoc(path: string, text: string, who: string) {
  const inVault = docPath(path);
  mkdirSync(dirname(join(DOCS_DIR, inVault)), { recursive: true });
  writeFileSync(join(DOCS_DIR, inVault), text);
  didCommit([inVault], `${who}: write ${inVault}`, who);
  return inVault;
}

export function moveDoc(from: string, to: string, who: string) {
  const [source, target] = [docPath(from), docPath(to)];
  if (existsSync(join(DOCS_DIR, target))) throw new Error(`${target} already exists`);
  mkdirSync(dirname(join(DOCS_DIR, target)), { recursive: true });
  renameSync(join(DOCS_DIR, source), join(DOCS_DIR, target));
  didCommit([source, target], `${who}: move ${source} to ${target}`, who);
  return target;
}

export function removeDoc(path: string, who: string) {
  const inVault = docPath(path);
  rmSync(join(DOCS_DIR, inVault));
  didCommit([inVault], `${who}: remove ${inVault}`, who);
  return inVault;
}
