import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { STATE_DIR } from "./instance";

// yarn's state, in one SQLite file. Stores move here from their JSON files one at a time; a moved store's JSON file is
// imported once by its migration and then left as it was, a backup nothing reads or writes.
// WAL lets other processes read while the server writes; busy_timeout makes a writer wait out another instead of failing.
mkdirSync(STATE_DIR, { recursive: true });
const db = new Database(`${STATE_DIR}/yarn.db`, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

type Row = { id: string };

const createList = (table: string) => db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL)`);
function importList(table: string, file: string) {
  if (!existsSync(file)) return;
  const insert = db.prepare(`INSERT INTO ${table} (id, pos, data) VALUES (?, ?, ?)`);
  (JSON.parse(readFileSync(file, "utf8")) as Row[]).forEach((row, pos) => insert.run(row.id, pos, JSON.stringify(row)));
}

// Run once each, in order, in one transaction with the version bump; user_version counts the ones done. Append only.
const MIGRATIONS: (() => void)[] = [
  () => (createList("threads"), importList("threads", `${STATE_DIR}/threads.json`)),
];
const version = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
for (let v = version(); v < MIGRATIONS.length; v++)
  db.transaction(() => (MIGRATIONS[v](), db.exec(`PRAGMA user_version = ${v + 1}`)))();

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
        const data = JSON.stringify(row);
        ids.add(row.id);
        if (stored.get(row.id) === `${pos}\n${data}`) return;
        upsert.run(row.id, pos, data);
        stored.set(row.id, `${pos}\n${data}`);
      });
      for (const id of stored.keys()) if (!ids.has(id)) remove.run(id), stored.delete(id);
    }),
  };
}

export const threadsTable = listTable<Row & { messages: unknown[] }>("threads");
