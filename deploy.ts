// `cli.ts deploy`: the one way the live yarn changes. The live checkout holds only commits from origin, so a restart ships
// exactly what is on its branch there, never someone's half-saved edit. Changes are made in a worktree and pushed first.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, LIVE } from "./instance";
import { LOG, checkout, restartCommand } from "./service";

const run = (cmd: string[], cwd?: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trimEnd(), err: r.stderr.toString().trimEnd() };
};
const fail = (why: string): never => (console.error(`deploy: ${why}`), process.exit(1));

type Session = { id: string; name: string; running: boolean };
async function sessions(): Promise<Session[] | undefined> {
  try {
    const res = await fetch(`${BASE}/api/sessions`, { signal: AbortSignal.timeout(5_000) });
    const list = res.ok ? await res.json() : undefined;
    return Array.isArray(list) ? list : undefined;
  } catch {}
}
const sentries = (list: Session[]) => list.filter((s) => s.name.startsWith("sentry:") && s.running).map((s) => s.name);

// The commit about to go live must pass `bun run check` (or, at a commit from before it existed, build with every import
// resolved) in a throwaway worktree, so live never holds a commit that doesn't build.
function check(live: string, commit: string) {
  const dir = mkdtempSync(join(tmpdir(), "yarn-deploy-"));
  if (!run(["git", "-C", live, "worktree", "add", "--detach", dir, commit]).ok) fail(`couldn't check out ${commit} to check it`);
  const install = run(["bun", "install", "--frozen-lockfile"], dir);
  if (!install.ok) run(["git", "-C", live, "worktree", "remove", "--force", dir]), fail(`bun install --frozen-lockfile failed at ${commit.slice(0, 7)}:\n${install.err}`);
  const pkg = JSON.parse(run(["git", "show", `${commit}:package.json`], live).out);
  const ts = (sub: string) => readdirSync(join(dir, sub)).filter((f) => f.endsWith(".ts")).map((f) => `${sub}/${f}`);
  const r = pkg.scripts?.check
    ? run(["bun", "run", "check"], dir)
    : run(["bun", "build", "--target=bun", "--packages=external", "--outdir", join(dir, ".deploy-build"), "server.ts", "cli.ts", ...ts("sentries"), ...ts("hooks")], dir);
  run(["git", "-C", live, "worktree", "remove", "--force", dir]);
  // Bun's bundler doesn't know Tailwind's at-rules and warns on each; they aren't the failure.
  const output = `${r.out}\n${r.err}`.split("\n").filter((l) => l.trim() && !l.includes("invalid @ rule")).join("\n");
  if (!r.ok) fail(`${commit.slice(0, 7)} doesn't build, so live stays where it is:\n${output}`);
}

export async function deploy() {
  if (!LIVE) fail("a dev instance runs from its own checkout; deploy ships the live yarn");
  const live = checkout() ?? fail("no service is installed; run cli.ts install from the live checkout");
  const dirty = run(["git", "status", "--porcelain"], live).out;
  if (dirty) fail(`${live} has uncommitted changes, and a restart would ship them:\n${dirty}\nWhoever owns them commits them from their own worktree and pushes; nobody edits the live checkout.`);
  const branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], live).out;
  if (!run(["git", "fetch", "origin", branch], live).ok) fail(`couldn't fetch origin/${branch}`);
  const from = run(["git", "rev-parse", "HEAD"], live).out;
  const to = run(["git", "rev-parse", "FETCH_HEAD"], live).out;
  if (!run(["git", "merge-base", "--is-ancestor", from, to], live).ok)
    fail(`live has commits origin/${branch} doesn't:\n${run(["git", "log", "--oneline", `${to}..${from}`], live).out}\nPush them to origin/${branch} first.`);
  check(live, to);

  const before = await sessions();
  if (from !== to && !run(["git", "merge", "--ff-only", to], live).ok) fail(`couldn't fast-forward ${live} to ${to.slice(0, 7)}`);
  if (!run(["bun", "install", "--frozen-lockfile"], live).ok) fail(`bun install --frozen-lockfile failed in ${live}, which is now at ${to.slice(0, 7)} but not restarted`);
  console.log(from === to ? `live is at origin/${branch} (${to.slice(0, 7)}); restarting it` : `live ${from.slice(0, 7)} -> ${to.slice(0, 7)}:\n${run(["git", "log", "--oneline", "--no-decorate", `${from}..${to}`], live).out.split("\n").map((l) => `  ${l.slice(0, 120)}`).join("\n")}`);
  if (!run(["sh", "-c", restartCommand]).ok) fail(`${restartCommand} failed`);

  // Adopting every tmux session takes ~20s, and the sentries start after that.
  const deadline = Date.now() + 120_000;
  let after: Session[] | undefined;
  const settled = (list?: Session[]) => !!list && (!before || sentries(before).every((n) => sentries(list).includes(n)));
  while (Date.now() < deadline && !settled((after = await sessions()))) await Bun.sleep(2_000);
  if (!after) fail(`the server isn't answering ${BASE} after 2 minutes; see ${LOG}. The health sentry starts a recovery agent once it has been down 45s.`);
  const lost = before?.filter((s) => !after!.some((a) => a.id === s.id)) ?? [];
  const missing = before ? sentries(before).filter((n) => !sentries(after!).includes(n)) : [];
  console.log(`${after.length} sessions (${before ? `${before.length} before` : "the server was down before"}), ${sentries(after).length} sentries running`);
  if (lost.length || missing.length)
    fail(`after the restart ${[lost.length && `these sessions are gone: ${lost.map((s) => `${s.id} ${s.name}`).join(", ")}`, missing.length && `these sentries aren't running: ${missing.join(", ")}`].filter(Boolean).join("; ")}. See ${LOG}.`);
}
