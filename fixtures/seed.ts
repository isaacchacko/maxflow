import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = [
  "usage: bun fixtures/seed.ts <state dir>",
  "Writes a small fixture state into a dev instance's state dir (./dev.sh --seed), so a UI flow can be tried at once:",
  "two objectives, threads in each state the inbox shows (open, waiting on him, resolved, a subthread), a board with a",
  "task in every column, and today's todos. Times are relative to now so nothing reads as weeks old.",
].join("\n");

const dir = process.argv[2];
if (dir === undefined || dir === "") throw new Error(USAGE);
mkdirSync(dir, { recursive: true });

function startDatabaseOverSoStoresImportTheSeededJson(stateDir: string) {
  for (const f of ["yarn.db", "yarn.db-wal", "yarn.db-shm"]) rmSync(join(stateDir, f), { force: true });
}
startDatabaseOverSoStoresImportTheSeededJson(dir);
const now = Date.now();
const ago = (min: number) => now - min * 60_000;
const day = new Date(now - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data, null, 2));

const AUTHOR_IDS_OF_AGENTS_THAT_NEVER_RUN = { router: "a0000001", worker: "a0000002", other: "a0000003" };
const { router, worker, other } = AUTHOR_IDS_OF_AGENTS_THAT_NEVER_RUN;
write("names.json", { [router]: "router: Checkout redesign", [worker]: "cart summary component", [other]: "router: Flaky CI" });

write("objectives.json", [
  { id: "checkout-redesign", title: "Checkout redesign", cwd: process.env["HOME"], at: ago(600), page: [
    { id: "v", kind: "vision", w: 8, h: 2, goal: "A one-page checkout with the cart summary beside the form", doneWhen: ["Cart summary renders beside the form", "Storybook story for every cart state"] },
    { id: "s", kind: "status", w: 4, h: 2, summary: "Cart summary in review (#101); payment step next." },
  ] },
  { id: "flaky-ci", title: "Flaky CI", cwd: process.env["HOME"], at: ago(300), page: [] },
]);

write("threads.json", [
  { id: "th-seed01", title: "move the cart summary next to the form", objective: "checkout-redesign", routers: [router], messages: [
    { id: "m-seed01", from: "isaac", at: ago(240), text: "move the cart summary next to the form" },
    { id: "m-seed02", from: router, at: ago(235), text: `On it: [[agent:${worker}]] is building the summary as its own component.` },
    { id: "m-seed03", from: router, at: ago(30), text: "PR #101 is up with before/after screenshots. Should the summary stay visible on mobile, or collapse under the form?" },
  ], asks: { session: router, since: ago(30) } },
  { id: "th-seed02", title: "e2e checkout test fails one run in five", objective: "flaky-ci", routers: [other], messages: [
    { id: "m-seed04", from: "isaac", at: ago(180), text: "e2e checkout test fails one run in five" },
    { id: "m-seed05", from: other, at: ago(120), text: "It races the payment iframe's load event. Fixed in #102 with a wait on the frame; ten runs green." },
  ], resolved: { at: ago(110) } },
  { id: "th-seed03", title: "mobile layout", objective: "checkout-redesign", routers: [router], messages: [
    { id: "m-seed06", from: "isaac", at: ago(10), text: "collapse it under the form on mobile" },
  ], parent: { thread: "th-seed01", message: "m-seed03" } },
  { id: "th-seed04", title: "what's left before the payment step?", objective: "checkout-redesign", routers: [router], messages: [
    { id: "m-seed07", from: "isaac", at: ago(5), text: "what's left before the payment step?" },
  ] },
]);

type SeedTask = { id: number; title: string; status: string; minutes: number; events: string[] };
const task = ({ id, title, status, minutes, events }: SeedTask, extra = {}) => ({
  id, title, kind: "task", status, sessions: [], links: [], at: ago(minutes), updated: ago(minutes / 2), objective: "checkout-redesign",
  timeline: events.map((text, i) => ({ at: ago(minutes - i * 5), text })), ...extra,
});
write("tasks.json", [
  task({ id: 1, title: "Cart summary beside the form", status: "waiting", minutes: 240, events: ["opened from th-seed01", "why here: PR #101 waits on review"] }, { sessions: [worker], links: ["https://github.com/example/shop/pull/101"] }),
  task({ id: 2, title: "Mobile layout for the summary", status: "you", minutes: 30, events: ["why here: asks you whether it collapses on mobile"] }),
  task({ id: 3, title: "Payment step", status: "todo", minutes: 20, events: ["why here: starts after #101 merges"] }),
  task({ id: 4, title: "Storybook stories for cart states", status: "doing", minutes: 60, events: ["why here: worker writing the empty and overflow states"] }),
  task({ id: 5, title: "Flaky e2e checkout test", status: "done", minutes: 180, events: ["why here: #102 merged, ten runs green"] }, { objective: "flaky-ci" }),
  task({ id: 6, title: "Address autocomplete", status: "blocked", minutes: 90, events: ["why here: needs a Places API key nobody has issued"] }),
]);

write("todos.json", [
  { id: "seed0001", text: "review the cart summary PR", day, state: "doing", at: new Date(ago(60)).toISOString(), threadIds: ["th-seed01"] },
  { id: "seed0002", text: "decide the mobile layout", day, state: "todo", at: new Date(ago(30)).toISOString(), threadIds: [] },
  { id: "seed0003", text: "check CI after the e2e fix", day, state: "done", at: new Date(ago(170)).toISOString(), threadIds: ["th-seed02"] },
]);
console.log(`seeded ${dir}`);
