import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewName, snapshotLive } from "../previews";

const scratch = mkdtempSync(join(tmpdir(), "yarn-previews-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a preview is named for its branch, in characters an instance name and a dir can carry", () => {
  expect(previewName("feat/Banner_v2")).toBe("pv-feat-banner-v2");
  expect(previewName("previews")).toBe("pv-previews");
});

test("a live snapshot keeps threads, tasks and timelines and leaves Slack messages and agent inboxes behind", () => {
  const live = join(scratch, "live");
  const timelines = join(scratch, "Timelines");
  mkdirSync(join(timelines, "yarn"), { recursive: true });
  writeFileSync(join(timelines, "yarn", "now.txt"), "where it stands");
  mkdirSync(live, { recursive: true });
  const db = new Database(join(live, "yarn.db"));
  for (const table of ["threads", "tasks", "slack_messages", "inboxes"]) {
    db.run(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    db.run(`INSERT INTO ${table} VALUES ('a', '{}')`);
  }
  db.run("PRAGMA user_version = 9");
  db.close();

  const preview = join(scratch, "preview");
  snapshotLive(live, timelines, preview);

  const copy = new Database(join(preview, "yarn.db"), { readonly: true });
  const count = (table: string) => (copy.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  expect([count("threads"), count("tasks"), count("slack_messages"), count("inboxes")]).toEqual([1, 1, 0, 0]);
  expect((copy.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(9);
  copy.close();
  expect(existsSync(join(preview, "timelines", "yarn", "now.txt"))).toBe(true);
});
