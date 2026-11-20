#!/usr/bin/env bun
import { watch } from "node:fs";
import { didCommit, ensureTimelines, git, TIMELINES_DIR, TIMELINES_REMOTE, uncommitted } from "../timelines";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("timelines");

// constraint: an agent rewriting now.txt saves it in a few writes, so commit once the folder has been quiet a moment
const QUIET_MS = Number(process.env["TIMELINES_QUIET_MS"] ?? 3000);
const PULL_EVERY_MS = 5 * 60_000;
const NETWORK_TIMEOUT_MS = 60_000;
const folder = { changedAt: 0, sweptAt: 0, pulledAt: 0 };
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

function network(args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd: TIMELINES_DIR, stdout: "pipe", stderr: "pipe", timeout: NETWORK_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (run.exitCode !== 0) throw new Error(`git ${args[0] ?? ""}: ${run.stderr.toString().trim() || "timed out"}`);
}

function commitAdHocEdits() {
  const changed = uncommitted();
  const more = changed.length > 5 ? ` and ${String(changed.length - 5)} more` : "";
  if (changed.length > 0) didCommit(`edited ${changed.slice(0, 5).join(", ")}${more}`);
}

const count = (range: string) => Number(git(["rev-list", "--count", range]).trim());
const hasUpstream = () => git(["branch", "-r"]).includes("origin/main");

// constraint: cleopatra writes the same repo, so both sides can touch one now.txt; on a clash this side's copy wins and the other stays in history
function pullOtherDevices() {
  network(["fetch", "-q", "origin"]);
  if (!hasUpstream() || count("HEAD..origin/main") === 0) return;
  try {
    git(["rebase", "-q", "origin/main"]);
  } catch {
    git(["rebase", "--abort"]);
    git(["merge", "-q", "--no-edit", "-X", "ours", "origin/main"]);
  }
  log("pulled other devices' events");
}

function pushIfAhead() {
  if (hasUpstream() && count("origin/main..HEAD") === 0) return;
  network(["push", "-q", "-u", "origin", "main"]);
  log("pushed");
}

function sweep() {
  commitAdHocEdits();
  if (TIMELINES_REMOTE === "") return;
  if (Date.now() - folder.pulledAt >= PULL_EVERY_MS) {
    folder.pulledAt = Date.now();
    pullOtherDevices();
  }
  pushIfAhead();
}

const isDue = () => (folder.changedAt > folder.sweptAt && Date.now() - folder.changedAt >= QUIET_MS) || Date.now() - folder.sweptAt >= PULL_EVERY_MS;

ensureTimelines();
log(`watching ${TIMELINES_DIR}${TIMELINES_REMOTE === "" ? "" : `, synced with ${TIMELINES_REMOTE}`}`);
watch(TIMELINES_DIR, { recursive: true }, (_, file) => {
  if (file !== null && !/^\.git(\/|$)/.test(file)) folder.changedAt = Date.now();
});
for (;;) {
  if (isDue()) {
    folder.sweptAt = Date.now();
    try {
      sweep();
    } catch (error) {
      log(`sweep failed: ${String(error)}`);
    }
  }
  await Bun.sleep(1000);
}
