import { noSessionEnv } from "../shared/legacy-maxflow";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "isaacchacko/yarn";
const SHA = "b7e72a28722cbcf0d1479aa40a35cb42f0e5afa1";
const COMMIT = `${REPO}@${SHA}`;
const TOPIC = `gh/${REPO}/commit/${SHA}/ci`;
const FAKE_GH = `#!/bin/sh
case "$2" in
  user) echo tester ;;
  graphql) echo '{"data":{"r":{"c0":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[{"__typename":"CheckRun","name":"check","conclusion":"SUCCESS"}]}}}}}}' ;;
  *) exit 1 ;;
esac
`;

type Stub = { events: { topic: string; status: number }[]; home: string; stop: () => Promise<void> };
const running: Stub[] = [];
afterEach(async () => {
  for (const stub of running.splice(0)) await stub.stop();
});

function startSentryAgainstStubYarn({ watches, sessions, refusedEvents }: { watches: object[]; sessions: object[]; refusedEvents: number }): Stub {
  const home = mkdtempSync(join(tmpdir(), "yarn-gh-commit-"));
  const instance = `ci-${crypto.randomUUID().slice(0, 6)}`;
  const state = join(home, `.maxflow-v2-${instance}`);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "gh-commit-watch.json"), JSON.stringify(watches));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const events: Stub["events"] = [];
  const yarn = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/sessions") return Response.json(sessions);
      if (path !== "/api/events") return new Response("ok");
      const { topic } = (await req.json()) as { topic: string };
      const status = events.filter((e) => e.topic === topic).length < refusedEvents ? 503 : 200;
      events.push({ topic, status });
      return new Response(status === 503 ? "yarn is down" : "ok", { status });
    },
  });
  const sentry = Bun.spawn(["bun", join(import.meta.dir, "../sentries/gh.ts")], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env["PATH"] ?? ""}`, YARN_INSTANCE: instance, YARN_PORT: String(yarn.port), ...noSessionEnv(), GH_SENTRY_INTERVAL: "300", GH_STRANDED_CI_WAIT_MS: "60000" },
    stdout: "ignore",
    stderr: "ignore",
  });
  const stub: Stub = {
    events,
    home: state,
    stop: async () => {
      sentry.kill();
      await sentry.exited;
      await yarn.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
  running.push(stub);
  return stub;
}

async function until(isDone: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end && !isDone(); ) await Bun.sleep(100);
}

const watchedCommits = (stub: Stub) => (JSON.parse(readFileSync(join(stub.home, "gh-commit-watch.json"), "utf8")) as { key: string }[]).map((w) => w.key);

describe("0e988876: its wait on ci:<sha> never ended though CI on b7e72a2 passed while yarn restarted for a deploy", () => {
  test("a CI event yarn refuses (503 while it restarts) keeps the watch, and the next poll announces it again", async () => {
    const stub = startSentryAgainstStubYarn({ watches: [{ key: COMMIT, sessions: ["0e988876"], at: Date.now() }], sessions: [], refusedEvents: 1 });
    await until(() => stub.events.some((e) => e.status === 200), 15_000);
    expect(stub.events.filter((e) => e.topic === TOPIC).map((e) => e.status)).toEqual([503, 200]);
    await until(() => watchedCommits(stub).length === 0, 5000);
    expect(watchedCommits(stub)).toEqual([]);
  }, 30_000);

  test("a ci:<sha> wait past the stranded age with no watch behind it is checked again and announced", async () => {
    const wait = { kind: "ci", ref: COMMIT, at: Date.now() - 120_000 };
    const stub = startSentryAgainstStubYarn({ watches: [], sessions: [{ id: "0e988876", name: "agent", cwd: "/", running: false, sentry: false, links: [], pending: 0, status: "idle", blocked: null, wait }], refusedEvents: 0 });
    await until(() => stub.events.length > 0, 15_000);
    expect(stub.events).toEqual([{ topic: TOPIC, status: 200 }]);
  }, 30_000);
});
