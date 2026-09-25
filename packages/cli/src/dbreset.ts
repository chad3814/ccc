import { pgDatabase, type Database } from '@ccc/runtime';

export interface OpenedDatabase {
  db: Database;
  close(): Promise<void>;
}

// Development only: wipes the public schema and recreates the tables.
export async function resetDatabase(db: Database, schema: string): Promise<void> {
  await db.exec('drop schema if exists public cascade; create schema public;');
  if (schema.trim() !== '') {
    await db.exec(schema);
  }
}

export async function openPgDatabase(url: string): Promise<OpenedDatabase> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  return { db: pgDatabase(pool), close: () => pool.end() };
}
