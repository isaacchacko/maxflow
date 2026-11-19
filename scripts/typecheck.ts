#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const BASELINE = join(root, "tsc-baseline.json");
const PROJECTS = [".", "lint"];
const isShrinking = process.argv.includes("--shrink");

type Counts = Record<string, number>;

function typeErrors() {
  const byFile = new Map<string, string[]>();
  for (const project of PROJECTS) {
    const run = Bun.spawnSync(["bun", join(root, "node_modules/.bin/tsc"), "-p", project, "--pretty", "false"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    for (const line of run.stdout.toString().split("\n")) {
      const file = /^(\S[^(]*)\(\d+,\d+\): error /.exec(line)?.[1];
      if (file !== undefined) byFile.set(file, [...(byFile.get(file) ?? []), line]);
    }
  }
  return byFile;
}

const errors = typeErrors();
const hasBaseline = existsSync(BASELINE);
const baseline: Counts = hasBaseline ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Counts) : {};
const grew = [...errors].filter(([file, lines]) => hasBaseline && lines.length > (baseline[file] ?? 0));
const shrank = Object.entries(baseline).filter(([file, allowed]) => (errors.get(file)?.length ?? 0) < allowed);

for (const [file, lines] of grew) {
  console.error(`${file}: ${String(lines.length)} type errors, tsc-baseline.json allows ${String(baseline[file] ?? 0)}. Fix the new ones; the baseline only shrinks.`);
  for (const line of lines) console.error(`  ${line}`);
}
if (grew.length > 0) process.exit(1);

if (!isShrinking && shrank.length > 0) {
  console.error(`Fewer type errors than tsc-baseline.json allows in ${shrank.map(([file]) => file).join(", ")}. Lock that in: bun scripts/typecheck.ts --shrink`);
  process.exit(1);
}
if (isShrinking) {
  const files = [...errors.keys()].toSorted();
  const next: Counts = Object.fromEntries(files.map((file) => [file, errors.get(file)?.length ?? 0]));
  writeFileSync(BASELINE, `${JSON.stringify(next, undefined, 2)}\n`);
}
let total = 0;
for (const lines of errors.values()) total += lines.length;
console.log(`ok   tsc (${String(total)} baselined type errors in ${String(errors.size)} files; the goal is 0)`);
