// A D1Database stand-in backed by node:sqlite, so the Worker's real query code
// runs against a real SQLite engine in tests.
//
// D1 is SQLite, and node:sqlite (built into Node 22) is SQLite, so the SQL needs
// no translation. What differs is the surface: D1 is promise-based and its
// statements are built with .bind(), while node:sqlite is synchronous and takes
// arguments positionally. This adapter is that translation and nothing more --
// it deliberately does NOT reimplement any behaviour, so a test failing here is
// a failure the deployed Worker would have too.
//
// Using this keeps the test suite dependency-free: no miniflare, no better-sqlite3.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('../../schema.sql', import.meta.url));

/** D1 returns booleans as 0/1 and rejects JS booleans in .bind(). Mirror that. */
function toSqliteValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value;
  return value;
}

class FakeD1PreparedStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  // D1's .bind() returns a NEW statement rather than mutating this one.
  bind(...params) {
    return new FakeD1PreparedStatement(this.db, this.sql, params.map(toSqliteValue));
  }

  #stmt() {
    this.db.queryCount += 1;
    return this.db.sqlite.prepare(this.sql);
  }

  async first(column) {
    const row = this.#stmt().get(...this.params);
    if (row === undefined) return null;
    return column === undefined ? row : row[column];
  }

  async all() {
    const results = this.#stmt().all(...this.params);
    return { success: true, results, meta: { rows_read: results.length } };
  }

  async run() {
    const info = this.#stmt().run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
}

export class FakeD1Database {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    // D1 enforces foreign keys; plain SQLite does not unless asked.
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    this.queryCount = 0;
  }

  prepare(sql) {
    return new FakeD1PreparedStatement(this, sql);
  }

  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this.sqlite.close();
  }
}
