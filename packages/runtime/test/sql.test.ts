import { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../src/pglite.js';
import { pgDatabase, withTransaction, type Database, type PgPool, type Row, type SqlValue } from '../src/sql.js';

// Compile-time check: a real pg.Pool satisfies the structural PgPool.
export const acceptsPgPool = (pool: pg.Pool): PgPool => pool;

// A PgPool backed by one PGlite connection, so pgDatabase can be tested
// without a Postgres server.
function fakePool(lite: PGlite): PgPool {
  const client = {
    query: async (text: string, values: SqlValue[] = []) => lite.query<Row>(text, values),
    release: () => undefined,
  };
  return { query: client.query, connect: async () => client };
}

async function exercise(db: Database): Promise<void> {
  await db.exec('create table t (id text primary key, n integer not null, data jsonb)');
  await db.query('insert into t values ($1, $2, $3)', ['a', 1, JSON.stringify({ x: 1 })]);
  const { rows } = await db.query<{ id: string; n: number; data: { x: number } }>('select * from t');
  expect(rows).toEqual([{ id: 'a', n: 1, data: { x: 1 } }]);

  expect(await withTransaction(db, async (tx) => {
    await tx.query('insert into t values ($1, $2, null)', ['b', 2]);
    return 'done';
  })).toBe('done');
  await expect(
    db.transaction(async (tx) => {
      await tx.query('insert into t values ($1, $2, null)', ['c', 3]);
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  const count = await db.query<{ c: number }>('select count(*)::int as c from t');
  expect(count.rows[0]?.c).toBe(2);
}

describe('Database implementations', () => {
  it('pgliteDatabase queries, commits, and rolls back', async () => {
    await exercise(pgliteDatabase());
  });

  it('pgDatabase queries, commits, and rolls back through a pool', async () => {
    await exercise(pgDatabase(fakePool(new PGlite())));
  });
});
