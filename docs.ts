import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { IS_LIVE } from "./instance";
import { stateDirectory } from "./state";

const CHOSEN_DIR = process.env["MAXFLOW_DOCS"];
const IS_HIS_VAULT = IS_LIVE && CHOSEN_DIR === undefined;
export const DOCS_DIR = CHOSEN_DIR ?? (IS_LIVE ? join(homedir(), "Docs") : stateDirectory("docs"));
const OBSIDIAN_REGISTRY = join(homedir(), "Library/Application Support/obsidian/obsidian.json");
const ISAAC = "isaac";
const AGENT_EMAIL = "docs@maxflow.local";

export type Entry = { who: string; text: string };
export type CommentThread = { line: number; entries: Entry[]; isOpen: boolean };
export type DocSummary = { path: string; owner?: string; open: number };
export type Vault = { docs: DocSummary[]; canvases: string[]; folders: string[]; files: string[] };
export const ATTACHMENTS = "attachments";

function git(args: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync(["git", ...args], { cwd: DOCS_DIR, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args[0] ?? ""}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function registerWithObsidian() {
  type ObsidianRegistry = { vaults?: Record<string, { path: string; ts?: number }> };
  if (!IS_HIS_VAULT || !existsSync(dirname(OBSIDIAN_REGISTRY))) return;
  const registry = (existsSync(OBSIDIAN_REGISTRY) ? JSON.parse(readFileSync(OBSIDIAN_REGISTRY, "utf8")) : {}) as ObsidianRegistry;
  const vaults = registry.vaults ?? {};
  if (Object.values(vaults).some((v) => v.path === DOCS_DIR)) return;
  vaults[crypto.randomUUID().replaceAll("-", "").slice(0, 16)] = { path: DOCS_DIR, ts: Date.now() };
  writeFileSync(OBSIDIAN_REGISTRY, JSON.stringify({ ...registry, vaults }));
}

function writeIfMissing(path: string, text: string) {
  if (!existsSync(join(DOCS_DIR, path))) writeFileSync(join(DOCS_DIR, path), text);
}

function keepAttachmentsTogether() {
  const settings = JSON.parse(readFileSync(join(DOCS_DIR, ".obsidian/app.json"), "utf8")) as Record<string, unknown>;
  if (settings["attachmentFolderPath"] !== undefined) return;
  writeFileSync(join(DOCS_DIR, ".obsidian/app.json"), `${JSON.stringify({ ...settings, attachmentFolderPath: ATTACHMENTS }, null, 2)}\n`);
}

export function ensureVault() {
  mkdirSync(join(DOCS_DIR, ".obsidian"), { recursive: true });
  writeIfMissing(".obsidian/app.json", "{}\n");
  keepAttachmentsTogether();
  writeIfMissing(".gitignore", ".obsidian/workspace*.json\n.trash/\n.DS_Store\n");
  if (!existsSync(join(DOCS_DIR, ".git"))) {
    git(["init", "-q"]);
    didCommit(["."], "vault created");
  }
  registerWithObsidian();
}

export const uncommitted = () =>
  git(["status", "--porcelain", "-z", "-uall"])
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));

const isKnownToGit = (path: string) => existsSync(join(DOCS_DIR, path)) || git(["ls-files", "--", path]).trim() !== "";

export function didCommit(paths: string[], message: string, author = ISAAC) {
  const known = paths.filter((path) => isKnownToGit(path));
  if (known.length === 0) return false;
  git(["add", "-A", "--", ...known]);
  if (git(["diff", "--cached", "--name-only"]).trim() === "") return false;
  git(["commit", "-q", "-m", message], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: AGENT_EMAIL, GIT_COMMITTER_NAME: "maxflow", GIT_COMMITTER_EMAIL: AGENT_EMAIL });
  return true;
}

export function vaultPath(path: string) {
  const inVault = relative(DOCS_DIR, resolve(DOCS_DIR, path));
  if (inVault === "" || inVault.startsWith("..") || /^\.(git|obsidian)(\/|$)/.test(inVault)) throw new Error(`${path} is not in ${DOCS_DIR}`);
  return inVault;
}

export const docPath = (path: string) => vaultPath(/\.\w+$/.test(path) ? path : `${path}.md`);

export const versionOf = (text: string) => Bun.hash(text).toString(36);

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

const FENCE = /^\s*(```|~~~)/;

function outsideCode(text: string) {
  let isInCode = false;
  return text.split("\n").map((line) => {
    if (FENCE.test(line)) isInCode = !isInCode;
    return isInCode || FENCE.test(line) ? "" : line;
  });
}

export function commentsIn(text: string): CommentThread[] {
  const threads: CommentThread[] = [];
  let current: CommentThread | undefined;
  for (const [i, line] of outsideCode(text).entries()) {
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

function walk(dir: string, into: { folders: string[]; files: string[] }) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      into.folders.push(relative(DOCS_DIR, path));
      walk(path, into);
    } else into.files.push(relative(DOCS_DIR, path));
  }
  return into;
}

const byPath = (a: string, b: string) => a.localeCompare(b);

function summary(path: string): DocSummary {
  const text = readFileSync(join(DOCS_DIR, path), "utf8");
  const owner = ownerOf(text);
  return { path, ...(owner !== undefined && { owner }), open: commentsIn(text).filter((t) => t.isOpen).length };
}

export function listVault(): Vault {
  if (!existsSync(DOCS_DIR)) return { docs: [], canvases: [], folders: [], files: [] };
  const { folders, files } = walk(DOCS_DIR, { folders: [], files: [] });
  const docs = files.filter((f) => f.endsWith(".md")).toSorted(byPath);
  return { docs: docs.map((path) => summary(path)), canvases: files.filter((f) => f.endsWith(".canvas")).toSorted(byPath), folders: folders.toSorted(byPath), files: files.filter((f) => !f.endsWith(".md")).toSorted(byPath) };
}

export const listDocs = () => listVault().docs;

export const readDoc = (path: string) => readFileSync(join(DOCS_DIR, docPath(path)), "utf8");

export function saveFile(path: string, content: string | Uint8Array) {
  const inVault = vaultPath(path);
  mkdirSync(dirname(join(DOCS_DIR, inVault)), { recursive: true });
  writeFileSync(join(DOCS_DIR, inVault), content);
  return inVault;
}

export const makeFolder = (path: string) => mkdirSync(join(DOCS_DIR, vaultPath(path)), { recursive: true });

export function writeDoc(path: string, text: string, who: string) {
  const inVault = saveFile(docPath(path), text);
  didCommit([inVault], `${who}: write ${inVault}`, who);
  return inVault;
}

export const moveDoc = (from: string, to: string, who: string) => moveEntry(docPath(from), docPath(to), who);
export const moveFolder = (from: string, to: string, who: string) => moveEntry(vaultPath(from), vaultPath(to), who);

function moveEntry(source: string, target: string, who: string) {
  if (existsSync(join(DOCS_DIR, target))) throw new Error(`${target} already exists`);
  mkdirSync(dirname(join(DOCS_DIR, target)), { recursive: true });
  renameSync(join(DOCS_DIR, source), join(DOCS_DIR, target));
  didCommit([source, target], `${who}: move ${source} to ${target}`, who);
  return target;
}

export const removeDoc = (path: string, who: string) => removeEntry(docPath(path), who);
export const removeFolder = (path: string, who: string) => removeEntry(vaultPath(path), who);

function removeEntry(inVault: string, who: string) {
  rmSync(join(DOCS_DIR, inVault), { recursive: true });
  didCommit([inVault], `${who}: remove ${inVault}`, who);
  return inVault;
}
