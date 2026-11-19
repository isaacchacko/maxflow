import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, STATE_DIR } from "./instance";

// yarn's state, in one SQLite file. Stores move here from their JSON files one at a time; a moved store's JSON file is
// imported once by its migration and then left as it was, a backup nothing reads or writes.
// WAL lets other processes read while the server writes; busy_timeout makes a writer wait out another instead of failing.
mkdirSync(STATE_DIR, { recursive: true });
const once = <T>(make: () => T) => {
  const made: { value?: T } = {};
  return () => (made.value ??= make());
};

// Ids are kept as TEXT; a store whose ids are numbers (tasks) gets them back as numbers from its JSON.
type Row = { id: string | number };

const createList = (db: Database, table: string) => db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL)`);
const createMap = (db: Database, table: string) => db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, data TEXT NOT NULL)`);
function importMap(db: Database, table: string, file: string) {
  if (!existsSync(file)) return;
  const insert = db.prepare(`INSERT INTO ${table} (key, data) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)) insert.run(key, JSON.stringify(value));
}
function importList(db: Database, table: string, file: string) {
  if (!existsSync(file)) return;
  const insert = db.prepare(`INSERT INTO ${table} (id, pos, data) VALUES (?, ?, ?)`);
  (JSON.parse(readFileSync(file, "utf8")) as Row[]).forEach((row, pos) => insert.run(String(row.id), pos, JSON.stringify(row)));
}

function importInboxFiles(db: Database, dir: string) {
  if (!existsSync(dir)) return;
  const insert = db.prepare("INSERT INTO inboxes (key, data) VALUES (?, ?)");
  for (const file of readdirSync(dir)) if (file.endsWith(".json")) insert.run(file.slice(0, -".json".length), readFileSync(`${dir}/${file}`, "utf8"));
}

// Run once each, in order, with the version bump; user_version counts the ones done. Append only. Every process that opens the
// database runs them, so they run under the write lock, reading the version again once they hold it.
const MIGRATIONS: ((db: Database) => void)[] = [
  (db) => (createList(db, "threads"), importList(db, "threads", `${STATE_DIR}/threads.json`)),
  (db) => (createList(db, "tasks"), importList(db, "tasks", `${STATE_DIR}/tasks.json`)),
  (db) => (createMap(db, "gh_status"), importMap(db, "gh_status", `${STATE_DIR}/gh-status.json`)),
  (db) => (createMap(db, "slack_messages"), importMap(db, "slack_messages", `${STATE_DIR}/slack-messages.json`)),
  (db) => (createList(db, "objectives"), importList(db, "objectives", `${STATE_DIR}/objectives.json`)),
  (db) => (createMap(db, "names"), importMap(db, "names", `${STATE_DIR}/names.json`)),
  (db) => (createList(db, "todos"), importList(db, "todos", `${STATE_DIR}/todos.json`)),
  (db) => {
    createMap(db, "inboxes");
    importInboxFiles(db, `${STATE_DIR}/inboxes`);
  },
];
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
function migrate(db: Database) {
  if (version(db) >= MIGRATIONS.length) return;
  db.transaction(() => {
    for (let v = version(db); v < MIGRATIONS.length; v++) MIGRATIONS[v](db), db.exec(`PRAGMA user_version = ${v + 1}`);
  }).immediate();
}
const database = once(() => {
  const db = new Database(`${STATE_DIR}/yarn.db`, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
});

// A list of rows kept in order, the shape the server holds in memory. write() takes the whole list and stores only the rows
// that changed, moved or went, in one transaction.
function listTable<T extends Row>(table: string) {
  // What the table holds for each id, as `${pos}\n${data}`.
  const stored = new Map<string, string>();
  const statements = once(() => {
    const db = database();
    const upsert = db.prepare(`INSERT INTO ${table} (id, pos, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET pos = excluded.pos, data = excluded.data`);
    const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    return {
      select: db.prepare(`SELECT id, pos, data FROM ${table} ORDER BY pos`),
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
  });
  return {
    read(): T[] {
      const rows = statements().select.all() as { id: string; pos: number; data: string }[];
      stored.clear();
      for (const r of rows) stored.set(r.id, `${r.pos}\n${r.data}`);
      return rows.map((r) => JSON.parse(r.data));
    },
    write: (list: T[]) => statements().write(list),
  };
}

export const threadsTable = listTable<Row & { messages: unknown[] }>("threads");
export const tasksTable = listTable<Row>("tasks");
export const objectivesTable = listTable<Row>("objectives");
export const todosTable = listTable<Row>("todos");

// Values by key, the shape a sentry keeps as a JSON object. write() takes the whole record and stores only the keys that
// changed or went. fresh() rereads only when another process has committed since the last read.
function mapTable<V>(table: string) {
  const statements = once(() => {
    const db = database();
    return {
      db,
      select: db.prepare(`SELECT key, data FROM ${table}`),
      one: db.prepare(`SELECT data FROM ${table} WHERE key = ?`),
      upsert: db.prepare(`INSERT INTO ${table} (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data`),
      remove: db.prepare(`DELETE FROM ${table} WHERE key = ?`),
      dataVersion: db.prepare("PRAGMA data_version"),
    };
  });
  // What the table holds for each key; filled by the first read, which a write does first if nothing has read yet.
  const stored = new Map<string, string>();
  let loaded = false, seen = -1, cached: Record<string, V> = {};
  const all = (): Record<string, V> => {
    const rows = statements().select.all() as { key: string; data: string }[];
    (loaded = true), stored.clear();
    for (const r of rows) stored.set(r.key, r.data);
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.data)]));
  };
  return {
    all,
    get(key: string): V | undefined {
      const row = statements().one.get(key) as { data: string } | null;
      return row ? JSON.parse(row.data) : undefined;
    },
    fresh(): Record<string, V> {
      const v = (statements().dataVersion.get() as { data_version: number }).data_version;
      if (v !== seen) (cached = all()), (seen = v);
      return cached;
    },
    write(record: Record<string, V>) {
      const { db, upsert, remove } = statements();
      db.transaction(() => {
        if (!loaded) all();
        // data_version moves only for other connections' commits, so this process's own write would go unseen by fresh().
        seen = -1;
        for (const [key, value] of Object.entries(record)) {
          const data = JSON.stringify(value);
          if (stored.get(key) !== data) upsert.run(key, data), stored.set(key, data);
        }
        for (const key of stored.keys()) if (!(key in record)) remove.run(key), stored.delete(key);
      })();
    },
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
const inboxStatements = once(() => {
  const db = database();
  return {
    get: db.prepare("SELECT data FROM inboxes WHERE key = ?"),
    put: db.prepare("INSERT INTO inboxes (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data"),
    delete: db.prepare("DELETE FROM inboxes WHERE key = ?"),
  };
});
export const inboxesTable = {
  get(id: string): InboxKept | undefined {
    const row = inboxStatements().get.get(id) as { data: string } | null;
    return row ? (JSON.parse(row.data) as InboxKept) : undefined;
  },
  put(id: string, kept: InboxKept) {
    inboxStatements().put.run(id, JSON.stringify(kept));
  },
  delete(id: string) {
    inboxStatements().delete.run(id);
  },
};

const stateFile = (name: string) => join(STATE_DIR, name);

export function readStateText(name: string): string | undefined {
  try {
    return readFileSync(stateFile(name), "utf8");
  } catch {
    return undefined;
  }
}

export function peekStateJson(name: string): unknown {
  const text = readStateText(name);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type StateCheck<T> = (value: unknown) => value is T;
type StateRead<T> = { value: T } | { problem: string } | undefined;

function checkedState<T>(name: string, isValid: StateCheck<T>): StateRead<T> {
  const text = readStateText(name);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problem: `not JSON: ${String(error)}` };
  }
  return isValid(parsed) ? { value: parsed } : { problem: "JSON of the wrong shape" };
}

async function publishCorruptState(data: { name: string; problem: string; kept: string; isGating: boolean }) {
  try {
    await fetch(`${BASE}/api/events`, { method: "POST", body: JSON.stringify({ topic: `health/state/${data.name}`, data }), signal: AbortSignal.timeout(5000) });
  } catch (error) {
    console.error(`state: couldn't publish health/state/${data.name}:`, error);
  }
}

function reportCorruptState(name: string, problem: string, kept: string, isGating: boolean) {
  console.error(`state: ${name} is unreadable (${problem}); ${isGating ? "refusing to start empty" : `kept as ${kept}, starting empty`}`);
  void publishCorruptState({ name, problem, kept, isGating });
}

export function readStateJson<T>(name: string, isValid: StateCheck<T>): T | undefined {
  const read = checkedState(name, isValid);
  if (read === undefined) return undefined;
  if ("value" in read) return read.value;
  const kept = `${name}.corrupt-${String(Date.now())}`;
  renameSync(stateFile(name), stateFile(kept));
  reportCorruptState(name, read.problem, kept, false);
  return undefined;
}

export function readGatingStateJson<T>(name: string, isValid: StateCheck<T>): T | undefined {
  const read = checkedState(name, isValid);
  if (read === undefined) return undefined;
  if ("value" in read) return read.value;
  reportCorruptState(name, read.problem, name, true);
  throw new Error(`${name} is unreadable (${read.problem}). It gates an outward action, so this sentry won't start with it empty: restore or fix ~/.maxflow-v2/${name}, then restart the sentry.`);
}

export function writeStateJson(name: string, value: unknown) {
  const file = stateFile(name);
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

export function appendStateText(name: string, text: string) {
  appendFileSync(stateFile(name), text);
}

export function removeState(name: string) {
  rmSync(stateFile(name), { force: true });
}

export function removeStateDirectory(name: string) {
  rmSync(stateFile(name), { force: true, recursive: true });
}

const DEPLOY_LOCK = stateFile("deploy.lock");
const lockHolder = () => {
  try {
    return Number(readFileSync(DEPLOY_LOCK, "utf8"));
  } catch {
    return 0;
  }
};
export const deployLock = {
  holder: lockHolder,
  claim: () => {
    try {
      writeFileSync(DEPLOY_LOCK, String(process.pid), { flag: "wx" });
      return 0;
    } catch {
      const holder = lockHolder();
      return holder === 0 ? -1 : holder;
    }
  },
  dropIfHeldBy: (pid: number) => {
    if (lockHolder() === pid) rmSync(DEPLOY_LOCK, { force: true });
  },
};

export const hasState = (name: string) => existsSync(stateFile(name));

export function listState(directory: string): { name: string; modifiedAt: number }[] {
  const path = stateFile(directory);
  if (!existsSync(path)) return [];
  return readdirSync(path).map((name) => ({ name, modifiedAt: statSync(join(path, name)).mtimeMs }));
}

export function didClaimState(name: string): boolean {
  try {
    closeSync(openSync(stateFile(name), "wx"));
    return true;
  } catch {
    return false;
  }
}

export function stateDirectory(name: string): string {
  const path = stateFile(name);
  mkdirSync(path, { recursive: true });
  return path;
}

export function watchedStateFile<T>(name: string, empty: T) {
  const path = stateFile(name);
  let mtime = 0;
  let value = empty;
  return () => {
    try {
      const modifiedAt = statSync(path).mtimeMs;
      if (modifiedAt !== mtime) {
        value = JSON.parse(readFileSync(path, "utf8")) as T;
        mtime = modifiedAt;
      }
    } catch {
      return value;
    }
    return value;
  };
}

export function writeStateText(name: string, text: string): string {
  const file = stateFile(name);
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
  return file;
}

export const stateDisplayPath = (name: string) => stateFile(name);
