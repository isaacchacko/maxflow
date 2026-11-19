import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { STATE_DIR } from "./instance";

// yarn's state, in one SQLite file. Stores move here from their JSON files one at a time; a moved store's JSON file is
// imported once by its migration and then left as it was, a backup nothing reads or writes.
// WAL lets other processes read while the server writes; busy_timeout makes a writer wait out another instead of failing.
mkdirSync(STATE_DIR, { recursive: true });
const db = new Database(`${STATE_DIR}/yarn.db`, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

// Ids are kept as TEXT; a store whose ids are numbers (tasks) gets them back as numbers from its JSON.
type Row = { id: string | number };

const createList = (table: string) => db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL)`);
const createMap = (table: string) => db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, data TEXT NOT NULL)`);
function importMap(table: string, file: string) {
  if (!existsSync(file)) return;
  const insert = db.prepare(`INSERT INTO ${table} (key, data) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)) insert.run(key, JSON.stringify(value));
}
function importList(table: string, file: string) {
  if (!existsSync(file)) return;
  const insert = db.prepare(`INSERT INTO ${table} (id, pos, data) VALUES (?, ?, ?)`);
  (JSON.parse(readFileSync(file, "utf8")) as Row[]).forEach((row, pos) => insert.run(String(row.id), pos, JSON.stringify(row)));
}

function importInboxFiles(dir: string) {
  if (!existsSync(dir)) return;
  const insert = db.prepare("INSERT INTO inboxes (key, data) VALUES (?, ?)");
  for (const file of readdirSync(dir)) if (file.endsWith(".json")) insert.run(file.slice(0, -".json".length), readFileSync(`${dir}/${file}`, "utf8"));
}

// Run once each, in order, with the version bump; user_version counts the ones done. Append only. Every process that opens the
// database runs them, so they run under the write lock, reading the version again once they hold it.
const MIGRATIONS: (() => void)[] = [
  () => (createList("threads"), importList("threads", `${STATE_DIR}/threads.json`)),
  () => (createList("tasks"), importList("tasks", `${STATE_DIR}/tasks.json`)),
  () => (createMap("gh_status"), importMap("gh_status", `${STATE_DIR}/gh-status.json`)),
  () => (createMap("slack_messages"), importMap("slack_messages", `${STATE_DIR}/slack-messages.json`)),
  () => (createList("objectives"), importList("objectives", `${STATE_DIR}/objectives.json`)),
  () => (createMap("names"), importMap("names", `${STATE_DIR}/names.json`)),
  () => (createList("todos"), importList("todos", `${STATE_DIR}/todos.json`)),
  () => {
    createMap("inboxes");
    importInboxFiles(`${STATE_DIR}/inboxes`);
  },
];
const version = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
if (version() < MIGRATIONS.length)
  db.transaction(() => {
    for (let v = version(); v < MIGRATIONS.length; v++) MIGRATIONS[v](), db.exec(`PRAGMA user_version = ${v + 1}`);
  }).immediate();

// A list of rows kept in order, the shape the server holds in memory. write() takes the whole list and stores only the rows
// that changed, moved or went, in one transaction.
function listTable<T extends Row>(table: string) {
  const select = db.prepare(`SELECT id, pos, data FROM ${table} ORDER BY pos`);
  const upsert = db.prepare(`INSERT INTO ${table} (id, pos, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET pos = excluded.pos, data = excluded.data`);
  const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  // What the table holds for each id, as `${pos}\n${data}`.
  const stored = new Map<string, string>();
  return {
    read(): T[] {
      const rows = select.all() as { id: string; pos: number; data: string }[];
      stored.clear();
      for (const r of rows) stored.set(r.id, `${r.pos}\n${r.data}`);
      return rows.map((r) => JSON.parse(r.data));
    },
    write: db.transaction((list: T[]) => {
      const ids = new Set<string>();
      list.forEach((row, pos) => {
        const id = String(row.id), data = JSON.stringify(row);
        ids.add(id);
        if (stored.get(id) === `${pos}\n${data}`) return;
        upsert.run(id, pos, data);
        stored.set(id, `${pos}\n${data}`);
      });
      for (const id of stored.keys()) if (!ids.has(id)) remove.run(id), stored.delete(id);
    }),
  };
}

export const threadsTable = listTable<Row & { messages: unknown[] }>("threads");
export const tasksTable = listTable<Row>("tasks");
export const objectivesTable = listTable<Row>("objectives");
export const todosTable = listTable<Row>("todos");

// Values by key, the shape a sentry keeps as a JSON object. write() takes the whole record and stores only the keys that
// changed or went. fresh() rereads only when another process has committed since the last read.
function mapTable<V>(table: string) {
  const select = db.prepare(`SELECT key, data FROM ${table}`);
  const one = db.prepare(`SELECT data FROM ${table} WHERE key = ?`);
  const upsert = db.prepare(`INSERT INTO ${table} (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data`);
  const remove = db.prepare(`DELETE FROM ${table} WHERE key = ?`);
  const dataVersion = db.prepare("PRAGMA data_version");
  // What the table holds for each key; filled by the first read, which a write does first if nothing has read yet.
  const stored = new Map<string, string>();
  let loaded = false, seen = -1, cached: Record<string, V> = {};
  const all = (): Record<string, V> => {
    const rows = select.all() as { key: string; data: string }[];
    (loaded = true), stored.clear();
    for (const r of rows) stored.set(r.key, r.data);
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.data)]));
  };
  return {
    all,
    get(key: string): V | undefined {
      const row = one.get(key) as { data: string } | null;
      return row ? JSON.parse(row.data) : undefined;
    },
    fresh(): Record<string, V> {
      const v = (dataVersion.get() as { data_version: number }).data_version;
      if (v !== seen) (cached = all()), (seen = v);
      return cached;
    },
    write: db.transaction((record: Record<string, V>) => {
      if (!loaded) all();
      // data_version moves only for other connections' commits, so this process's own write would go unseen by fresh().
      seen = -1;
      for (const [key, value] of Object.entries(record)) {
        const data = JSON.stringify(value);
        if (stored.get(key) !== data) upsert.run(key, data), stored.set(key, data);
      }
      for (const key of stored.keys()) if (!(key in record)) remove.run(key), stored.delete(key);
    }),
  };
}

// The gh sentry's last whole fetch of each PR, by owner/repo#n.
export const ghStatusTable = mapTable<{ at: number; pr: any }>("gh_status");

// What the slack sentry read from each thread, channel or search it watches, by target ("C…/ts", "C…", "search:…").
export type SlackKept = { at?: number; title: string; msgs: { ts: string; uid: string; who: string; text: string; link?: string; channel?: string; bot?: boolean }[] };
export const slackMessagesTable = mapTable<SlackKept>("slack_messages");

// The last name each session went by, by session id.
export const namesTable = mapTable<string>("names");

export type InboxKept = { inbox: string[]; sending?: { count: number; at: number } };
const inboxGet = db.prepare("SELECT data FROM inboxes WHERE key = ?");
const inboxPut = db.prepare("INSERT INTO inboxes (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data");
const inboxDelete = db.prepare("DELETE FROM inboxes WHERE key = ?");
export const inboxesTable = {
  get(id: string): InboxKept | undefined {
    const row = inboxGet.get(id) as { data: string } | null;
    return row ? (JSON.parse(row.data) as InboxKept) : undefined;
  },
  put(id: string, kept: InboxKept) {
    inboxPut.run(id, JSON.stringify(kept));
  },
  delete(id: string) {
    inboxDelete.run(id);
  },
};
