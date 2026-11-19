#!/usr/bin/env bun
// `bun run check`: bundles every entry point the service runs and the UI, so a syntax error, a missing file or a missing
// export fails here instead of in live. CI runs it on every push; the tests run after it, from package.json.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const root = join(import.meta.dir, "..");
const out = mkdtempSync(join(tmpdir(), "maxflow-check-"));
const glob = (pattern: string) => [...new Bun.Glob(pattern).scanSync(root)].map((f) => join(root, f));

async function bundle(label: string, config: Bun.BuildConfig) {
  const result = await Bun.build({ ...config, outdir: join(out, label), throw: false });
  // Warnings are left out: Bun warns on every tailwind at-rule it parses before the plugin replaces them.
  for (const log of result.logs) if (log.level === "error") console.error(log);
  console.log(`${result.success ? "ok  " : "FAIL"} ${label} (${config.entrypoints.length} entr${config.entrypoints.length === 1 ? "y" : "ies"})`);
  return result.success;
}

try {
  const results = [
    await bundle("server", { entrypoints: [...glob("*.ts"), ...glob("sentries/*.ts"), ...glob("hooks/*.ts"), ...glob("scripts/*.ts")], target: "bun", packages: "external" }),
    await bundle("ui", { entrypoints: [join(root, "src/index.html")], target: "browser", plugins: [tailwind] }),
  ];
  if (results.includes(false)) process.exit(1);
} finally {
  rmSync(out, { recursive: true, force: true });
}
