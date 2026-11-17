// The Slack notifications macOS shows on this Mac, read from its notification store as they land: a DM or mention reaches the
// slack sentry in about a second, where Slack's search index takes minutes. Slack shows none while its window is focused, under
// Do Not Disturb or for a muted conversation, and cuts long bodies short, so the sentry's own polling stays the backstop.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(process.env.HOME!, "Library/Group Containers/group.com.apple.usernoted/db2");
const SLACK = "com.tinyspeck.slackmacgap";
// The store's dates count from 2001, the Mac epoch.
const MAC_EPOCH = 978_307_200;
const FALLBACK_MS = 15_000;

// title: the workspace; subtitle: `#channel`, a private channel's bare name, or the person for a DM; ts: the message's Slack ts.
export type Notice = { id: number; title: string; subtitle: string; body: string; ts?: string; at: number };
type Row = { rec_id: number; data: Uint8Array; delivered_date: number };

const XML: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// A record's data is a binary plist; plutil turns it into XML, whose `req` dict holds titl, subt, body and iden (`<team>_<ts>`).
function parse(row: Row): Notice {
  const dir = mkdtempSync(join(tmpdir(), "slack-notice-"));
  try {
    writeFileSync(join(dir, "n.plist"), row.data);
    const xml = Bun.spawnSync(["plutil", "-convert", "xml1", "-o", "-", join(dir, "n.plist")]).stdout.toString();
    const field = (key: string) => (xml.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`))?.[1] ?? "").replace(/&(\w+);/g, (m, e) => XML[e] ?? m);
    return { id: row.rec_id, title: field("titl"), subtitle: field("subt"), body: field("body"), ts: field("iden").match(/_(\d+\.\d+)$/)?.[1], at: (row.delivered_date + MAC_EPOCH) * 1000 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Calls `onNotice` for each Slack notification delivered from now on (or after record `since`); false when the store can't be read (no access, or not macOS). */
export function watchNotices(onNotice: (n: Notice) => void, since?: number) {
  if (!existsSync(join(DIR, "db"))) return false;
  let db: Database, app: number, after: number;
  try {
    db = new Database(join(DIR, "db"), { readonly: true });
    app = (db.query("select app_id from app where identifier = ?").get(SLACK) as { app_id: number } | null)?.app_id ?? -1;
    after = since ?? (db.query("select max(rec_id) as id from record").get() as { id: number | null }).id ?? 0;
  } catch (e) {
    console.error(`notification store unreadable, polling only: ${e}`);
    return false;
  }
  const NEW = "select rec_id, data, delivered_date from record where app_id = ? and rec_id > ? order by rec_id";
  // A read never writes; while usernoted holds a lock, a copy of the store and its log is read instead.
  const rows = (): Row[] => {
    try {
      return db.query(NEW).all(app, after) as Row[];
    } catch {
      const dir = mkdtempSync(join(tmpdir(), "slack-notices-"));
      try {
        for (const f of ["db", "db-wal", "db-shm"]) if (existsSync(join(DIR, f))) copyFileSync(join(DIR, f), join(dir, f));
        const copy = new Database(join(dir, "db"), { readonly: true });
        const got = copy.query(NEW).all(app, after) as Row[];
        copy.close();
        return got;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
  const check = () => {
    try {
      for (const row of rows()) {
        after = Math.max(after, row.rec_id);
        onNotice(parse(row));
      }
    } catch (e) {
      console.error(`notification check failed: ${e}`);
    }
  };
  // The store's write-ahead log changes the moment a notification lands; a slow poll covers a missed file event.
  let soon: Timer | undefined;
  watch(DIR, () => {
    clearTimeout(soon);
    soon = setTimeout(check, 200);
  });
  setInterval(check, FALLBACK_MS);
  check();
  return true;
}
