import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, STATE_DIR } from "./instance";
import type { PolledPr } from "./gh";

mkdirSync(STATE_DIR, { recursive: true });
const once = <T>(make: () => T) => {
  const made: { value?: T } = {};
  return () => (made.value ??= make());
};

type Row = { id: string | number };
const idAsText = (row: Row) => String(row.id);

function createList(db: Database, table: string) {
  db.run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL)`);
}
function createMap(db: Database, table: string) {
  db.run(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, data TEXT NOT NULL)`);
}
function importMapFromJsonLeftAsBackup(db: Database, table: string, file: string) {
  if (!existsSync(file)) return;
  const insert = db.prepare(`INSERT INTO ${table} (key, data) VALUES (?, ?)`);
  const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) insert.run(key, JSON.stringify(value));
}
function importListFromJsonLeftAsBackup(db: Database, table: string, file: string) {
  if (!existsSync(file)) return;
  const insert = db.prepare(`INSERT INTO ${table} (id, pos, data) VALUES (?, ?, ?)`);
  const rows = JSON.parse(readFileSync(file, "utf8")) as Row[];
  for (const [pos, row] of rows.entries()) insert.run(idAsText(row), pos, JSON.stringify(row));
}
function moveList(db: Database, table: string, file: string) {
  createList(db, table);
  importListFromJsonLeftAsBackup(db, table, `${STATE_DIR}/${file}`);
}
function moveMap(db: Database, table: string, file: string) {
  createMap(db, table);
  importMapFromJsonLeftAsBackup(db, table, `${STATE_DIR}/${file}`);
}

function relabelMessage(db: Database, { thread, message, from }: { thread: string; message: string; from: string }) {
  const row = db.query("SELECT data FROM threads WHERE id = ?").get(thread) as { data: string } | null;
  if (row === null) return;
  const kept = JSON.parse(row.data) as { messages: { id: string; from: string }[] };
  const relabeled = { ...kept, messages: kept.messages.map((m) => (m.id === message ? { ...m, from } : m)) };
  db.query("UPDATE threads SET data = ? WHERE id = ?").run(JSON.stringify(relabeled), thread);
}

function importInboxFiles(db: Database, dir: string) {
  if (!existsSync(dir)) return;
  const insert = db.prepare("INSERT INTO inboxes (key, data) VALUES (?, ?)");
  for (const file of readdirSync(dir)) if (file.endsWith(".json")) insert.run(file.slice(0, -".json".length), readFileSync(`${dir}/${file}`, "utf8"));
}

// constraint: append only, run in order; SQLite's user_version counts the ones done, so a reordered or removed one reruns or skips others
const MIGRATIONS: ((db: Database) => void)[] = [
  (db) => moveList(db, "threads", "threads.json"),
  (db) => moveList(db, "tasks", "tasks.json"),
  (db) => moveMap(db, "gh_status", "gh-status.json"),
  (db) => moveMap(db, "slack_messages", "slack-messages.json"),
  (db) => moveList(db, "objectives", "objectives.json"),
  (db) => moveMap(db, "names", "names.json"),
  (db) => moveList(db, "todos", "todos.json"),
  (db) => {
    createMap(db, "inboxes");
    importInboxFiles(db, `${STATE_DIR}/inboxes`);
  },
  (db) => relabelMessage(db, { thread: "th-890892", message: "m-140a9e", from: "cleopatra/yarn-browser" }),
];
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
function migrateUnderWriteLockRecheckingVersion(db: Database) {
  if (version(db) >= MIGRATIONS.length) return;
  db.transaction(() => {
    for (let v = version(db); v < MIGRATIONS.length; v++) {
      MIGRATIONS[v]?.(db);
      db.run(`PRAGMA user_version = ${String(v + 1)}`);
    }
  }).immediate();
}
const READERS_BESIDE_WRITER_AND_WRITERS_WAIT_EACH_OTHER = "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;";
const database = once(() => {
  const db = new Database(`${STATE_DIR}/yarn.db`, { create: true, strict: true });
  db.run(READERS_BESIDE_WRITER_AND_WRITERS_WAIT_EACH_OTHER);
  migrateUnderWriteLockRecheckingVersion(db);
  return db;
});

function orderedListTableWritingOnlyChangedRows<T extends Row>(table: string) {
  const storedPosAndDataById = new Map<string, string>();
  const statements = once(() => {
    const db = database();
    const upsert = db.prepare(`INSERT INTO ${table} (id, pos, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET pos = excluded.pos, data = excluded.data`);
    const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    return {
      select: db.prepare(`SELECT id, pos, data FROM ${table} ORDER BY pos`),
      write: db.transaction((list: T[]) => {
        const ids = new Set<string>();
        for (const [pos, row] of list.entries()) {
          const id = idAsText(row);
          const data = JSON.stringify(row);
          ids.add(id);
          if (storedPosAndDataById.get(id) === `${String(pos)}\n${data}`) continue;
          upsert.run(id, pos, data);
          storedPosAndDataById.set(id, `${String(pos)}\n${data}`);
        }
        for (const id of storedPosAndDataById.keys()) {
          if (ids.has(id)) continue;
          remove.run(id);
          storedPosAndDataById.delete(id);
        }
      }),
    };
  });
  return {
    read(): T[] {
      const rows = statements().select.all() as { id: string; pos: number; data: string }[];
      storedPosAndDataById.clear();
      for (const r of rows) storedPosAndDataById.set(r.id, `${String(r.pos)}\n${r.data}`);
      return rows.map((r) => JSON.parse(r.data) as T);
    },
    write: (list: T[]) => {
      statements().write(list);
    },
  };
}

export const threadsTable = orderedListTableWritingOnlyChangedRows<Row & { messages: unknown[] }>("threads");
export const tasksTable = orderedListTableWritingOnlyChangedRows<Row>("tasks");
export const objectivesTable = orderedListTableWritingOnlyChangedRows<Row>("objectives");
export const todosTable = orderedListTableWritingOnlyChangedRows<Row>("todos");

function keyedTableWritingOnlyChangedKeys<V>(table: string) {
  type KeyedRead = { hasLoaded: boolean; dataVersionSeen: number; cached: Record<string, V> };
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
  const storedDataByKey = new Map<string, string>();
  const read: KeyedRead = { hasLoaded: false, dataVersionSeen: -1, cached: {} };
  const all = (): Record<string, V> => {
    const rows = statements().select.all() as { key: string; data: string }[];
    read.hasLoaded = true;
    storedDataByKey.clear();
    for (const r of rows) storedDataByKey.set(r.key, r.data);
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.data) as V]));
  };
  const writeChangedKeys = (record: Record<string, V>) => {
    const { upsert, remove } = statements();
    for (const [key, value] of Object.entries(record)) {
      const data = JSON.stringify(value);
      if (storedDataByKey.get(key) === data) continue;
      upsert.run(key, data);
      storedDataByKey.set(key, data);
    }
    for (const key of storedDataByKey.keys()) {
      if (Object.hasOwn(record, key)) continue;
      remove.run(key);
      storedDataByKey.delete(key);
    }
  };
  return {
    all,
    get(key: string): V | undefined {
      const row = statements().one.get(key) as { data: string } | null;
      return row ? JSON.parse(row.data) as V : undefined;
    },
    fresh(): Record<string, V> {
      const v = (statements().dataVersion.get() as { data_version: number }).data_version;
      if (v !== read.dataVersionSeen) {
        read.cached = all();
        read.dataVersionSeen = v;
      }
      return read.cached;
    },
    write(record: Record<string, V>) {
      statements().db.transaction(() => {
        if (!read.hasLoaded) all();
        // constraint: SQLite's data_version moves only for other connections' commits, so fresh() wouldn't see this process's own write
        read.dataVersionSeen = -1;
        writeChangedKeys(record);
      })();
    },
  };
}

export const ghStatusTable = keyedTableWritingOnlyChangedKeys<PolledPr>("gh_status");

export type SlackKept = { at?: number; title: string; msgs: { ts: string; uid: string; who: string; text: string; link?: string; channel?: string; bot?: boolean }[] };
export const slackMessagesTable = keyedTableWritingOnlyChangedKeys<SlackKept>("slack_messages");

export const namesTable = keyedTableWritingOnlyChangedKeys<string>("names");

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
  throw new Error(`${name} is unreadable (${read.problem}). It gates an outward action, so this sentry won't start with it empty: restore or fix ${stateDisplayPath(name)}, then restart the sentry.`);
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
