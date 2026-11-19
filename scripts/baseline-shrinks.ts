#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const git = (...args: string[]) => {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : undefined;
};

type Counts = Record<string, number>;

const head = git("rev-parse", "HEAD");
const mergeBase = git("merge-base", "HEAD", "origin/feat/v2");
const pushedOnto = process.env["BASELINE_BASE"];
const isKnownCommit = (sha: string | undefined) => sha !== undefined && /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha) && git("cat-file", "-e", sha) !== undefined;
const fallbackBase = mergeBase === undefined || mergeBase === head ? git("rev-parse", "HEAD~1") : mergeBase;
const base = isKnownCommit(pushedOnto) ? pushedOnto : fallbackBase;

const FUNCTION_SIZE_RULES = new Set(["complexity", "max-statements", "max-lines-per-function", "max-lines", "max-depth", "max-params", "max-nested-callbacks"]);
const existedAtBase = (path: string) => base !== undefined && git("cat-file", "-e", `${base}:${path}`) !== undefined;

function totals(file: string, text: string | undefined): Counts {
  if (text === undefined) return {};
  if (file === "tsc-baseline.json") return { "type errors": Object.values(JSON.parse(text) as Counts).reduce((sum, n) => sum + n, 0) };
  type Suppressions = Record<string, Record<string, { count: number }>>;
  const suppressions = JSON.parse(text) as Suppressions;
  const counts: Counts = {};
  for (const [path, rules] of Object.entries(suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      if (!FUNCTION_SIZE_RULES.has(rule) || existedAtBase(path)) counts[rule] = (counts[rule] ?? 0) + count;
    }
  }
  return counts;
}

function grownIn(file: string) {
  const before = totals(file, base === undefined ? undefined : git("show", `${base}:${file}`));
  if (Object.keys(before).length === 0) return [];
  const after = totals(file, readFileSync(join(root, file), "utf8"));
  return Object.entries(after)
    .filter(([key, count]) => count > (before[key] ?? 0))
    .map(([key, count]) => `${file}: ${key} ${String(before[key] ?? 0)} -> ${String(count)}`);
}

const grown = ["eslint-suppressions.json", "tsc-baseline.json"].flatMap((file) => grownIn(file));
if (grown.length > 0) {
  console.error(`The lint baselines only shrink, and these grew since ${base?.slice(0, 7) ?? "the base"}:\n${grown.map((g) => `  ${g}`).join("\n")}\nTotals are per rule across files, so code moved between files may carry its counts along, and a function split out of a too-big one into a new file may count on its own; a net rise is new violations. Fix them instead of suppressing them.`);
  process.exit(1);
}
console.log(`ok   baselines didn't grow since ${base?.slice(0, 7) ?? "(no base)"}`);
