#!/usr/bin/env bun
// rename sentry: titles each session by the topic it owns, rechecked after enough new text lands on its screen.
// A session renamed by hand is left alone from then on.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const STATE_FILE = join(STATE_DIR, "rename-state.json");
const INTERVAL_MS = Number(process.env.RENAME_INTERVAL ?? 20_000);
const FIRST_CHARS = Number(process.env.RENAME_FIRST_CHARS ?? 400);
const EVERY_CHARS = Number(process.env.RENAME_EVERY_CHARS ?? 4000);
const MODEL = process.env.RENAME_MODEL ?? "haiku";
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

const SYSTEM = `You title terminal sessions in a sidebar. Given a session's recent screen, reply with only its title: 3 to 7 words naming the topic the session owns, e.g. "PRO-6201 safety stock dismissals" or "maxflow gh sentry". Name the ticket, PR, bug or feature when the screen shows one. Write a noun phrase, not a verb phrase ("stalled CI on PRs 12194, 12192", not "Kicking stalled CI"). Never describe status, progress or the current step: no "fixing", "waiting on CI", "testing", "done". If the current title still names the right topic, reply with it unchanged. No quotes, no trailing period. If the screen shows no work yet (only a startup banner, an empty prompt, a bare shell), reply SKIP.`;

type Session = { id: string; name: string; cmd: string[]; cwd: string; running: boolean };
type Mark = { lastSet?: string; pinned?: boolean };

const marks: Record<string, Mark> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
// Screen lines as of each session's last rename; new text is measured against these.
const seen = new Map<string, Set<string>>();

const screenLines = async (id: string) =>
  ((await (await fetch(`${base}/api/sessions/${id}/screen?history=300`)).json()).screen as string).split("\n").map((l) => l.trim()).filter(Boolean);

async function title(s: Session, lines: string[]) {
  const screen = lines.join("\n").slice(-8000);
  const input = `Command: ${s.cmd.join(" ")}\nFolder: ${s.cwd}\nCurrent title: ${s.name}\n\nScreen:\n${screen}`;
  const proc = Bun.spawn(
    ["claude", "-p", "--model", MODEL, "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", SYSTEM],
    { cwd: STATE_DIR, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error(`claude exited ${proc.exitCode}: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  return out.split("\n")[0].replace(/^["'`]+|["'`.]+$/g, "").trim().slice(0, 60);
}

async function tick() {
  const sessions = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && !s.name.startsWith("sentry:"));
  for (const id of Object.keys(marks)) if (!sessions.some((s) => s.id === id)) delete marks[id];
  for (const s of sessions) {
    const mark = (marks[s.id] ??= {});
    if (mark.lastSet && s.name !== mark.lastSet) mark.pinned = true;
    if (mark.pinned) continue;
    const lines = await screenLines(s.id);
    // After a sentry restart, count only text that arrives from here on.
    if (!seen.has(s.id) && mark.lastSet) seen.set(s.id, new Set(lines));
    const before = seen.get(s.id) ?? new Set();
    const fresh = lines.filter((l) => !before.has(l)).reduce((n, l) => n + l.length, 0);
    if (fresh < (mark.lastSet ? EVERY_CHARS : FIRST_CHARS)) continue;
    const name = await title(s, lines);
    seen.set(s.id, new Set(lines));
    if (!name || name === "SKIP" || name === s.name) continue;
    await fetch(`${base}/api/sessions/${s.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    mark.lastSet = name;
    console.log(`${new Date().toLocaleTimeString()}  ${s.id}  ${s.name}  ->  ${name}`);
  }
  writeFileSync(STATE_FILE, JSON.stringify(marks));
}

console.log(`rename sentry: first title after ${FIRST_CHARS} new chars, then every ${EVERY_CHARS}, via ${MODEL}`);
for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
