import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const NOTIFICATION_STORE_DIR = join(homedir(), "Library/Group Containers/group.com.apple.usernoted/db2");
const SLACK = "com.tinyspeck.slackmacgap";
const MAC_EPOCH_UNIX_SECONDS = 978_307_200;
// constraint: fs.watch hears nothing of usernoted's writes to its store, so the files are stat'ed this often instead.
const STAT_MS = 500;
const STORE_FILES = ["db", "db-wal", "db-shm"];
const NEW_ROWS = "select rec_id, data, delivered_date from record where app_id = ? and rec_id > ? order by rec_id";

export type Notice = { id: number; workspace: string; subtitle: string; body: string; ts: string | undefined; at: number };
type Row = { rec_id: number; data: Uint8Array; delivered_date: number };

const XML_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);
const decodeXmlEntities = (text: string) => text.replaceAll(/&(\w+);/g, (entity, name: string) => XML_ENTITIES.get(name) ?? entity);

function plistStringField(xml: string, key: string) {
  const match = new RegExp(String.raw`<key>${key}</key>\s*<string>([\s\S]*?)</string>`).exec(xml);
  return decodeXmlEntities(match?.[1] ?? "");
}

function binaryPlistToXml(data: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "slack-notice-"));
  try {
    writeFileSync(join(dir, "n.plist"), data);
    return Bun.spawnSync(["plutil", "-convert", "xml1", "-o", "-", join(dir, "n.plist")]).stdout.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseNotice(row: Row): Notice {
  const xml = binaryPlistToXml(row.data);
  const slackTs = /_(\d+\.\d+)$/.exec(plistStringField(xml, "iden"))?.[1];
  return {
    id: row.rec_id,
    workspace: plistStringField(xml, "titl"),
    subtitle: plistStringField(xml, "subt"),
    body: plistStringField(xml, "body"),
    ts: slackTs,
    at: (row.delivered_date + MAC_EPOCH_UNIX_SECONDS) * 1000,
  };
}

function copyStoreTo(dir: string) {
  for (const file of STORE_FILES) {
    if (existsSync(join(NOTIFICATION_STORE_DIR, file))) copyFileSync(join(NOTIFICATION_STORE_DIR, file), join(dir, file));
  }
}

function rowsFromCopyOfStore(app: number, after: number) {
  const dir = mkdtempSync(join(tmpdir(), "slack-notices-"));
  try {
    copyStoreTo(dir);
    const copy = new Database(join(dir, "db"), { readonly: true });
    const rows = copy.query<Row, [number, number]>(NEW_ROWS).all(app, after);
    copy.close();
    return rows;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function openStore(since?: number) {
  try {
    const db = new Database(join(NOTIFICATION_STORE_DIR, "db"), { readonly: true });
    const app = db.query<{ app_id: number }, [string]>("select app_id from app where identifier = ?").get(SLACK)?.app_id ?? -1;
    const after = since ?? db.query<{ id: number | null }, []>("select max(rec_id) as id from record").get()?.id ?? 0;
    return { db, app, after };
  } catch (error) {
    console.error(`notification store unreadable, polling only: ${String(error)}`);
    return null;
  }
}

const storeStamp = () => ["db-wal", "db"].map((file) => statSync(join(NOTIFICATION_STORE_DIR, file), { throwIfNoEntry: false })?.mtimeMs ?? 0).join(",");

export function didStartWatchingNotices(onNotice: (notice: Notice) => void, since?: number) {
  if (!existsSync(join(NOTIFICATION_STORE_DIR, "db"))) return false;
  const store = openStore(since);
  if (!store) return false;
  const { db, app } = store;
  let { after } = store;
  const newRows = (): Row[] => {
    try {
      return db.query<Row, [number, number]>(NEW_ROWS).all(app, after);
    } catch {
      return rowsFromCopyOfStore(app, after);
    }
  };
  const check = () => {
    try {
      for (const row of newRows()) {
        after = Math.max(after, row.rec_id);
        onNotice(parseNotice(row));
      }
    } catch (error) {
      console.error(`notification check failed: ${String(error)}`);
    }
  };
  let seen = storeStamp();
  setInterval(() => {
    const stamp = storeStamp();
    if (stamp === seen) return;
    seen = stamp;
    check();
  }, STAT_MS);
  check();
  return true;
}
