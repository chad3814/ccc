import { PGlite } from '@electric-sql/pglite';
import type { Database, Row, Sql, SqlValue } from './sql.js';

interface PgliteQueryable {
  query<T>(query: string, params?: SqlValue[]): Promise<{ rows: T[] }>;
  exec(query: string): Promise<object[]>;
}

function pgliteSql(db: PgliteQueryable): Sql {
  return {
    async query<R extends object = Row>(text: string, params: readonly SqlValue[] = []) {
      const result = await db.query<R>(text, [...params]);
      return { rows: result.rows };
    },
    async exec(text: string) {
      await db.exec(text);
    },
  };
}

// In-memory Postgres for tests: each call without an argument is a fresh,
// empty database.
export function pgliteDatabase(db: PGlite = new PGlite()): Database {
  return {
    ...pgliteSql(db),
    transaction: (fn) => db.transaction((tx) => fn(pgliteSql(tx))),
  };
}
