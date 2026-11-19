#!/usr/bin/env bun
// Part of `bun run check`: useEffect and useLayoutEffect live only in src/lib/effects.ts. Agents get effects wrong (state
// synced by hand, stale closures, listeners never removed), so product code never decides case by case.
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const ALLOWED = "src/lib/effects.ts";
const EFFECT = /\buse(Layout|Insertion)?Effect\b/;
const HELP = `effects live only in ${ALLOWED}. Instead: derive the value in render; do it in the event handler that causes it; read a store with useSyncExternalStore (createStore().use()); reset state with a key or by setting it during render when an input changes; use a ref callback for a DOM node (it may return a cleanup); or use a hook from ${ALLOWED} (useEventListener, useNow, usePresence, useResource), adding a named one there, with a test, if none fits.`;

let failed = 0;
for (const file of new Bun.Glob("src/**/*.{ts,tsx}").scanSync(root)) {
  if (file === ALLOWED) continue;
  const lines = (await Bun.file(join(root, file)).text()).split("\n");
  lines.forEach((line, i) => {
    const hit = line.match(EFFECT);
    if (hit) failed++, console.error(`${file}:${i + 1}: ${hit[0]}: ${HELP}`);
  });
}
console.log(`${failed ? "FAIL" : "ok  "} effects (${failed} outside ${ALLOWED})`);
if (failed) process.exit(1);
