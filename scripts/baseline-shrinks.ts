#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const git = (...args: string[]) => {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : undefined;
};

type Counts = Record<string, number>;
type Suppressions = Record<string, Record<string, { count: number }>>;

const head = git("rev-parse", "HEAD");
const mergeBase = git("merge-base", "HEAD", "origin/feat/v2");
const base = mergeBase === undefined || mergeBase === head ? git("rev-parse", "HEAD~1") : mergeBase;

function flatten(file: string, text: string | undefined): Counts {
  if (text === undefined) return {};
  if (file === "tsc-baseline.json") return JSON.parse(text) as Counts;
  const counts: Counts = {};
  for (const [path, rules] of Object.entries(JSON.parse(text) as Suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) counts[`${path} ${rule}`] = count;
  }
  return counts;
}

function grownIn(file: string) {
  const before = flatten(file, base === undefined ? undefined : git("show", `${base}:${file}`));
  if (Object.keys(before).length === 0) return [];
  const after = flatten(file, readFileSync(join(root, file), "utf8"));
  return Object.entries(after)
    .filter(([key, count]) => count > (before[key] ?? 0))
    .map(([key, count]) => `${file}: ${key} ${String(before[key] ?? 0)} -> ${String(count)}`);
}

const grown = ["eslint-suppressions.json", "tsc-baseline.json"].flatMap((file) => grownIn(file));
if (grown.length > 0) {
  console.error(`The lint baselines only shrink, and these grew since ${base?.slice(0, 7) ?? "the base"}:\n${grown.map((g) => `  ${g}`).join("\n")}\nFix the new violations instead of suppressing them.`);
  process.exit(1);
}
console.log(`ok   baselines didn't grow since ${base?.slice(0, 7) ?? "(no base)"}`);
