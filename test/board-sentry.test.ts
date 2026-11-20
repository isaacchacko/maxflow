import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "maxflow-board-sentry-"));
const name = `ci-${crypto.randomUUID().slice(0, 6)}`;
const stateDir = join(home, `.maxflow-v2-${name}`);
mkdirSync(stateDir);
const calls = join(home, "tail-calls.jsonl");

const event = (cursor: string, handle: string, text: string, re: string | null = null) =>
  JSON.stringify({
    cursor,
    type: "message.posted",
    payload: { channel: "general", text, re, thread: "key:a", labels: {} },
    message: { id: cursor, channel: "general", text, thread: "key:a" },
    actor: { handle, name: handle, kind: "agent" },
  });
const events = [event("11", "max/claude-max", "Urgent ticket PRO-7287 for Isaac"), event("12", "isaac/claude", "Seen", "11"), event("13", "max/claude-max", "Any news?", "11")];
const fakeBoard = join(home, "fake-board.ts");
writeFileSync(
  fakeBoard,
  `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const after = Number(args[args.indexOf("--after") + 1] ?? 0);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, token: process.env.BOARD_TOKEN, url: process.env.BOARD_URL, pid: process.pid }) + "\\n");
console.log("Vercel CLI noise");
for (const line of ${JSON.stringify(events)}) if (Number(JSON.parse(line).cursor) > after) console.log(line);
setInterval(() => {}, 1000);
`,
);

const got = { events: [] as { topic: string; data: { cursor: string; own: boolean } }[], threads: [] as { title: string; feed: { source: string; who: string } }[], more: [] as string[], failNextEvent: true };
const maxflow = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/api/threads") return Response.json(got.threads.map((_, i) => ({ id: `th-${String(i + 1)}` })));
    const body = (await req.json()) as never;
    if (path === "/api/events") {
      if (got.failNextEvent) {
        got.failNextEvent = false;
        return new Response("down", { status: 500 });
      }
      got.events.push(body);
      return Response.json({ seq: got.events.length });
    }
    if (path === "/api/threads") {
      got.threads.push(body);
      return Response.json({ id: `th-${String(got.threads.length)}` }, { status: 201 });
    }
    if (path === "/api/threads/th-1/messages") {
      got.more.push((body as { text: string }).text);
      return Response.json({}, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  },
});

writeFileSync(
  join(stateDir, "board.json"),
  JSON.stringify({ url: "http://board.test/api/board", tokenCommand: ["echo", "tok-1"], cli: ["bun", fakeBoard], self: ["isaac/claude"], startAfter: "10", objective: "agent-board-on-aca-postgres-devs" }),
);

const startSentry = () =>
  Bun.spawn(["bun", join(import.meta.dir, "../sentries/board.ts")], {
    env: { ...process.env, HOME: home, MAXFLOW_INSTANCE: name, MAXFLOW_PORT: String(maxflow.port), MAXFLOW_SESSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
const tailCalls = () =>
  readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { args: string[]; token: string; url: string; pid: number });
const savedCursor = () => (JSON.parse(readFileSync(join(stateDir, "board-state.json"), "utf8")) as { cursor: string }).cursor;
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(isDone: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (isDone()) return;
  throw new Error("timed out");
}

afterAll(() => {
  void maxflow.stop(true);
  rmSync(home, { recursive: true, force: true });
});

test("a failed publish leaves the cursor, the tail restarts from it, and only others' messages reach the funnel", async () => {
  const sentry = startSentry();
  try {
    await until(() => got.events.length === 3 && got.more.length === 1, 20_000);
    expect(got.events.map((e) => [e.topic, e.data.cursor, e.data.own])).toEqual([
      ["board/general/message.posted", "11", false],
      ["board/general/message.posted", "12", true],
      ["board/general/message.posted", "13", false],
    ]);
    expect(got.threads.map((t) => [t.feed.source, t.feed.who])).toEqual([["board", "max/claude-max"]]);
    expect(got.more).toHaveLength(1);
    expect(got.more[0]).toContain("Any news?");
    await until(() => savedCursor() === "13", 5000);
    const [first, second] = tailCalls();
    expect(first?.args).toEqual(["tail", "--json", "--as", "claude", "--after", "10"]);
    expect(second?.args).toEqual(["tail", "--json", "--as", "claude", "--after", "10"]);
    expect([second?.token, second?.url]).toEqual(["tok-1", "http://board.test/api/board"]);
  } finally {
    sentry.kill("SIGTERM");
    await sentry.exited;
  }
  const tailPid = tailCalls().at(-1)?.pid ?? 0;
  await until(() => !isRunning(tailPid), 5000);
}, 40_000);

test("a restart picks up after the saved cursor and replays nothing already in the log", async () => {
  const sentry = startSentry();
  try {
    await until(() => tailCalls().length === 3, 15_000);
    expect(tailCalls()[2]?.args.slice(-2)).toEqual(["--after", "13"]);
    await Bun.sleep(1000);
    expect(got.events).toHaveLength(3);
  } finally {
    sentry.kill("SIGTERM");
    await sentry.exited;
  }
}, 30_000);
