export type SqlValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Uint8Array
  | readonly SqlValue[]
  | { readonly [key: string]: SqlValue };

export type Row = { readonly [column: string]: SqlValue };

export interface Sql {
  query<R extends object = Row>(text: string, params?: readonly SqlValue[]): Promise<{ rows: R[] }>;
  exec(text: string): Promise<void>;
}

export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

// The parts of node-postgres ccc uses; a pg.Pool satisfies PgPool.
export interface PgQueryable {
  query(text: string, values?: SqlValue[]): Promise<{ rows: Row[] }>;
}

export interface PgClient extends PgQueryable {
  release(): void;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
}

function pgSql(client: PgQueryable): Sql {
  return {
    async query<R extends object = Row>(text: string, params: readonly SqlValue[] = []) {
      const result = await client.query(text, [...params]);
      return { rows: result.rows as R[] };
    },
    async exec(text: string) {
      await client.query(text);
    },
  };
}

export function pgDatabase(pool: PgPool): Database {
  return {
    ...pgSql(pool),
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const value = await fn(pgSql(client));
        await client.query('commit');
        return value;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export async function withTransaction<T>(db: Database, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
