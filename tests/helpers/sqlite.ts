import { DatabaseSync } from "node:sqlite";

// Writes a SQLite file with two tables, `people` (5 rows, with a NULL, a REAL, a BLOB and unicode) and `other` (one row
// with a secret in it). SQLite is written by node:sqlite, a different implementation from the extension that reads it.
export function writeSqlite(path: string, opts: { wal?: boolean; extra?: (db: DatabaseSync) => void } = {}): void {
  const db = new DatabaseSync(path);
  if (opts.wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score REAL, photo BLOB, born TEXT);
    INSERT INTO people VALUES (0, 'n0', 0.5, x'00ff', '2020-01-01'), (1, 'n1', NULL, NULL, NULL), (2, 'ünï', 2.25, x'', '1999-12-31'),
                              (3, 'n3', 3.5, NULL, NULL), (4, 'n4', 4.75, NULL, NULL);
    CREATE TABLE other(secret TEXT);
    INSERT INTO other VALUES ('SECRET');
  `);
  opts.extra?.(db);
  db.close();
}
