import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./instance";

// What Claude Code spent, from its transcripts (~/.claude/projects/<project>/<chat>.jsonl, and <chat>/subagents/*.jsonl under it):
// every assistant message carries its model and token usage. `bun usage.ts` reads only what each file gained since the last
// read and keeps per-day sums in stats-usage.json; the server runs it in the background, since a first read takes minutes
// over gigabytes of transcripts, and only ever reads the sums. A chat started in a yarn session names it in its SessionStart
// hook text, which is how a transcript is tied to an agent, its objective and its role even after the session is gone.

export const USAGE = `${STATE_DIR}/stats-usage.json`;
const PROJECTS = `${process.env.HOME}/.claude/projects`;
// Older transcripts are left out of the first read; the page looks back 90 days at most.
const LOOKBACK_MS = 120 * 86_400_000;
// A gap between two of an agent's messages longer than this was idle time, not work.
export const ACTIVE_GAP_MS = 5 * 60_000;

/** Per day and model: input, output, cache writes (5m, 1h), cache reads, messages. */
export type Tokens = [number, number, number, number, number, number];
export type FileUsage = {
  size: number;
  mtime: number;
  offset: number;
  // The yarn session the chat ran in, and where it sat in the routing, from its SessionStart hook.
  yarn?: string;
  name?: string;
  objective?: string;
  role?: string;
  parent?: string;
  cwd?: string;
  first?: number;
  last?: number;
  lastTs?: number;
  // The last few message ids seen, since Claude Code writes one line per content block, each with the message's usage.
  ids: string[];
  days: Record<string, { models: Record<string, Tokens>; activeMs: number }>;
};
export type Usage = { at: number; files: Record<string, FileUsage> };

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format;

// $ per million tokens: input, output, cache read. A 5-minute cache write costs 1.25× input and a 1-hour one 2×. First match wins.
const PRICES: [RegExp, number, number, number][] = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-(5|4-[5-9])/, 5, 25, 0.5],
  [/opus/, 15, 75, 1.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku/, 1, 5, 0.1],
];
const priceOf = (model: string) => PRICES.find(([re]) => re.test(model)) ?? PRICES[3]!;
/** What the tokens would cost at API rates, and what reading from the cache saved against paying full input for it. */
export function cost(model: string, t: Tokens) {
  const [, input, output, read] = priceOf(model);
  const dollars = (t[0] * input + t[1] * output + t[2] * input * 1.25 + t[3] * input * 2 + t[4] * read) / 1e6;
  return { dollars, saved: (t[4] * (input - read)) / 1e6 };
}

export function loadUsage(): Usage {
  try {
    return existsSync(USAGE) ? JSON.parse(readFileSync(USAGE, "utf8")) : { at: 0, files: {} };
  } catch {
    return { at: 0, files: {} };
  }
}

function transcripts() {
  const out: string[] = [];
  const since = Date.now() - LOOKBACK_MS;
  for (const project of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = join(dir, e);
      if (e.endsWith(".jsonl")) out.push(path);
      else if (existsSync(join(path, "subagents"))) for (const s of readdirSync(join(path, "subagents"))) if (s.endsWith(".jsonl")) out.push(join(path, "subagents", s));
    }
  }
  return out.filter(p => {
    try {
      return statSync(p).mtimeMs >= since;
    } catch {
      return false;
    }
  });
}

// The hook text is JSON-escaped inside the transcript line, so its quotes arrive as \".
const HOOK = /yours is \\"((?:[^\\]|\\.)*?)\\", id ([0-9a-f]{8}), in \$MAXFLOW_SESSION/;
const ROUTING = /you are a (router|worker) on the objective \\"(?:[^\\]|\\.)*?\\" \(([a-z0-9-]+)\)/;

function read(path: string, f: FileUsage, size: number) {
  const buf = Buffer.alloc(size - f.offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, f.offset);
  } finally {
    closeSync(fd);
  }
  // Only whole lines; a line still being written is read next time.
  const end = buf.lastIndexOf(10);
  if (end < 0) return;
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    if (!f.yarn && line.includes("$MAXFLOW_SESSION")) {
      const hook = line.match(HOOK);
      if (hook) {
        f.name = hook[1]!.replace(/\\(.)/g, "$1");
        f.yarn = hook[2];
        const routing = line.match(ROUTING);
        if (routing) (f.role = routing[1]), (f.objective = routing[2]);
      }
    }
    if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) continue;
    let d: { timestamp?: string; cwd?: string; message?: { id?: string; model?: string; usage?: Record<string, number> & { cache_creation?: Record<string, number> } } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.message, u = m?.usage;
    if (!m?.model || !u || m.model === "<synthetic>" || !d.timestamp) continue;
    if (m.id && f.ids.includes(m.id)) continue;
    if (m.id) f.ids = [...f.ids.slice(-30), m.id];
    const ts = Date.parse(d.timestamp);
    const day = (f.days[dayKey(ts)] ??= { models: {}, activeMs: 0 });
    const t = (day.models[m.model] ??= [0, 0, 0, 0, 0, 0]);
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    t[0] += u.input_tokens ?? 0;
    t[1] += u.output_tokens ?? 0;
    t[2] += (u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - write1h) || 0;
    t[3] += write1h;
    t[4] += u.cache_read_input_tokens ?? 0;
    t[5]++;
    if (f.lastTs && ts > f.lastTs && ts - f.lastTs <= ACTIVE_GAP_MS) day.activeMs += ts - f.lastTs;
    f.lastTs = Math.max(f.lastTs ?? 0, ts);
    f.first = Math.min(f.first ?? ts, ts);
    f.last = Math.max(f.last ?? ts, ts);
    f.cwd ??= d.cwd;
  }
  f.offset += end + 1;
}

/** Reads what every transcript gained since the last scan and saves the sums. */
export function scan() {
  const usage = loadUsage();
  const seen = new Set<string>();
  for (const path of transcripts()) {
    seen.add(path);
    const st = statSync(path);
    let f = usage.files[path];
    // A file that shrank was rewritten; read it again from the top.
    if (!f || st.size < f.offset) f = usage.files[path] = { size: 0, mtime: 0, offset: 0, ids: [], days: {} };
    if (f.size === st.size && f.mtime === st.mtimeMs) continue;
    try {
      read(path, f, st.size);
    } catch (e) {
      console.error(`usage: ${path}: ${(e as Error).message}`);
    }
    f.size = st.size;
    f.mtime = st.mtimeMs;
    const sub = path.match(/^(.*)\/([^/]+)\/subagents\/[^/]+\.jsonl$/);
    if (sub) f.parent = `${sub[1]}/${sub[2]}.jsonl`;
  }
  for (const path of Object.keys(usage.files)) if (!seen.has(path)) delete usage.files[path];
  usage.at = Date.now();
  writeFileSync(`${USAGE}.tmp`, JSON.stringify(usage));
  renameSync(`${USAGE}.tmp`, USAGE);
}

if (import.meta.main) {
  const started = Date.now();
  scan();
  console.log(`usage: scanned in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
