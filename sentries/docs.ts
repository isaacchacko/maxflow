#!/usr/bin/env bun
import { yarnEnv } from "../shared/legacy-maxflow";
import { watch } from "node:fs";
import { join } from "node:path";
import { CLI, BASE as base } from "../instance";
import { commentsIn, type CommentThread, didCommit, DOCS_DIR, type DocSummary, ensureVault, listDocs, readDoc, uncommitted } from "../docs";
import { readStateJson, writeStateJson } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("docs");

// constraint: Obsidian saves every couple of seconds while he types, so a half-written comment must not wake anyone.
const QUIET_MS = Number(process.env["DOCS_QUIET_MS"] ?? 15_000);
const RETRY_MS = 600_000;
const STATE_FILE = "docs-sentry.json";
const headers = { "content-type": "application/json", "x-yarn-from": yarnEnv("SESSION") ?? "" };

type Told = Record<string, number>;
const isTold = (value: unknown): value is Told => typeof value === "object" && value !== null && Object.values(value).every((at) => typeof at === "number");
const told: Told = readStateJson(STATE_FILE, isTold) ?? {};
const vault = { changedAt: 0, sweptAt: 0 };
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const wordingKey = (path: string, t: CommentThread) => `${path}#${Bun.hash(JSON.stringify(t.entries)).toString(36)}`;

async function sessionsNow() {
  type SessionRow = { id: string; name: string; running: boolean };
  const res = await fetch(`${base}/api/sessions`, { headers, signal: AbortSignal.timeout(30_000) });
  return (await res.json()) as SessionRow[];
}

async function didNotify(id: string, text: string) {
  const res = await fetch(`${base}/api/sessions/${id}/notify`, { method: "POST", headers, body: JSON.stringify({ text }), signal: AbortSignal.timeout(30_000) });
  return res.ok;
}

function asked(path: string, t: CommentThread) {
  const said = t.entries.map((e) => `${e.who}: ${e.text}`).join("\n  ");
  return `[yarn docs] Isaac commented in ${join(DOCS_DIR, path)} (line ${String(t.line)}):\n  ${said}\nDo what his last word asks: edit the doc directly, then answer under his comment with a nested callout of your own, signed with your session name, e.g.\n> > [!reply] <your name>\n> > <what you changed, or your answer>\nLeave his comment in place; he deletes the thread once it's settled. Your edits are committed for you (\`${CLI} docs write\` commits at once).`;
}

async function didWake(doc: DocSummary, t: CommentThread) {
  const sessions = await sessionsNow();
  const owner = sessions.find((s) => s.id === doc.owner && s.running);
  if (owner && (await didNotify(owner.id, asked(doc.path, t)))) {
    log(`woke owner ${owner.id} for ${doc.path}:${String(t.line)}`);
    return true;
  }
  const funnel = sessions.find((s) => s.name === "sentry:funnel" && s.running);
  if (!funnel) {
    log(`no owner and no funnel for ${doc.path}:${String(t.line)}; will retry`);
    return false;
  }
  const why = doc.owner === undefined ? "The doc has no owner." : `Its owner ${doc.owner} is gone.`;
  log(`sending ${doc.path}:${String(t.line)} to the funnel (${why})`);
  return didNotify(funnel.id, `${asked(doc.path, t)}\n${why} Route this to the agent that should own the doc, and have it put \`owner: <its session id>\` in the doc's frontmatter.`);
}

function commitHisEdits() {
  const changed = uncommitted();
  const more = changed.length > 5 ? ` and ${String(changed.length - 5)} more` : "";
  if (changed.length > 0) didCommit(["."], `vault: ${changed.slice(0, 5).join(", ")}${more}`);
}

const unanswered = (doc: DocSummary) => commentsIn(readDoc(doc.path)).filter((t) => t.isOpen && told[wordingKey(doc.path, t)] === undefined);

async function sweep() {
  commitHisEdits();
  const waiting = listDocs().flatMap((doc) => unanswered(doc).map((t) => ({ doc, t })));
  for (const { doc, t } of waiting) if (await didWake(doc, t)) told[wordingKey(doc.path, t)] = Date.now();
  writeStateJson(STATE_FILE, told);
}

const isDue = () => (vault.changedAt > vault.sweptAt && Date.now() - vault.changedAt >= QUIET_MS) || Date.now() - vault.sweptAt >= RETRY_MS;

ensureVault();
log(`watching ${DOCS_DIR}`);
watch(DOCS_DIR, { recursive: true }, (_, file) => {
  if (file !== null && !/^\.(git|obsidian)(\/|$)/.test(file)) vault.changedAt = Date.now();
});
for (;;) {
  if (isDue()) {
    vault.sweptAt = Date.now();
    try {
      await sweep();
    } catch (error) {
      log(`sweep failed: ${String(error)}`);
    }
  }
  await Bun.sleep(1000);
}
