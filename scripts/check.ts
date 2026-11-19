#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const root = join(import.meta.dir, "..");
const out = mkdtempSync(join(tmpdir(), "maxflow-check-"));
const glob = (pattern: string) => [...new Bun.Glob(pattern).scanSync(root)].map((f) => join(root, f));

async function didBundleWithoutErrors(label: string, config: Bun.BuildConfig) {
  const result = await Bun.build({ ...config, outdir: join(out, label), throw: false });
  // constraint: Bun warns on every tailwind at-rule it parses before the plugin replaces them, so only errors print
  for (const log of result.logs) if (log.level === "error") console.error(log);
  console.log(`${result.success ? "ok  " : "FAIL"} ${label} (${config.entrypoints.length} entr${config.entrypoints.length === 1 ? "y" : "ies"})`);
  return result.success;
}

try {
  const serviceEntryPoints = [...glob("*.ts"), ...glob("sentries/*.ts"), ...glob("hooks/*.ts"), ...glob("scripts/*.ts")];
  const bundled = [
    await didBundleWithoutErrors("server", { entrypoints: serviceEntryPoints, target: "bun", packages: "external" }),
    await didBundleWithoutErrors("ui", { entrypoints: [join(root, "src/index.html")], target: "browser", plugins: [tailwind] }),
  ];
  if (bundled.includes(false)) process.exit(1);
} finally {
  rmSync(out, { recursive: true, force: true });
}
