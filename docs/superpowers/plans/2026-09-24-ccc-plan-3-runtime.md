# ccc Plan 3: Runtime, Adapters, and Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generated projects run as real services: `@ccc/runtime` provides errors, HTTP helpers, a database abstraction (pg and PGlite), and scopes that make syncs fire atomically. `ccc build` emits sync wiring, a composition root (`createApp`), a Node entry point, and the combined schema. `ccc db reset` rebuilds a dev database.

**Architecture:** `packages/runtime` is a small hand-written library with no LLM involvement. Syncs are wired by patching the trigger class's prototype method in a generated `wiring.ts`. The patched method defers the handler into the current `Scope` (AsyncLocalStorage), and `withScope` drains deferred work before it resolves, so a failing handler fails the operation. The composition root builds adapters (`new Store(db)`), binds them as scope singletons, and lazily loads each endpoint's `createHandler(container)`. Endpoints build last so their tests can exercise the whole app.

**Tech Stack:** Plan 2's stack plus `@electric-sql/pglite` 0.5 (hermetic Postgres for tests), `pg` 8 (production pool), `hono` 4 (inside generated endpoints), `@hono/node-server` 2 (in the generated entry point), `node:async_hooks`.

**Spec:** `docs/superpowers/specs/2026-09-24-ccc-design.md` (§3.4 stage 5, §3.5 `db reset`, §5). Plans 1–2 are complete (including their review fixes) on branch `plan-2-build`.

**Plan series:** Plan 3 of 4. Plan 4 builds the card-game example.

**Where to work:** worktree `worktrees/plan-3-runtime` on branch `plan-3-runtime`, which starts at `plan-2-build`'s head.

## Global Constraints

- Everything in Plans 1–2's Global Constraints still applies.
- `pnpm verify` becomes `pnpm lint && pnpm build && pnpm typecheck && pnpm test`. The runtime's `dist/` must exist before the CLI type-checks or tests, because the CLI resolves `@ccc/runtime` through its package exports.
- The runtime never writes the `unknown` or `any` types. Row data is typed with `SqlValue`/`Row`, and casts are limited to generic narrowing (`as R[]`, `as T`).
- Adapter conventions, enforced by `ccc check`:
  - A store's primary class takes `constructor(db: Database)`, and its `## Schema` holds a fenced `sql` block.
  - Auth's primary class takes `constructor(db: Database)` and has an `authenticate(request)` method.
  - An endpoint exports `createHandler(deps)`, which returns `(request: Request) => Promise<Response>`. Its `deps` keys are `db` plus the camelCase ids of adapters.
  - A sync's `when` must be a method.
  - `server`, `main`, `wiring`, and `schema` are reserved top-level concept names.
- Interfaces may contain `import type { ... } from '@ccc/runtime'`, and no other import.

## Review Focus

1. A sync handler that throws or rejects. The operation's `withScope` must reject with that error, and no deferred work may escape as an unhandled rejection. Tested in Task 3.
2. Two syncs on the same trigger method. Both fire, in sync-id order, each exactly once. Tested in Task 7.
3. A request body read by more than one endpoint. Each endpoint gets its own clone. Tested in Task 11.
4. A domain sync target missing from the scope. The error must name the sync and the concept id to bind. Tested in Task 3.
5. A project with stores but no endpoints, or with no syncs. `server.ts` and `wiring.ts` still type-check. Tested in Task 7.

---

### Task 1: Runtime package: errors, HTTP helpers, config

**Files:**
- Create: `packages/runtime/package.json`, `packages/runtime/tsconfig.json`, `packages/runtime/tsconfig.build.json`, `packages/runtime/vitest.config.ts`
- Create: `packages/runtime/src/errors.ts`, `packages/runtime/src/http.ts`, `packages/runtime/src/config.ts`, `packages/runtime/src/index.ts`
- Modify: root `package.json` (`verify` order)
- Test: `packages/runtime/test/errors.test.ts`, `packages/runtime/test/http.test.ts`

**Interfaces:**
- Produces (exported from `@ccc/runtime`): `DomainError` (`status: number`, default 400), `Invalid` (400), `Unauthorized` (401), `NotFound` (404), `Conflict` (409); `httpStatusOf(err: Error): number`; `type JsonValue`; `UNMATCHED_HEADER = 'x-ccc-unmatched'`; `json(body: JsonValue, status?: number): Response`; `unmatched(): Response`; `isUnmatched(response: Response): boolean`; `errorResponse(err: Error): Response`; `interface CccConfig`; `defineConfig(config: CccConfig): CccConfig`

- [ ] **Step 1: Create the package**

`packages/runtime/package.json`:
```json
{
  "name": "@ccc/runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./pglite": {
      "types": "./dist/pglite.d.ts",
      "default": "./dist/pglite.js"
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@electric-sql/pglite": "^0.5.8"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/pg": "^8.23.1",
    "vitest": "^5.0.1"
  }
}
```

`packages/runtime/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["es2024", "dom"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/runtime/tsconfig.build.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": false,
    "lib": ["es2024", "dom"]
  },
  "include": ["src"]
}
```

`packages/runtime/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

In the root `package.json`, change `verify` to:
```json
"verify": "pnpm lint && pnpm build && pnpm typecheck && pnpm test"
```

Run: `pnpm install` (expected: the new workspace package is linked).

- [ ] **Step 2: Write the failing tests**

`packages/runtime/test/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Conflict, DomainError, Invalid, NotFound, Unauthorized, httpStatusOf } from '../src/errors.js';

describe('errors', () => {
  it('carry HTTP statuses and their class names', () => {
    expect(new DomainError('x').status).toBe(400);
    expect(new Invalid('x').status).toBe(400);
    expect(new Unauthorized('x').status).toBe(401);
    expect(new NotFound('x').status).toBe(404);
    expect(new Conflict('x').status).toBe(409);
    expect(new Conflict('taken').name).toBe('Conflict');
    expect(new Conflict('taken')).toBeInstanceOf(DomainError);
  });

  it('maps unknown errors to 500', () => {
    expect(httpStatusOf(new NotFound('x'))).toBe(404);
    expect(httpStatusOf(new Error('boom'))).toBe(500);
  });
});
```

`packages/runtime/test/http.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Conflict } from '../src/errors.js';
import { UNMATCHED_HEADER, errorResponse, isUnmatched, json, unmatched } from '../src/http.js';
import { defineConfig } from '../src/config.js';

describe('http helpers', () => {
  it('builds JSON responses', async () => {
    const response = json({ a: [1, 'b', null] }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ a: [1, 'b', null] });
  });

  it('marks unmatched routes distinctly from real 404s', () => {
    expect(isUnmatched(unmatched())).toBe(true);
    expect(unmatched().headers.get(UNMATCHED_HEADER)).toBe('1');
    expect(isUnmatched(json({ error: 'no such game' }, 404))).toBe(false);
  });

  it('turns errors into JSON error responses', async () => {
    const response = errorResponse(new Conflict('seat taken'));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'seat taken' });
    expect(errorResponse(new Error('boom')).status).toBe(500);
  });

  it('passes config through defineConfig', () => {
    expect(defineConfig({ maxAttempts: 2 })).toEqual({ maxAttempts: 2 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ccc/runtime exec vitest run`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`packages/runtime/src/errors.ts`:
```ts
// Domain errors that endpoints can map to HTTP statuses. Concepts may throw
// their own Error subclasses too; those map to 500 unless an endpoint
// translates them.
export class DomainError extends Error {
  readonly status: number = 400;

  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class Invalid extends DomainError {
  override readonly status = 400;
}

export class Unauthorized extends DomainError {
  override readonly status = 401;
}

export class NotFound extends DomainError {
  override readonly status = 404;
}

export class Conflict extends DomainError {
  override readonly status = 409;
}

export function httpStatusOf(err: Error): number {
  return err instanceof DomainError ? err.status : 500;
}
```

`packages/runtime/src/http.ts`:
```ts
import { httpStatusOf } from './errors.js';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// Endpoints answer routes they don't own with unmatched(), so the
// composition root can try the next endpoint; a real 404 lacks the header.
export const UNMATCHED_HEADER = 'x-ccc-unmatched';

export function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function unmatched(): Response {
  return new Response('Not Found', { status: 404, headers: { [UNMATCHED_HEADER]: '1' } });
}

export function isUnmatched(response: Response): boolean {
  return response.status === 404 && response.headers.get(UNMATCHED_HEADER) === '1';
}

export function errorResponse(err: Error): Response {
  return json({ error: err.message }, httpStatusOf(err));
}
```

`packages/runtime/src/config.ts`:
```ts
export interface CccConfig {
  models?: { impl?: string; tests?: string };
  maxAttempts?: number;
  testMaxAttempts?: number;
  concurrency?: number;
}

export function defineConfig(config: CccConfig): CccConfig {
  return config;
}
```

`packages/runtime/src/index.ts`:
```ts
export { defineConfig, type CccConfig } from './config.js';
export { Conflict, DomainError, Invalid, NotFound, Unauthorized, httpStatusOf } from './errors.js';
export { UNMATCHED_HEADER, errorResponse, isUnmatched, json, unmatched, type JsonValue } from './http.js';
```

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/runtime exec vitest run` (expected: PASS), then `pnpm verify` (expected: all green; `packages/runtime/dist/index.js` exists).
```bash
git add package.json pnpm-lock.yaml packages/runtime
git commit -m "Add @ccc/runtime with domain errors, HTTP helpers, and defineConfig"
```

---

### Task 2: Runtime database abstraction

**Files:**
- Create: `packages/runtime/src/sql.ts`, `packages/runtime/src/pglite.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/sql.test.ts`

**Interfaces:**
- Produces: `type SqlValue`; `type Row = { readonly [column: string]: SqlValue }`; `interface Sql { query<R extends object = Row>(text: string, params?: readonly SqlValue[]): Promise<{ rows: R[] }>; exec(text: string): Promise<void> }`; `interface Database extends Sql { transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> }`; `interface PgQueryable`, `PgClient`, `PgPool` (the structural subset of `pg` ccc uses); `pgDatabase(pool: PgPool): Database`; `withTransaction<T>(db: Database, fn: (tx: Sql) => Promise<T>): Promise<T>`. From `@ccc/runtime/pglite`: `pgliteDatabase(db?: PGlite): Database`.

- [ ] **Step 1: Write the failing test**

`packages/runtime/test/sql.test.ts`:
```ts
import { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../src/pglite.js';
import { pgDatabase, withTransaction, type Database, type PgPool, type SqlValue } from '../src/sql.js';

// Compile-time check: a real pg.Pool satisfies the structural PgPool.
export const acceptsPgPool = (pool: pg.Pool): PgPool => pool;

// A PgPool backed by one PGlite connection, so pgDatabase can be tested
// without a Postgres server.
function fakePool(lite: PGlite): PgPool {
  const client = {
    query: async (text: string, values: SqlValue[] = []) => lite.query(text, values),
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/runtime exec vitest run sql`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/runtime/src/sql.ts`:
```ts
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
```

`packages/runtime/src/pglite.ts`:
```ts
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
```

Add to `packages/runtime/src/index.ts`:
```ts
export {
  pgDatabase,
  withTransaction,
  type Database,
  type PgClient,
  type PgPool,
  type PgQueryable,
  type Row,
  type Sql,
  type SqlValue,
} from './sql.js';
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/runtime exec vitest run sql` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/runtime
git commit -m "Add the runtime Database abstraction for pg and PGlite"
```

---

### Task 3: Scopes and sync plumbing

**Files:**
- Create: `packages/runtime/src/scope.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/scope.test.ts`

**Interfaces:**
- Produces: `class SyncTargetMissing extends Error`; `class Scope` (`resolve<T extends object>(id: string, sync: string): T`, `defer(work: Promise<void>): void`, `drain(): Promise<void>`, `bindings(): ReadonlyMap<string, object>`); `withScope<T>(bindings: Readonly<Record<string, object>>, fn: () => Promise<T>): Promise<T>`; `currentScope(): Scope | undefined`; `afterAction<R>(result: R, sync: string, run: (settled: Awaited<R>, scope: Scope) => Promise<void>): R`

- [ ] **Step 1: Write the failing test**

`packages/runtime/test/scope.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SyncTargetMissing, afterAction, currentScope, withScope } from '../src/scope.js';

class Game {
  dealt = 0;
}

describe('withScope', () => {
  it('binds values, merging nested scopes', async () => {
    const game = new Game();
    const store = { name: 'store' };
    await withScope({ 'game-store': store }, async () => {
      await withScope({ game }, async () => {
        expect(currentScope()?.resolve<Game>('game', 's')).toBe(game);
        expect(currentScope()?.resolve<{ name: string }>('game-store', 's')).toBe(store);
      });
    });
    expect(currentScope()).toBeUndefined();
  });

  it('names the sync and the missing binding', async () => {
    await withScope({}, async () => {
      expect(() => currentScope()?.resolve('game', 'game.deal-on-full-table')).toThrow(SyncTargetMissing);
      expect(() => currentScope()?.resolve('game', 'game.deal-on-full-table')).toThrow(
        "sync game.deal-on-full-table needs 'game' in scope; bind it with withScope({ 'game': ... }, ...)",
      );
    });
  });
});

describe('afterAction', () => {
  it('runs deferred sync work before withScope resolves, including chains', async () => {
    const order: string[] = [];
    const result = await withScope({}, async () => {
      const value = afterAction(41, 'first', async (settled, scope) => {
        order.push(`first:${settled}`);
        scope.defer(Promise.resolve().then(() => void order.push('chained')));
      });
      order.push('action returned');
      return value + 1;
    });
    expect(result).toBe(42);
    expect(order).toEqual(['action returned', 'first:41', 'chained']);
  });

  it('waits for async actions and passes their settled value', async () => {
    let seen = '';
    await withScope({}, async () => {
      await afterAction(Promise.resolve('ok'), 's', async (settled) => {
        seen = settled;
      });
    });
    expect(seen).toBe('ok');
  });

  it('fails the operation when a sync fails, without unhandled rejections', async () => {
    await expect(
      withScope({}, async () => {
        afterAction(undefined, 'a', async () => {
          throw new Error('handler failed');
        });
        afterAction(undefined, 'b', async () => {
          throw new Error('second failure');
        });
      }),
    ).rejects.toThrow('handler failed');
  });

  it('skips syncs when an async action rejects', async () => {
    let ran = false;
    await expect(
      withScope({}, async () => {
        await afterAction(Promise.reject(new Error('action failed')), 's', async () => {
          ran = true;
        });
      }),
    ).rejects.toThrow('action failed');
    expect(ran).toBe(false);
  });

  it('refuses to run outside a scope', () => {
    expect(() => afterAction(1, 'orphan', async () => undefined)).toThrow('sync orphan fired outside withScope');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/runtime exec vitest run scope`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/runtime/src/scope.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export class SyncTargetMissing extends Error {}

// One unit of work: named bindings that syncs resolve their targets from,
// and sync work deferred until the unit finishes.
export class Scope {
  readonly #bindings: Map<string, object>;
  readonly #pending: Promise<void>[] = [];

  constructor(bindings: ReadonlyMap<string, object>) {
    this.#bindings = new Map(bindings);
  }

  resolve<T extends object>(id: string, sync: string): T {
    const value = this.#bindings.get(id);
    if (value === undefined) {
      throw new SyncTargetMissing(`sync ${sync} needs '${id}' in scope; bind it with withScope({ '${id}': ... }, ...)`);
    }
    return value as T;
  }

  defer(work: Promise<void>): void {
    this.#pending.push(work);
  }

  // Deferred work may defer more; settle everything, then rethrow the first
  // failure so none become unhandled rejections.
  async drain(): Promise<void> {
    let failure: PromiseRejectedResult | undefined;
    while (this.#pending.length > 0) {
      const results = await Promise.allSettled(this.#pending.splice(0));
      failure ??= results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    }
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  bindings(): ReadonlyMap<string, object> {
    return this.#bindings;
  }
}

const storage = new AsyncLocalStorage<Scope>();

export async function withScope<T>(bindings: Readonly<Record<string, object>>, fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  const scope = new Scope(new Map([...(parent?.bindings() ?? []), ...Object.entries(bindings)]));
  return storage.run(scope, async () => {
    try {
      const value = await fn();
      await scope.drain();
      return value;
    } catch (err) {
      await scope.drain().catch(() => undefined);
      throw err;
    }
  });
}

export function currentScope(): Scope | undefined {
  return storage.getStore();
}

// Called by generated wiring after a trigger action returns: sync work runs
// once the action settles (and only if it succeeded), inside the scope.
export function afterAction<R>(result: R, sync: string, run: (settled: Awaited<R>, scope: Scope) => Promise<void>): R {
  const scope = storage.getStore();
  if (scope === undefined) {
    throw new Error(`sync ${sync} fired outside withScope`);
  }
  scope.defer(
    Promise.resolve(result).then(
      (settled) => run(settled, scope),
      () => undefined,
    ),
  );
  return result;
}
```

Add to `packages/runtime/src/index.ts`:
```ts
export { Scope, SyncTargetMissing, afterAction, currentScope, withScope } from './scope.js';
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/runtime exec vitest run scope` (expected: PASS, with no unhandled-rejection warnings in the output), then `pnpm verify` (expected: all green).
```bash
git add packages/runtime
git commit -m "Add scopes that bind sync targets and drain deferred sync work"
```

---

### Task 4: Connect the CLI to the runtime

**Files:**
- Create: `packages/cli/src/runtimepkg.ts`
- Modify: `packages/cli/package.json`, `packages/cli/src/versions.ts`, `packages/cli/src/interfaces.ts`, `packages/cli/src/typecheck.ts`, `packages/cli/test/helpers.ts`, `packages/cli/test/pipeline-fixture.ts`, `packages/cli/test/versions.test.ts`
- Test: `packages/cli/test/runtimepkg.test.ts`; new cases in `packages/cli/test/interfaces.test.ts` and `packages/cli/test/typecheck.test.ts`

**Interfaces:**
- Consumes: `@ccc/runtime` (Tasks 1–3).
- Produces:
  - `runtimepkg.ts`: `RUNTIME_PACKAGE = '@ccc/runtime'`; `runtimeDir(): string`; `runtimeVersion(): Promise<string>`; `runtimeTypePaths(): Record<string, string[]>` (tsconfig `paths` for `@ccc/runtime` and `@ccc/runtime/pglite`)
  - `versions.ts`: `RUNTIME_VERSION` is removed; `loadVersions` reads `runtimeVersion()`
  - `interfaces.ts`: `interfaceProblems` accepts `import type { ... } from '@ccc/runtime'`
  - `typecheck.ts`: interface type-checking resolves `@ccc/runtime` through `paths`
  - test `helpers.ts`: `linkPackages(root: string, names: readonly string[]): Promise<void>` (symlinks the CLI's installed packages into `root/node_modules`)
  - `createPipelineProject()` links `@ccc/runtime`

- [ ] **Step 1: Add dependencies**

Run:
```bash
pnpm --filter @ccc/cli add @ccc/runtime@workspace:* pg@^8.23.0
pnpm --filter @ccc/cli add -D @types/pg@^8.23.1 hono@^4.13.9
```
Expected: `packages/cli/package.json` lists `@ccc/runtime` (`workspace:*`) and `pg` under dependencies, and `@types/pg` and `hono` under devDependencies.

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/runtimepkg.test.ts`:
```ts
import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runtimeDir, runtimeTypePaths, runtimeVersion } from '../src/runtimepkg.js';

describe('runtime package', () => {
  it('locates the runtime and its version', async () => {
    expect(await runtimeVersion()).toBe('0.1.0');
    await access(runtimeDir());
  });

  it('maps runtime imports to built declarations', async () => {
    const paths = runtimeTypePaths();
    expect(Object.keys(paths)).toEqual(['@ccc/runtime', '@ccc/runtime/pglite']);
    await access(paths['@ccc/runtime']?.[0] ?? '');
  });
});
```

In `packages/cli/test/versions.test.ts`, replace the import of `RUNTIME_VERSION` with `import { runtimeVersion } from '../src/runtimepkg.js';`, import only `loadVersions, readPrompt` from `'../src/versions.js'`, and change the last assertion to:
```ts
    expect(versions.runtime).toBe(await runtimeVersion());
```

Append to the `interfaceProblems / checkInterfaces` describe block in `packages/cli/test/interfaces.test.ts`:
```ts
  it('allows type-only imports from @ccc/runtime and nothing else', () => {
    expect(interfaceProblems("import type { Database } from '@ccc/runtime';\nexport class S {\n  constructor(db: Database);\n}")).toEqual([]);
    expect(interfaceProblems("import { Database } from '@ccc/runtime';\nexport class S {}")).toEqual([
      'interface line 1: interfaces cannot import modules; list the concept in uses instead',
    ]);
    expect(interfaceProblems("import type { X } from 'pg';\nexport class S {}")).toEqual([
      'interface line 1: interfaces cannot import modules; list the concept in uses instead',
    ]);
  });
```

Append to the `typecheckInterfaces (runs TypeScript 7)` describe block in `packages/cli/test/typecheck.test.ts`:
```ts
  it('resolves runtime types in interfaces', async () => {
    const files = emit({
      'store.md': concept(
        "kind: value\ninterface: |\n  import type { Database } from '@ccc/runtime';\n  export class Store {\n    constructor(db: Database);\n  }",
      ),
    });
    expect(await typecheckInterfaces(files)).toEqual([]);
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm build && pnpm --filter @ccc/cli exec vitest run runtimepkg versions interfaces typecheck`
Expected: FAIL. `runtimepkg.js` is not found, the runtime import is rejected, and `Cannot find module '@ccc/runtime'` appears in typecheck.

- [ ] **Step 4: Implement**

`packages/cli/src/runtimepkg.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';

export const RUNTIME_PACKAGE = '@ccc/runtime';

const requireFromHere = createRequire(import.meta.url);
const packageJson = z.object({ version: z.string() });

export function runtimeDir(): string {
  return path.dirname(requireFromHere.resolve(`${RUNTIME_PACKAGE}/package.json`));
}

export async function runtimeVersion(): Promise<string> {
  const text = await readFile(path.join(runtimeDir(), 'package.json'), 'utf8');
  return packageJson.parse(JSON.parse(text)).version;
}

// Lets `ccc check` type-check interfaces that mention runtime types even in
// projects that haven't installed @ccc/runtime yet.
export function runtimeTypePaths(): Record<string, string[]> {
  const dir = runtimeDir();
  return {
    [RUNTIME_PACKAGE]: [path.join(dir, 'dist', 'index.d.ts')],
    [`${RUNTIME_PACKAGE}/pglite`]: [path.join(dir, 'dist', 'pglite.d.ts')],
  };
}
```

In `packages/cli/src/versions.ts`: delete the `RUNTIME_VERSION` constant and its comment, add `import { runtimeVersion } from './runtimepkg.js';`, and in `loadVersions` replace `runtime: RUNTIME_VERSION` with `runtime: await runtimeVersion()`.

In `packages/cli/src/interfaces.ts`, add `import { RUNTIME_PACKAGE } from './runtimepkg.js';` and replace the import branch of `interfaceProblems`:
```ts
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      problems.push(`interface line ${line}: interfaces cannot import modules; list the concept in uses instead`);
    }
```
with:
```ts
    const runtimeTypeImport =
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === RUNTIME_PACKAGE &&
      statement.importClause?.isTypeOnly === true;
    if ((ts.isImportDeclaration(statement) && !runtimeTypeImport) || ts.isImportEqualsDeclaration(statement)) {
      problems.push(`interface line ${line}: interfaces cannot import modules; list the concept in uses instead`);
    }
```
(Keep the `else if` chain intact: the module-declaration check stays in an `else if` after this `if`.)

In `packages/cli/src/typecheck.ts`, add `import { runtimeTypePaths } from './runtimepkg.js';` and write the tsconfig with runtime paths:
```ts
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      `${JSON.stringify({ ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, paths: runtimeTypePaths() } }, null, 2)}\n`,
    );
```

In `packages/cli/test/helpers.ts`, add `symlink` to the existing `node:fs/promises` import, add `import { createRequire } from 'node:module';`, and add:
```ts
const requireFromTests = createRequire(import.meta.url);

// Generated code in temp projects imports packages (the runtime, hono, zod);
// link the CLI's installed copies instead of installing.
export async function linkPackages(root: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const target = path.dirname(requireFromTests.resolve(`${name}/package.json`));
    const link = path.join(root, 'node_modules', name);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, 'dir');
  }
}
```

In `packages/cli/test/pipeline-fixture.ts`, change `createPipelineProject` to:
```ts
export async function createPipelineProject(): Promise<string> {
  const root = await writeProject({ ...PIPELINE_FILES });
  await linkPackages(root, ['@ccc/runtime']);
  return root;
}
```
and import `linkPackages` from `./helpers.js`.

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm build && pnpm --filter @ccc/cli exec vitest run runtimepkg versions interfaces typecheck` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli pnpm-lock.yaml
git commit -m "Connect the CLI to @ccc/runtime: version, interface imports, type paths"
```

---

### Task 5: Adapter and sync rules in `ccc check`

**Files:**
- Create: `packages/cli/src/adapters.ts`
- Modify: `packages/cli/src/check.ts`; the Plan 1 fixture `packages/cli/test/fixtures/card-game/concepts/{auth,game-store,game-api}.md`
- Test: `packages/cli/test/adapters.test.ts`

**Interfaces:**
- Consumes: `ExportInfo` (Plan 1); `primaryClassName` (Plan 1 `syncs.ts`); `parseActionRef`, `parentOf` (Plan 1); `Concept`, `Project`.
- Produces: `RESERVED_IDS: readonly string[]` (`['main', 'schema', 'server', 'wiring']`); `storeSchemaSql(concept: Concept): string | null`; `checkAdapters(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): Diagnostic[]`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/adapters.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { checkAdapters, storeSchemaSql } from '../src/adapters.js';
import { collectExports } from '../src/interfaces.js';
import { concept, projectFrom } from './helpers.js';

const TALLY = concept('kind: aggregate\ninterface: |\n  export class Tally {\n    add(amount: number): void;\n  }');
const storeBody = (sql: string) => `## Intent\nx\n\n## Schema\n${sql}\n\n## Examples\n- a\n`;
const STORE = concept(
  "kind: store\npersists: tally\ninterface: |\n  import type { Database } from '@ccc/runtime';\n  export class TallyStore {\n    constructor(db: Database);\n  }",
  storeBody('```sql\ncreate table tallies (id text primary key);\n```'),
);

function messages(files: Record<string, string>): string[] {
  const project = projectFrom(files);
  return checkAdapters(project, collectExports(project)).map((d) => `${d.file}: ${d.message}`);
}

describe('storeSchemaSql', () => {
  it('extracts the sql block', () => {
    const project = projectFrom({ 'tally.md': TALLY, 'tally-store.md': STORE });
    const store = project.concepts.get('tally-store');
    if (store === undefined) throw new Error('fixture');
    expect(storeSchemaSql(store)).toBe('create table tallies (id text primary key);');
  });
});

describe('checkAdapters', () => {
  it('accepts conventional adapters and syncs', () => {
    expect(
      messages({
        'tally.md': TALLY,
        'tally-store.md': STORE,
        'auth.md': concept(
          "kind: auth\ninterface: |\n  import type { Database } from '@ccc/runtime';\n  export class Auth {\n    constructor(db: Database);\n    authenticate(request: Request): Promise<string | null>;\n  }",
        ),
        'tally-api.md': concept(
          'kind: endpoint\ninterface: |\n  export function createHandler(deps: object): (request: Request) => Promise<Response>;',
        ),
        'log-adds.md': concept('kind: sync\nwhen: tally#add\nthen: [tally-store#save]'),
      }),
    ).toEqual([]);
  });

  it('reports reserved names, missing schema, missing classes, and missing handlers', () => {
    const found = messages({
      'tally.md': TALLY,
      'server.md': concept('kind: value\ninterface: export type S = string;'),
      'tally-store.md': concept(
        'kind: store\npersists: tally\ninterface: export class Wrong {}',
        storeBody('create table tallies (id text);'),
      ),
      'auth.md': concept('kind: auth\ninterface: |\n  export class Auth {\n    login(): void;\n  }'),
      'tally-api.md': concept('kind: endpoint\ninterface: |\n  export function handle(r: Request): Promise<Response>;'),
    });
    expect(found).toEqual([
      "concepts/server.md: 'server' is reserved for generated files; rename the concept",
      'concepts/tally-store.md: ## Schema must contain a ```sql code block with the table definitions',
      'concepts/tally-store.md: store interface must export class TallyStore (constructor(db: Database))',
      'concepts/auth.md: auth interface must export class Auth with an authenticate(request) method',
      'concepts/tally-api.md: endpoint interface must export function createHandler(deps)',
    ]);
  });

  it('requires sync triggers to be methods', () => {
    expect(
      messages({
        'card.md': concept('kind: value\ninterface: |\n  export function card(): string;\n  export function other(): string;'),
        'deal.md': concept('kind: sync\nwhen: card#card\nthen: [card#other]'),
      }),
    ).toEqual(["concepts/deal.md: card#card: sync triggers must be methods of class Card; exported functions can't be wired"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run adapters`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/adapters.ts`:
```ts
import { error, type Diagnostic } from './diagnostics.js';
import { parentOf, parseActionRef, type ConceptId } from './ids.js';
import type { ExportInfo } from './interfaces.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { primaryClassName } from './syncs.js';

// Top-level names the build writes into .ccc/gen itself.
export const RESERVED_IDS: readonly string[] = ['main', 'schema', 'server', 'wiring'];

const SQL_FENCE = /^\s*(`{3,}|~{3,})\s*sql\s*$/i;

export function storeSchemaSql(concept: Concept): string | null {
  const lines = concept.sections.get('Schema')?.lines ?? [];
  const start = lines.findIndex((line) => SQL_FENCE.test(line));
  if (start === -1) {
    return null;
  }
  const fence = SQL_FENCE.exec(lines[start] ?? '')?.[1] ?? '```';
  const end = lines.findIndex((line, index) => index > start && line.trim() === fence);
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

function hasClass(info: ExportInfo | undefined, id: ConceptId, method?: string): boolean {
  const methods = info?.classMethods.get(primaryClassName(id));
  return methods !== undefined && (method === undefined || methods.includes(method));
}

export function checkAdapters(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const concept of project.concepts.values()) {
    const fm = concept.frontmatter;
    const info = exportsByConcept.get(concept.id);
    const cls = primaryClassName(concept.id);
    if (parentOf(concept.id) === null && RESERVED_IDS.includes(concept.id)) {
      diagnostics.push(error(concept.file, `'${concept.id}' is reserved for generated files; rename the concept`, { line: 1 }));
    }
    if (fm.kind === 'store') {
      if (storeSchemaSql(concept) === null) {
        diagnostics.push(error(concept.file, '## Schema must contain a ```sql code block with the table definitions', { line: 1 }));
      }
      if (!hasClass(info, concept.id)) {
        diagnostics.push(error(concept.file, `store interface must export class ${cls} (constructor(db: Database))`, { line: 1 }));
      }
    } else if (fm.kind === 'auth' && !hasClass(info, concept.id, 'authenticate')) {
      diagnostics.push(
        error(concept.file, `auth interface must export class ${cls} with an authenticate(request) method`, { line: 1 }),
      );
    } else if (fm.kind === 'endpoint' && !(info?.functions.includes('createHandler') ?? false)) {
      diagnostics.push(error(concept.file, 'endpoint interface must export function createHandler(deps)', { line: 1 }));
    } else if (fm.kind === 'sync') {
      const when = parseActionRef(fm.when);
      const whenInfo = exportsByConcept.get(when.conceptId);
      if (whenInfo?.functions.includes(when.member) === true) {
        diagnostics.push(
          error(
            concept.file,
            `${fm.when}: sync triggers must be methods of class ${primaryClassName(when.conceptId)}; exported functions can't be wired`,
            { line: 1 },
          ),
        );
      }
    }
  }
  return diagnostics;
}
```

In `packages/cli/src/check.ts`, add `import { checkAdapters } from './adapters.js';` and extend the sync line:
```ts
  diagnostics.push(
    ...checkSyncActions(project, exportsByConcept),
    ...checkSyncCycles(project),
    ...checkAdapters(project, exportsByConcept),
  );
```

- [ ] **Step 4: Update the Plan 1 fixture to the adapter conventions**

`packages/cli/test/fixtures/card-game/concepts/auth.md`, replacing the frontmatter:
```markdown
---
kind: auth
uses: [user]
interface: |
  import type { Database } from '@ccc/runtime';
  export interface Identity {
    readonly userId: UserId;
  }
  export class Auth {
    constructor(db: Database);
    authenticate(request: Request): Promise<Identity | null>;
  }
---
```

`packages/cli/test/fixtures/card-game/concepts/game-store.md`, replacing the frontmatter:
```markdown
---
kind: store
persists: game
interface: |
  import type { Database } from '@ccc/runtime';
  export class GameStore {
    constructor(db: Database);
    load(id: string): Promise<Game | null>;
    save(game: Game): Promise<void>;
  }
---
```

`packages/cli/test/fixtures/card-game/concepts/game-api.md`, replacing the frontmatter:
```markdown
---
kind: endpoint
uses: [game, game-store, auth]
interface: |
  import type { Database } from '@ccc/runtime';
  export interface GameApiDeps {
    readonly db: Database;
    readonly gameStore: GameStore;
    readonly auth: Auth;
  }
  export function createHandler(deps: GameApiDeps): (request: Request) => Promise<Response>;
---
```

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run adapters check cli` (expected: PASS; the card-game fixture still checks clean with 11 concepts), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/adapters.ts packages/cli/src/check.ts packages/cli/test/adapters.test.ts packages/cli/test/fixtures
git commit -m "Check adapter conventions, reserved names, and method-only sync triggers"
```

---

### Task 6: Build order and schema outputs

**Files:**
- Create: `packages/cli/src/order.ts`
- Modify: `packages/cli/src/build.ts` (import and re-export from `order.ts`), `packages/cli/src/adapters.ts` (add `combinedSchema`)
- Test: `packages/cli/test/order.test.ts`; add a case to `packages/cli/test/adapters.test.ts`

**Interfaces:**
- Produces: `order.ts`: `topologicalLevels(project): ConceptId[][]` (endpoints always in the final level, after every other concept), `dependencyClosure(project, id): Set<ConceptId>` (moved from `build.ts`, which re-exports both). `adapters.ts`: `combinedSchema(project: Project): string` (every store's SQL in topological order, each preceded by `-- <store id>`; `''` when there are no stores).

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/order.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dependencyClosure, topologicalLevels } from '../src/order.js';
import { concept, projectFrom } from './helpers.js';

describe('topologicalLevels', () => {
  it('puts endpoints after every other concept', () => {
    const project = projectFrom({
      'card.md': concept('kind: value\ninterface: export type Card = string;'),
      'api.md': concept(
        'kind: endpoint\nuses: [card]\ninterface: |\n  export function createHandler(deps: object): (request: Request) => Promise<Response>;',
      ),
      'hand.md': concept('kind: collection\nof: card\ninterface: export class Hand {}'),
      'deck.md': concept('kind: collection\nof: card\nuses: [hand]\ninterface: export class Deck {}'),
    });
    expect(topologicalLevels(project)).toEqual([['card'], ['hand'], ['deck'], ['api']]);
    expect([...dependencyClosure(project, 'deck')].sort()).toEqual(['card', 'deck', 'hand']);
  });
});
```

Append to `packages/cli/test/adapters.test.ts`:
```ts
import { combinedSchema } from '../src/adapters.js';

describe('combinedSchema', () => {
  it('joins store schemas in dependency order', () => {
    const project = projectFrom({
      'tally.md': TALLY,
      'tally-store.md': STORE,
      'audit.md': concept(
        'kind: store\npersists: tally\nuses: [tally-store]\ninterface: |\n  export class Audit {}',
        storeBody('```sql\ncreate table audit (n integer);\n```'),
      ),
    });
    expect(combinedSchema(project)).toBe(
      '-- tally-store\ncreate table tallies (id text primary key);\n\n-- audit\ncreate table audit (n integer);\n',
    );
    expect(combinedSchema(projectFrom({ 'tally.md': TALLY }))).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run order adapters`
Expected: FAIL. `order.js` is not found and `combinedSchema` is not exported.

- [ ] **Step 3: Implement**

`packages/cli/src/order.ts`:
```ts
import { dependenciesOf } from './graph.js';
import type { ConceptId } from './ids.js';
import type { Project } from './load.js';

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Build order: a concept's level is one more than its deepest dependency.
// Endpoints go last, because their tests run the whole app (wiring and
// every adapter) through createApp.
export function topologicalLevels(project: Project): ConceptId[][] {
  const level = new Map<ConceptId, number>();
  const visit = (id: ConceptId): number => {
    const known = level.get(id);
    if (known !== undefined) {
      return known;
    }
    const concept = project.concepts.get(id);
    if (concept === undefined) {
      return -1;
    }
    level.set(id, 0);
    const value = Math.max(-1, ...dependenciesOf(concept, project).map(visit)) + 1;
    level.set(id, value);
    return value;
  };
  for (const id of project.concepts.keys()) {
    visit(id);
  }
  const isEndpoint = (id: ConceptId): boolean => project.concepts.get(id)?.frontmatter.kind === 'endpoint';
  const lastOther = Math.max(-1, ...[...level].filter(([id]) => !isEndpoint(id)).map(([, value]) => value));
  for (const [id, value] of level) {
    if (isEndpoint(id)) {
      level.set(id, Math.max(value, lastOther + 1));
    }
  }
  const levels: ConceptId[][] = [];
  for (const [id, value] of [...level].sort(([a], [b]) => compareIds(a, b))) {
    (levels[value] ??= []).push(id);
  }
  return levels.filter((ids) => ids !== undefined);
}

export function dependencyClosure(project: Project, id: ConceptId): Set<ConceptId> {
  const seen = new Set<ConceptId>();
  const queue = [id];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined || seen.has(next)) {
      continue;
    }
    seen.add(next);
    const concept = project.concepts.get(next);
    if (concept !== undefined) {
      queue.push(...dependenciesOf(concept, project));
    }
  }
  return seen;
}
```

In `packages/cli/src/build.ts`: delete the `topologicalLevels` and `dependencyClosure` function definitions, add `import { dependencyClosure, topologicalLevels } from './order.js';`, and add `export { dependencyClosure, topologicalLevels } from './order.js';`.

Append to `packages/cli/src/adapters.ts` (and add `import { topologicalLevels } from './order.js';`):
```ts
export function combinedSchema(project: Project): string {
  const parts: string[] = [];
  for (const id of topologicalLevels(project).flat()) {
    const concept = project.concepts.get(id);
    const sql = concept?.frontmatter.kind === 'store' ? storeSchemaSql(concept) : null;
    if (sql !== null) {
      parts.push(`-- ${id}\n${sql}\n`);
    }
  }
  return parts.join('\n');
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run order adapters build` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/order.ts packages/cli/src/build.ts packages/cli/src/adapters.ts packages/cli/test/order.test.ts packages/cli/test/adapters.test.ts
git commit -m "Build endpoints last and combine store schemas"
```

---

### Task 7: Wiring, composition root, and entry point sources

**Files:**
- Create: `packages/cli/src/compose.ts`
- Test: `packages/cli/test/compose.test.ts`

**Interfaces:**
- Consumes: `ExportInfo` (Plan 1); `parseActionRef` (Plan 1); `primaryClassName` (Plan 1); `targetKey` (Plan 2 `synciface.ts`); `combinedSchema` (Task 6); `Project`.
- Produces: `WIRING_FILE = '.ccc/gen/wiring.ts'`, `SERVER_FILE = '.ccc/gen/server.ts'`, `MAIN_FILE = '.ccc/gen/main.ts'`, `SCHEMA_SQL_FILE = '.ccc/gen/schema.sql'`, `SCHEMA_TS_FILE = '.ccc/gen/schema.ts'`; `SCHEMA_DECLARATION`, `SERVER_DECLARATION` (declaration-file text used when type-checking tests against interfaces); `wiringSource(project, exportsByConcept): string`; `serverSource(project): string`; `MAIN_SOURCE: string`; `schemaModuleSource(sql: string): string`; `compositionFiles(project, exportsByConcept): [string, string][]` (all five paths with contents)

- [ ] **Step 1: Write the failing test**

`packages/cli/test/compose.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { compositionFiles, schemaModuleSource, serverSource, wiringSource } from '../src/compose.js';
import { collectExports } from '../src/interfaces.js';
import { concept, projectFrom } from './helpers.js';

const TALLY = concept('kind: aggregate\ninterface: |\n  export class Tally {\n    add(amount: number): void;\n  }');
const STORE = (name: string) =>
  concept(
    `kind: store\npersists: tally\ninterface: |\n  import type { Database } from '@ccc/runtime';\n  export class ${name} {\n    constructor(db: Database);\n    record(n: number): Promise<void>;\n  }`,
    '## Intent\nx\n\n## Schema\n```sql\ncreate table t (n integer);\n```\n\n## Examples\n- a\n',
  );
const API = concept('kind: endpoint\ninterface: |\n  export function createHandler(deps: object): (request: Request) => Promise<Response>;');

const files = {
  'tally.md': TALLY,
  'tally-audit.md': STORE('TallyAudit'),
  'tally-api.md': API,
  'audit-adds.md': concept('kind: sync\nwhen: tally#add\nthen: [tally-audit#record]'),
  'z-count.md': concept('kind: sync\nwhen: tally#add\nthen: [tally#add]'),
};

describe('wiringSource', () => {
  it('patches trigger methods, one block per sync in id order', () => {
    const project = projectFrom({ ...files, 'z-count.md': concept('kind: sync\nwhen: tally#add\nthen: [tally-audit#record]') });
    expect(wiringSource(project, collectExports(project))).toBe(
      [
        '// @generated by ccc. Do not edit.',
        "import { afterAction } from '@ccc/runtime';",
        "import * as m0 from './tally.js';",
        "import * as m1 from './audit-adds.js';",
        "import * as m2 from './tally-audit.js';",
        "import * as m3 from './z-count.js';",
        '',
        '{',
        '  const original = m0.Tally.prototype.add;',
        "  m0.Tally.prototype.add = function (this: m0.Tally, ...args: Parameters<m0.Tally['add']>): ReturnType<m0.Tally['add']> {",
        '    const result = original.apply(this, args);',
        "    return afterAction(result, 'audit-adds', async (settled, scope) => {",
        "      await m1.handle({ target: this, args, result: settled }, { tallyAudit: scope.resolve<m2.TallyAudit>('tally-audit', 'audit-adds') });",
        '    });',
        '  };',
        '}',
        '',
        '{',
        '  const original = m0.Tally.prototype.add;',
        "  m0.Tally.prototype.add = function (this: m0.Tally, ...args: Parameters<m0.Tally['add']>): ReturnType<m0.Tally['add']> {",
        '    const result = original.apply(this, args);',
        "    return afterAction(result, 'z-count', async (settled, scope) => {",
        "      await m3.handle({ target: this, args, result: settled }, { tallyAudit: scope.resolve<m2.TallyAudit>('tally-audit', 'z-count') });",
        '    });',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('is an empty module without syncs', () => {
    const project = projectFrom({ 'tally.md': TALLY });
    expect(wiringSource(project, collectExports(project))).toBe('// @generated by ccc. Do not edit.\nexport {};\n');
  });
});

describe('serverSource', () => {
  it('builds adapters, binds them, and loads endpoints lazily', () => {
    const source = serverSource(projectFrom(files));
    expect(source).toContain("import './wiring.js';");
    expect(source).toContain("import * as a0 from './tally-audit.js';");
    expect(source).toContain('    tallyAudit: new a0.TallyAudit(db),');
    expect(source).toContain("    'tally-audit': container.tallyAudit,");
    expect(source).toContain("    'tally-api': async () => (await import('./tally-api.js')).createHandler(container),");
    expect(source).toContain('const response = await handler(request.clone());');
  });
});

describe('compositionFiles', () => {
  it('lists every generated composition file', () => {
    const project = projectFrom(files);
    const written = compositionFiles(project, collectExports(project));
    expect(written.map(([file]) => file)).toEqual([
      '.ccc/gen/wiring.ts',
      '.ccc/gen/server.ts',
      '.ccc/gen/main.ts',
      '.ccc/gen/schema.sql',
      '.ccc/gen/schema.ts',
    ]);
    expect(written[4]?.[1]).toBe(schemaModuleSource('-- tally-audit\ncreate table t (n integer);\n'));
    expect(schemaModuleSource('x')).toBe('// @generated by ccc. Do not edit.\nexport const schemaSql = "x";\n');
  });
});
```

The fixture's `z-count` sync is invalid (`then: [tally#add]` would cycle), so the wiring test overrides it with a valid second sync on the same trigger.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run compose`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/compose.ts`:
```ts
import { combinedSchema } from './adapters.js';
import { parseActionRef, type ConceptId } from './ids.js';
import type { ExportInfo } from './interfaces.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { targetKey } from './synciface.js';
import { primaryClassName } from './syncs.js';

export const WIRING_FILE = '.ccc/gen/wiring.ts';
export const SERVER_FILE = '.ccc/gen/server.ts';
export const MAIN_FILE = '.ccc/gen/main.ts';
export const SCHEMA_SQL_FILE = '.ccc/gen/schema.sql';
export const SCHEMA_TS_FILE = '.ccc/gen/schema.ts';

const HEADER = '// @generated by ccc. Do not edit.';

// Declarations that stand in for the generated schema and server modules
// when tests are type-checked against interfaces only.
export const SCHEMA_DECLARATION = 'export declare const schemaSql: string;\n';
export const SERVER_DECLARATION = [
  "import type { Database } from '@ccc/runtime';",
  'export type Handler = (request: Request) => Promise<Response>;',
  'export interface AppOptions {',
  '  readonly endpoints?: readonly string[];',
  '}',
  'export declare function createApp(db: Database, options?: AppOptions): Promise<Handler>;',
  '',
].join('\n');

function modulePathFromGen(id: ConceptId): string {
  return `./${id.split('.').join('/')}.js`;
}

function byId(a: Concept, b: Concept): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Each sync patches its trigger's prototype method: the original runs, then
// the handler is deferred into the current scope with its targets resolved
// (instances from the scope, function-action modules as namespaces).
export function wiringSource(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): string {
  const syncs = [...project.concepts.values()].filter((c) => c.frontmatter.kind === 'sync').sort(byId);
  if (syncs.length === 0) {
    return `${HEADER}\nexport {};\n`;
  }
  const aliases = new Map<ConceptId, string>();
  const alias = (id: ConceptId): string => {
    const known = aliases.get(id);
    if (known !== undefined) {
      return known;
    }
    const created = `m${aliases.size}`;
    aliases.set(id, created);
    return created;
  };
  const blocks: string[] = [];
  for (const sync of syncs) {
    const fm = sync.frontmatter;
    if (fm.kind !== 'sync') {
      continue;
    }
    const when = parseActionRef(fm.when);
    const trigger = `${alias(when.conceptId)}.${primaryClassName(when.conceptId)}`;
    const handler = alias(sync.id);
    const actionsByTarget = new Map<ConceptId, string[]>();
    for (const ref of fm.then) {
      const { conceptId, member } = parseActionRef(ref);
      actionsByTarget.set(conceptId, [...(actionsByTarget.get(conceptId) ?? []), member]);
    }
    const targets = [...actionsByTarget].map(([conceptId, members]) => {
      const info = exportsByConcept.get(conceptId);
      const key = targetKey(conceptId);
      if (members.every((member) => !(info?.functions.includes(member) ?? false))) {
        return `${key}: scope.resolve<${alias(conceptId)}.${primaryClassName(conceptId)}>('${conceptId}', '${sync.id}')`;
      }
      return `${key}: ${alias(conceptId)}`;
    });
    blocks.push(
      [
        '{',
        `  const original = ${trigger}.prototype.${when.member};`,
        `  ${trigger}.prototype.${when.member} = function (this: ${trigger}, ...args: Parameters<${trigger}['${when.member}']>): ReturnType<${trigger}['${when.member}']> {`,
        '    const result = original.apply(this, args);',
        `    return afterAction(result, '${sync.id}', async (settled, scope) => {`,
        `      await ${handler}.handle({ target: this, args, result: settled }, { ${targets.join(', ')} });`,
        '    });',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
  }
  const imports = [...aliases].map(([id, name]) => `import * as ${name} from '${modulePathFromGen(id)}';`);
  return [HEADER, "import { afterAction } from '@ccc/runtime';", ...imports, '', ...blocks].join('\n');
}

export function serverSource(project: Project): string {
  const concepts = [...project.concepts.values()].sort(byId);
  const adapters = concepts.filter((c) => c.frontmatter.kind === 'store' || c.frontmatter.kind === 'auth');
  const endpoints = concepts.filter((c) => c.frontmatter.kind === 'endpoint');
  return [
    HEADER,
    "import { isUnmatched, withScope, type Database } from '@ccc/runtime';",
    "import './wiring.js';",
    ...adapters.map((c, index) => `import * as a${index} from '${modulePathFromGen(c.id)}';`),
    '',
    'export type Handler = (request: Request) => Promise<Response>;',
    '',
    'export interface AppOptions {',
    '  readonly endpoints?: readonly string[];',
    '}',
    '',
    'export async function createApp(db: Database, options: AppOptions = {}): Promise<Handler> {',
    '  const container = {',
    '    db,',
    ...adapters.map((c, index) => `    ${targetKey(c.id)}: new a${index}.${primaryClassName(c.id)}(db),`),
    '  };',
    '  const singletons = {',
    ...adapters.map((c) => `    '${c.id}': container.${targetKey(c.id)},`),
    '  };',
    '  const loaders: Record<string, () => Promise<Handler>> = {',
    ...endpoints.map(
      (c) => `    '${c.id}': async () => (await import('${modulePathFromGen(c.id)}')).createHandler(container),`,
    ),
    '  };',
    '  const handlers: Handler[] = [];',
    '  for (const [id, load] of Object.entries(loaders)) {',
    '    if (options.endpoints === undefined || options.endpoints.includes(id)) {',
    '      handlers.push(await load());',
    '    }',
    '  }',
    '  return async (request) =>',
    '    withScope(singletons, async () => {',
    '      for (const handler of handlers) {',
    '        const response = await handler(request.clone());',
    '        if (!isUnmatched(response)) {',
    '          return response;',
    '        }',
    '      }',
    "      return new Response('Not Found', { status: 404 });",
    '    });',
    '}',
    '',
  ].join('\n');
}

export const MAIN_SOURCE = [
  HEADER,
  "import { serve } from '@hono/node-server';",
  "import { pgDatabase } from '@ccc/runtime';",
  "import pg from 'pg';",
  "import { createApp } from './server.js';",
  '',
  'const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });',
  "serve({ fetch: await createApp(pgDatabase(pool)), port: Number(process.env.PORT ?? '3000') });",
  '',
].join('\n');

export function schemaModuleSource(sql: string): string {
  return `${HEADER}\nexport const schemaSql = ${JSON.stringify(sql)};\n`;
}

export function compositionFiles(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): [string, string][] {
  const sql = combinedSchema(project);
  return [
    [WIRING_FILE, wiringSource(project, exportsByConcept)],
    [SERVER_FILE, serverSource(project)],
    [MAIN_FILE, MAIN_SOURCE],
    [SCHEMA_SQL_FILE, sql],
    [SCHEMA_TS_FILE, schemaModuleSource(sql)],
  ];
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run compose` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/compose.ts packages/cli/test/compose.test.ts
git commit -m "Generate sync wiring, the composition root, the entry point, and schema modules"
```

---

### Task 8: Adapter-aware prompts, requests, and test imports

**Files:**
- Modify: `packages/cli/prompts/impl.md`, `packages/cli/prompts/tests.md`, `packages/cli/src/context.ts`, `packages/cli/src/imports.ts`, `packages/cli/src/testgen.ts`
- Test: new cases in `packages/cli/test/context.test.ts`, `packages/cli/test/imports.test.ts`

**Interfaces:**
- Consumes: `SCHEMA_DECLARATION`, `SERVER_DECLARATION` (Task 7); `transitiveDependencies` (Plan 2); `isAdapterKind` (Plan 1).
- Produces:
  - `imports.ts`: `testImportsFor` also allows the schema module (`relativeImport(id, 'schema')`) for every concept, and the server module (`relativeImport(id, 'server')`) for endpoints. `TEST_PACKAGES` is unchanged (`@ccc/runtime` covers `@ccc/runtime/pglite`).
  - `context.ts`: `testRequest` adds a `## Test support` section for adapters, and for any concept whose transitive dependencies include an adapter. `implRequest` adds `## Syncs that may fire` for endpoints (syncs whose trigger concept is in the endpoint's transitive dependencies, with the concept ids they resolve from scope).
  - `testgen.ts`: scratch type-checking also writes `schema.d.ts` and `server.d.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/imports.test.ts`:
```ts
describe('adapter test imports', () => {
  it('allows the schema module everywhere and the server module for endpoints', () => {
    const project = projectFrom({
      'tally.md': concept('kind: aggregate\ninterface: |\n  export class Tally {\n    add(n: number): void;\n  }'),
      'game.md': concept('kind: aggregate\ninterface: export class Game {}'),
      'game/api.md': concept(
        'kind: endpoint\nuses: [tally]\ninterface: |\n  export function createHandler(deps: object): (request: Request) => Promise<Response>;',
      ),
    });
    const tally = project.concepts.get('tally');
    const api = project.concepts.get('game.api');
    if (tally === undefined || api === undefined) throw new Error('fixture');
    expect([...testImportsFor(tally, project)].sort()).toEqual(['./schema.js', './tally.js']);
    expect([...testImportsFor(api, project)].sort()).toEqual(['../schema.js', '../server.js', '../tally.js', './api.js']);
  });
});
```

Append to `packages/cli/test/context.test.ts`:
```ts
describe('adapter requests', () => {
  const adapterProject = projectFrom({
    'tally.md': concept('kind: aggregate\ninterface: |\n  export class Tally {\n    add(n: number): void;\n  }'),
    'tally-store.md': concept(
      "kind: store\npersists: tally\ninterface: |\n  import type { Database } from '@ccc/runtime';\n  export class TallyStore {\n    constructor(db: Database);\n    save(t: Tally): Promise<void>;\n  }",
      '## Intent\nx\n\n## Schema\n```sql\ncreate table t (n integer);\n```\n\n## Examples\n- a\n',
    ),
    'notify.md': concept('kind: sync\nwhen: tally#add\nthen: [tally-store#save, tally#add]'),
    'api.md': concept(
      'kind: endpoint\nuses: [tally, tally-store]\ninterface: |\n  export function createHandler(deps: object): (request: Request) => Promise<Response>;',
    ),
  });
  const adapterExports = collectExports(adapterProject);
  const get = (id: string) => {
    const found = adapterProject.concepts.get(id);
    if (found === undefined) throw new Error('fixture');
    return found;
  };

  it('tells store and endpoint test writers how to get a database and an app', () => {
    const storeRequest = testRequest(get('tally-store'), adapterProject, adapterExports, ['tally']);
    expect(storeRequest).toContain("## Test support\nCreate a database with `pgliteDatabase()` from '@ccc/runtime/pglite', then run `await db.exec(schemaSql)` with `schemaSql` from './schema.js'.");
    expect(storeRequest).not.toContain('createApp');
    const apiRequest = testRequest(get('api'), adapterProject, adapterExports, ['tally', 'tally-store']);
    expect(apiRequest).toContain("Build the app with `const app = await createApp(db, { endpoints: ['api'] })` from './server.js'");
    const plain = testRequest(get('tally'), adapterProject, adapterExports, []);
    expect(plain).not.toContain('## Test support');
  });

  it('lists syncs an endpoint may trigger and what they need in scope', () => {
    const request = implRequest(get('api'), adapterProject, adapterExports, '');
    expect(request).toContain('## Syncs that may fire\n- notify: after tally#add; bind in scope: tally');
  });
});
```

This fixture's `notify` sync lists `tally#add` in its own `then` (a cycle). That is fine here because the request builder doesn't run `ccc check`; it exercises one adapter target and one domain target.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run imports context`
Expected: FAIL. The schema/server imports are missing and the sections are absent.

- [ ] **Step 3: Update the prompts**

Append to `packages/cli/prompts/impl.md`:
```markdown

Adapters (store, auth, endpoint):
- Import `Database` and helpers from '@ccc/runtime'. Store and auth classes receive `db: Database` in their constructor. Use parameterized SQL (`$1`, `$2`) against the tables in the concept's Schema section. Describe row shapes with type aliases and convert rows into domain objects explicitly.
- An endpoint's `createHandler(deps)` builds its routes with Hono (`import { Hono } from 'hono'`) and returns `(request) => app.fetch(request)`. Register `app.notFound(() => unmatched())` so other endpoints can handle routes this one doesn't own. Validate request bodies with zod. Answer DomainError subclasses with `errorResponse(err)`, and translate the concept's own error classes into the statuses its Examples give.
- Wrap domain actions that may trigger syncs in `await withScope({ '<concept id>': instance }, async () => { ... })`, binding each aggregate the listed syncs need.
```

Append to `packages/cli/prompts/tests.md`:
```markdown

Adapters: follow the request's Test support section exactly. Every test creates its own fresh database.
```

- [ ] **Step 4: Implement the request and import changes**

In `packages/cli/src/imports.ts`, change `testImportsFor` to:
```ts
export function testImportsFor(concept: Concept, project: Project): Set<string> {
  const allowed = new Set([
    ownModuleSpecifier(concept.id),
    relativeImport(concept.id, 'schema'),
    ...transitiveDependencies(concept, project).map((id) => relativeImport(concept.id, id)),
  ]);
  if (concept.frontmatter.kind === 'endpoint') {
    allowed.add(relativeImport(concept.id, 'server'));
  }
  return allowed;
}
```

In `packages/cli/src/context.ts`, add imports:
```ts
import { transitiveDependencies } from './imports.js';
import { isAdapterKind } from './schema.js';
import { parseActionRef } from './ids.js';
import { primaryClassName } from './syncs.js';
```
(merge `transitiveDependencies` into the existing `./imports.js` import, and `parseActionRef` into the `./ids.js` import), add these helpers:
```ts
function usesAdapters(concept: Concept, project: Project): boolean {
  return (
    isAdapterKind(concept.frontmatter.kind) ||
    transitiveDependencies(concept, project).some((id) => {
      const kind = project.concepts.get(id)?.frontmatter.kind;
      return kind !== undefined && isAdapterKind(kind);
    })
  );
}

function testSupportSection(concept: Concept, project: Project): string[] {
  if (!usesAdapters(concept, project)) {
    return [];
  }
  const lines = [
    '## Test support',
    `Create a database with \`pgliteDatabase()\` from '@ccc/runtime/pglite', then run \`await db.exec(schemaSql)\` with \`schemaSql\` from '${relativeImport(concept.id, 'schema')}'.`,
  ];
  if (concept.frontmatter.kind === 'endpoint') {
    lines.push(
      `Build the app with \`const app = await createApp(db, { endpoints: ['${concept.id}'] })\` from '${relativeImport(concept.id, 'server')}' and send requests with \`await app(new Request('http://test/<path>', { method, headers, body }))\`.`,
    );
  }
  return [...lines, ''];
}

function syncsSection(concept: Concept, project: Project, exportsByConcept: ExportsByConcept): string[] {
  if (concept.frontmatter.kind !== 'endpoint') {
    return [];
  }
  const reachable = new Set(transitiveDependencies(concept, project));
  const lines: string[] = [];
  for (const sync of [...project.concepts.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const fm = sync.frontmatter;
    if (fm.kind !== 'sync' || !reachable.has(parseActionRef(fm.when).conceptId)) {
      continue;
    }
    const scoped = [...new Set(fm.then.map((ref) => parseActionRef(ref).conceptId))].filter((id) => {
      const target = project.concepts.get(id);
      const info = exportsByConcept.get(id);
      return target !== undefined && !isAdapterKind(target.frontmatter.kind) && info?.classMethods.has(primaryClassName(id)) === true;
    });
    lines.push(`- ${sync.id}: after ${fm.when}; bind in scope: ${scoped.length === 0 ? 'nothing' : scoped.join(', ')}`);
  }
  return lines.length === 0 ? [] : ['## Syncs that may fire', ...lines, ''];
}
```
In `testRequest`, insert `...testSupportSection(concept, project),` just before `...dependencySection(...)`. In `implRequest`, insert `...syncsSection(concept, project, exportsByConcept),` just before `...dependencySection(...)`.

In `packages/cli/src/testgen.ts`, import `SCHEMA_DECLARATION, SERVER_DECLARATION` from `./compose.js`, and after the interfaces are written in `typecheckAgainstInterfaces`, add:
```ts
    await writeFile(path.join(dir, 'schema.d.ts'), SCHEMA_DECLARATION);
    await writeFile(path.join(dir, 'server.d.ts'), SERVER_DECLARATION);
```

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run imports context testgen` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/prompts packages/cli/src/context.ts packages/cli/src/imports.ts packages/cli/src/testgen.ts packages/cli/test/context.test.ts packages/cli/test/imports.test.ts
git commit -m "Teach generation about adapters: test support, sync scopes, schema and server imports"
```

---

### Task 9: Emit composition files and check them in the build

**Files:**
- Modify: `packages/cli/src/emit.ts`, `packages/cli/src/build.ts`
- Test: update `packages/cli/test/emit.test.ts`; add a case to `packages/cli/test/build.test.ts`

**Interfaces:**
- Consumes: `compositionFiles`, `WIRING_FILE`, `SERVER_FILE` (Task 7); `typecheckFiles` (Plan 2).
- Produces: `deterministicWrites` (and so `emitDeterministicFiles`) also includes the five composition files, so the build counts them as files it wrote, and `expectedFiles` includes them. After the implementation stage, and only if nothing failed, `runBuild` type-checks `wiring.ts` and `server.ts`, reporting problems as `composition: ...` errors on those files.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/emit.test.ts`, update the expected list in `'lists the files each concept owns'` to include, in sorted position, `'.ccc/gen/main.ts'`, `'.ccc/gen/schema.sql'`, `'.ccc/gen/schema.ts'`, `'.ccc/gen/server.ts'`, and `'.ccc/gen/wiring.ts'`. The full sorted list is:
```ts
    expect([...expectedFiles(project)].sort()).toEqual([
      '.ccc/.gitignore',
      '.ccc/conformance/card.ts',
      '.ccc/conformance/user.ts',
      '.ccc/gen/card.contract.d.ts',
      '.ccc/gen/card.test.ts',
      '.ccc/gen/card.ts',
      '.ccc/gen/main.ts',
      '.ccc/gen/schema.sql',
      '.ccc/gen/schema.ts',
      '.ccc/gen/server.ts',
      '.ccc/gen/user.contract.d.ts',
      '.ccc/gen/user.test.ts',
      '.ccc/gen/user.ts',
      '.ccc/gen/wiring.ts',
      '.ccc/interfaces/card.d.ts',
      '.ccc/interfaces/user.d.ts',
      '.ccc/package.json',
    ]);
```
and in `'removes files that belong to no concept and keeps expected ones'`, expect:
```ts
    expect(await listFilesUnder(root, '.ccc/gen')).toEqual([
      '.ccc/gen/card.contract.d.ts',
      '.ccc/gen/card.test.ts',
      '.ccc/gen/card.ts',
      '.ccc/gen/main.ts',
      '.ccc/gen/schema.sql',
      '.ccc/gen/schema.ts',
      '.ccc/gen/server.ts',
      '.ccc/gen/user.contract.d.ts',
      '.ccc/gen/user.ts',
      '.ccc/gen/wiring.ts',
    ]);
```

Append to the `runBuild` describe block in `packages/cli/test/build.test.ts`:
```ts
  it('emits wiring and a composition root that type-check', async () => {
    const wiring = await readFileOrNull(built, '.ccc/gen/wiring.ts');
    expect(wiring).toContain("afterAction(result, 'count-adds'");
    expect(await readFileOrNull(built, '.ccc/gen/server.ts')).toContain('export async function createApp(');
    const { manifest } = await readManifest(built);
    expect(manifest.files['.ccc/gen/wiring.ts']).toMatch(/^[0-9a-f]{64}$/);
  });
```

Task 11's adapter pipeline exercises composition end to end (endpoint deps must match the generated container, or `server.ts` fails to type-check).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run emit build`
Expected: FAIL. The composition files are missing from the expected lists, and `wiring.ts` doesn't exist.

- [ ] **Step 3: Implement**

In `packages/cli/src/emit.ts`, import `compositionFiles` from `./compose.js`, add the five paths to `expectedFiles`:
```ts
import { MAIN_FILE, SCHEMA_SQL_FILE, SCHEMA_TS_FILE, SERVER_FILE, WIRING_FILE, compositionFiles } from './compose.js';
```
```ts
  const files = new Set(['.ccc/package.json', '.ccc/.gitignore', WIRING_FILE, SERVER_FILE, MAIN_FILE, SCHEMA_SQL_FILE, SCHEMA_TS_FILE]);
```
and append the composition files to `writes` in `deterministicWrites`, just before its `return`:
```ts
  writes.push(...compositionFiles(project, exportsByConcept));
```

In `packages/cli/src/build.ts`, import `SERVER_FILE, WIRING_FILE` from `./compose.js` and `typecheckFiles` from `./toolchain.js` (merge with the existing `runTests` import). Right after the implementation-stage loop (before collecting test files), add:
```ts
    if (failed.size === 0 && skipped.size === 0) {
      const composition = new Set([WIRING_FILE, SERVER_FILE]);
      for (const issue of await typecheckFiles(root, [...composition])) {
        if (composition.has(issue.file) || issue.file === '') {
          result.diagnostics.push(
            error(issue.file || WIRING_FILE, `composition: ${issue.line === null ? '' : `line ${issue.line}: `}${issue.message}`),
          );
        }
      }
    }
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run emit build verify regen cli` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/emit.ts packages/cli/src/build.ts packages/cli/test/emit.test.ts packages/cli/test/build.test.ts
git commit -m "Emit composition files and type-check wiring and server after building"
```

---

### Task 10: `ccc db reset`

**Files:**
- Create: `packages/cli/src/dbreset.ts`
- Modify: `packages/cli/src/cli.ts`, `packages/cli/src/bin.ts`
- Test: `packages/cli/test/dbreset.test.ts`

**Interfaces:**
- Consumes: `Database`, `pgDatabase` (`@ccc/runtime`); `readFileOrNull` (Plan 2); `SCHEMA_SQL_FILE` (Task 7).
- Produces: `resetDatabase(db: Database, schema: string): Promise<void>`; `interface OpenedDatabase { db: Database; close(): Promise<void> }`; `openPgDatabase(url: string): Promise<OpenedDatabase>`. `Services` gains `openDatabase(url: string): Promise<OpenedDatabase>`, and `Io` gains an optional `env?: Readonly<Record<string, string | undefined>>`. CLI: `ccc db reset [-C dir]`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/dbreset.test.ts`:
```ts
import { pgliteDatabase } from '@ccc/runtime/pglite';
import { describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.js';
import { resetDatabase } from '../src/dbreset.js';
import { FakeGenerator } from './fake-generator.js';
import { pipelineResponder } from './pipeline-fixture.js';
import { writeProject } from './helpers.js';

const SCHEMA = 'create table tallies (id text primary key, count integer not null);\n';

describe('resetDatabase', () => {
  it('drops everything and applies the schema', async () => {
    const db = pgliteDatabase();
    await db.exec('create table leftover (x integer)');
    await resetDatabase(db, SCHEMA);
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(['tallies']);
  });
});

describe('ccc db reset', () => {
  function capture(cwd: string, env: Record<string, string | undefined>) {
    let out = '';
    const io: Io = {
      cwd,
      env,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        out += text;
      },
    };
    return { io, out: () => out };
  }

  it('resets the database named by DATABASE_URL', async () => {
    const root = await writeProject({ '.ccc/gen/schema.sql': SCHEMA });
    const db = pgliteDatabase();
    let closed = false;
    const opened: string[] = [];
    const services = {
      generator: () => new FakeGenerator(pipelineResponder()),
      openDatabase: async (url: string) => {
        opened.push(url);
        return {
          db,
          close: async () => {
            closed = true;
          },
        };
      },
    };
    const cap = capture(root, { DATABASE_URL: 'postgres://localhost/dev' });
    expect(await main(['db', 'reset'], cap.io, services)).toBe(0);
    expect(cap.out()).toBe('✓ database reset from .ccc/gen/schema.sql\n');
    expect(opened).toEqual(['postgres://localhost/dev']);
    expect(closed).toBe(true);
    expect((await db.query<{ n: number }>('select count(*)::int as n from tallies')).rows[0]?.n).toBe(0);
  });

  it('explains missing DATABASE_URL and a missing schema', async () => {
    const services = {
      generator: () => new FakeGenerator(pipelineResponder()),
      openDatabase: async () => ({ db: pgliteDatabase(), close: async () => undefined }),
    };
    const noUrl = capture(await writeProject({ '.ccc/gen/schema.sql': SCHEMA }), {});
    expect(await main(['db', 'reset'], noUrl.io, services)).toBe(1);
    expect(noUrl.out()).toBe('error: set DATABASE_URL to the database to reset\n');
    const noSchema = capture(await writeProject({}), { DATABASE_URL: 'x' });
    expect(await main(['db', 'reset'], noSchema.io, services)).toBe(1);
    expect(noSchema.out()).toBe('error: no .ccc/gen/schema.sql; run ccc build first\n');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run dbreset`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/dbreset.ts`:
```ts
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
```

In `packages/cli/src/cli.ts`:
- Add imports: `import { SCHEMA_SQL_FILE } from './compose.js';`, `import { openPgDatabase, resetDatabase, type OpenedDatabase } from './dbreset.js';`, and `import { readFileOrNull } from './fsutil.js';`.
- Add `env?: Readonly<Record<string, string | undefined>>;` to `Io`.
- Change `Services` and the defaults to:
```ts
export interface Services {
  generator(): Generator;
  openDatabase(url: string): Promise<OpenedDatabase>;
}

const defaultServices: Services = { generator: () => new AnthropicGenerator(), openDatabase: openPgDatabase };
```
- Add above `main`:
```ts
async function dbResetCommand(root: string, io: Io, services: Services): Promise<number> {
  const url = io.env?.DATABASE_URL;
  if (url === undefined || url === '') {
    io.stdout('error: set DATABASE_URL to the database to reset\n');
    return 1;
  }
  const schema = await readFileOrNull(root, SCHEMA_SQL_FILE);
  if (schema === null) {
    io.stdout(`error: no ${SCHEMA_SQL_FILE}; run ccc build first\n`);
    return 1;
  }
  const opened = await services.openDatabase(url);
  try {
    await resetDatabase(opened.db, schema);
  } finally {
    await opened.close();
  }
  io.stdout(`✓ database reset from ${SCHEMA_SQL_FILE}\n`);
  return 0;
}
```
- Register after `regen`:
```ts
  program
    .command('db')
    .description('development database commands')
    .command('reset')
    .description('drop everything in DATABASE_URL and apply .ccc/gen/schema.sql')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string }) => {
      exitCode = await dbResetCommand(rootOf(options.dir), io, services);
    });
```

Update every `Services` object in the Plan 2 CLI tests (`fakeServices` and `broken` in `cli-build.test.ts`, `services` in `cli-approve.test.ts` and `regen.test.ts`) to include `openDatabase: openPgDatabase` (import it from `../src/dbreset.js`), so they satisfy the widened `Services` interface.

In `packages/cli/src/bin.ts`, add `env: process.env,` to the `io` object.

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run dbreset cli regen` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/dbreset.ts packages/cli/src/cli.ts packages/cli/src/bin.ts packages/cli/test
git commit -m "Add ccc db reset"
```

---

### Task 11: End-to-end adapter pipeline

**Files:**
- Create: `packages/cli/test/adapter-fixture.ts`, `packages/cli/test/adapter-pipeline.test.ts`

**Interfaces:**
- Consumes: everything above; `linkPackages` (Task 4); `FakeGenerator` (Plan 2); `runBuild`, `runVerify`, `approve`, `pendingApprovals` (Plan 2).
- Produces: `ADAPTER_FILES`, `ADAPTER_TESTS`, `ADAPTER_IMPL`, `adapterResponder(): FakeResponder`, `createAdapterProject(): Promise<string>` (links `@ccc/runtime`, `hono`, `zod`).

- [ ] **Step 1: Write the fixture**

`packages/cli/test/adapter-fixture.ts`:
```ts
import type { FakeResponder } from './fake-generator.js';
import { linkPackages, writeProject } from './helpers.js';
import { artifactOf, conceptOf } from './pipeline-fixture.js';

// A tally service: an aggregate, two stores, a sync whose target is a store
// singleton, and an HTTP endpoint that binds the aggregate in scope.
export const ADAPTER_FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "type": "module" }\n',
  'concepts/tally.md': [
    '---',
    'kind: aggregate',
    'interface: |',
    '  export class InvalidAmount extends Error {}',
    '  export class Tally {',
    '    constructor(id: string);',
    '    static restore(id: string, count: number): Tally;',
    '    readonly id: string;',
    '    count(): number;',
    '    add(amount: number): void;',
    '  }',
    '---',
    '## Intent',
    'A running total.',
    '',
    '## Rules',
    '- Amounts must be positive integers.',
    '',
    '## Examples',
    '- new Tally("t").count() → 0',
    '- given a tally, add(2) then add(3) → count() is 5',
    '- add(0) → throws InvalidAmount',
    '',
  ].join('\n'),
  'concepts/tally-store.md': [
    '---',
    'kind: store',
    'persists: tally',
    'interface: |',
    "  import type { Database } from '@ccc/runtime';",
    '  export class TallyStore {',
    '    constructor(db: Database);',
    '    load(id: string): Promise<Tally | null>;',
    '    save(tally: Tally): Promise<void>;',
    '  }',
    '---',
    '## Intent',
    'Saves and loads tallies.',
    '',
    '## Schema',
    '```sql',
    'create table tallies (',
    '  id text primary key,',
    '  count integer not null',
    ');',
    '```',
    '',
    '## Examples',
    '- save(a tally with count 4) then load(its id) → a tally with count 4',
    '- load("missing") → null',
    '',
  ].join('\n'),
  'concepts/tally-audit.md': [
    '---',
    'kind: store',
    'persists: tally',
    'interface: |',
    "  import type { Database } from '@ccc/runtime';",
    '  export class TallyAudit {',
    '    constructor(db: Database);',
    '    record(tallyId: string, amount: number): Promise<void>;',
    '    entries(tallyId: string): Promise<number[]>;',
    '  }',
    '---',
    '## Intent',
    'An append-only log of amounts added to each tally.',
    '',
    '## Schema',
    '```sql',
    'create table tally_audit (',
    '  seq serial primary key,',
    '  tally_id text not null,',
    '  amount integer not null',
    ');',
    '```',
    '',
    '## Examples',
    '- record("t", 2) then record("t", 3) → entries("t") is [2, 3]',
    '- entries("none") → []',
    '',
  ].join('\n'),
  'concepts/audit-adds.md': [
    '---',
    'kind: sync',
    'when: tally#add',
    'then: [tally-audit#record]',
    '---',
    '## Intent',
    'Record every amount added to a tally.',
    '',
    '## Examples',
    '- given tally "t" and an audit log, add(2) → the audit log records 2 for "t"',
    '',
  ].join('\n'),
  'concepts/tally-api.md': [
    '---',
    'kind: endpoint',
    'uses: [tally, tally-store, tally-audit]',
    'interface: |',
    "  import type { Database } from '@ccc/runtime';",
    '  export interface TallyApiDeps {',
    '    readonly db: Database;',
    '    readonly tallyStore: TallyStore;',
    '    readonly tallyAudit: TallyAudit;',
    '  }',
    '  export function createHandler(deps: TallyApiDeps): (request: Request) => Promise<Response>;',
    '---',
    '## Intent',
    'HTTP access to tallies.',
    '',
    '## Examples',
    '- POST /tallies/t/add {"amount": 2}, then {"amount": 3} → 200 {"count": 5}',
    '- after adding 2 and 3 to tally t, GET /tallies/t/audit → 200 [2, 3]',
    '- POST /tallies/t/add {"amount": 0} → 400',
    '- GET /elsewhere → 404',
    '',
  ].join('\n'),
};

export const ADAPTER_TESTS: Readonly<Record<string, string>> = {
  tally: [
    "import { InvalidAmount, Tally } from './tally.js';",
    '',
    "describe('Tally', () => {",
    "  it('[ex 1] starts at zero', () => {",
    "    expect(new Tally('t').count()).toBe(0);",
    '  });',
    "  it('[ex 2] adds amounts', () => {",
    "    const tally = new Tally('t');",
    '    tally.add(2);',
    '    tally.add(3);',
    '    expect(tally.count()).toBe(5);',
    '  });',
    "  it('[ex 3] rejects a zero amount', () => {",
    "    expect(() => new Tally('t').add(0)).toThrow(InvalidAmount);",
    '  });',
    '});',
    '',
  ].join('\n'),
  'tally-store': [
    "import { pgliteDatabase } from '@ccc/runtime/pglite';",
    "import { schemaSql } from './schema.js';",
    "import { Tally } from './tally.js';",
    "import { TallyStore } from './tally-store.js';",
    '',
    'async function store(): Promise<TallyStore> {',
    '  const db = pgliteDatabase();',
    '  await db.exec(schemaSql);',
    '  return new TallyStore(db);',
    '}',
    '',
    "describe('TallyStore', () => {",
    "  it('[ex 1] round-trips a tally', async () => {",
    '    const tallies = await store();',
    "    const tally = new Tally('t1');",
    '    tally.add(4);',
    '    await tallies.save(tally);',
    "    expect((await tallies.load('t1'))?.count()).toBe(4);",
    '  });',
    "  it('[ex 2] returns null for a missing tally', async () => {",
    "    expect(await (await store()).load('missing')).toBeNull();",
    '  });',
    '});',
    '',
  ].join('\n'),
  'tally-audit': [
    "import { pgliteDatabase } from '@ccc/runtime/pglite';",
    "import { schemaSql } from './schema.js';",
    "import { TallyAudit } from './tally-audit.js';",
    '',
    'async function audit(): Promise<TallyAudit> {',
    '  const db = pgliteDatabase();',
    '  await db.exec(schemaSql);',
    '  return new TallyAudit(db);',
    '}',
    '',
    "describe('TallyAudit', () => {",
    "  it('[ex 1] lists recorded amounts in order', async () => {",
    '    const log = await audit();',
    "    await log.record('t', 2);",
    "    await log.record('t', 3);",
    "    expect(await log.entries('t')).toEqual([2, 3]);",
    '  });',
    "  it('[ex 2] is empty for an unknown tally', async () => {",
    "    expect(await (await audit()).entries('none')).toEqual([]);",
    '  });',
    '});',
    '',
  ].join('\n'),
  'audit-adds': [
    "import { pgliteDatabase } from '@ccc/runtime/pglite';",
    "import { handle } from './audit-adds.js';",
    "import { schemaSql } from './schema.js';",
    "import { Tally } from './tally.js';",
    "import { TallyAudit } from './tally-audit.js';",
    '',
    "describe('audit-adds', () => {",
    "  it('[ex 1] records the amount added', async () => {",
    '    const db = pgliteDatabase();',
    '    await db.exec(schemaSql);',
    '    const audit = new TallyAudit(db);',
    "    await handle({ target: new Tally('t'), args: [2], result: undefined }, { tallyAudit: audit });",
    "    expect(await audit.entries('t')).toEqual([2]);",
    '  });',
    '});',
    '',
  ].join('\n'),
  'tally-api': [
    "import { pgliteDatabase } from '@ccc/runtime/pglite';",
    "import { schemaSql } from './schema.js';",
    "import { createApp } from './server.js';",
    '',
    'async function app() {',
    '  const db = pgliteDatabase();',
    '  await db.exec(schemaSql);',
    "  return createApp(db, { endpoints: ['tally-api'] });",
    '}',
    '',
    'function add(amount: number): Request {',
    "  return new Request('http://test/tallies/t/add', {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    '    body: JSON.stringify({ amount }),',
    '  });',
    '}',
    '',
    "describe('tally-api', () => {",
    "  it('[ex 1] adds to a tally', async () => {",
    '    const handler = await app();',
    '    await handler(add(2));',
    '    const response = await handler(add(3));',
    '    expect(response.status).toBe(200);',
    '    expect(await response.json()).toEqual({ count: 5 });',
    '  });',
    "  it('[ex 2] lists audited amounts', async () => {",
    '    const handler = await app();',
    '    await handler(add(2));',
    '    await handler(add(3));',
    "    const response = await handler(new Request('http://test/tallies/t/audit'));",
    '    expect(response.status).toBe(200);',
    '    expect(await response.json()).toEqual([2, 3]);',
    '  });',
    "  it('[ex 3] rejects a zero amount', async () => {",
    '    expect((await (await app())(add(0))).status).toBe(400);',
    '  });',
    "  it('[ex 4] does not handle other routes', async () => {",
    "    expect((await (await app())(new Request('http://test/elsewhere'))).status).toBe(404);",
    '  });',
    '});',
    '',
  ].join('\n'),
};

export const ADAPTER_IMPL: Readonly<Record<string, string>> = {
  tally: [
    'export class InvalidAmount extends Error {}',
    '',
    'export class Tally {',
    '  readonly id: string;',
    '  #count = 0;',
    '',
    '  constructor(id: string) {',
    '    this.id = id;',
    '  }',
    '',
    '  static restore(id: string, count: number): Tally {',
    '    const tally = new Tally(id);',
    '    tally.#count = count;',
    '    return tally;',
    '  }',
    '',
    '  count(): number {',
    '    return this.#count;',
    '  }',
    '',
    '  add(amount: number): void {',
    '    if (!Number.isInteger(amount) || amount <= 0) {',
    '      throw new InvalidAmount(`amount must be a positive integer, got ${amount}`);',
    '    }',
    '    this.#count += amount;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'tally-store': [
    "import type { Database } from '@ccc/runtime';",
    "import { Tally } from './tally.js';",
    '',
    'type TallyRow = { readonly id: string; readonly count: number };',
    '',
    'export class TallyStore {',
    '  readonly #db: Database;',
    '',
    '  constructor(db: Database) {',
    '    this.#db = db;',
    '  }',
    '',
    '  async load(id: string): Promise<Tally | null> {',
    "    const { rows } = await this.#db.query<TallyRow>('select id, count from tallies where id = $1', [id]);",
    '    const row = rows[0];',
    '    return row === undefined ? null : Tally.restore(row.id, row.count);',
    '  }',
    '',
    '  async save(tally: Tally): Promise<void> {',
    '    await this.#db.query(',
    "      'insert into tallies (id, count) values ($1, $2) on conflict (id) do update set count = excluded.count',",
    '      [tally.id, tally.count()],',
    '    );',
    '  }',
    '}',
    '',
  ].join('\n'),
  'tally-audit': [
    "import type { Database } from '@ccc/runtime';",
    '',
    'type EntryRow = { readonly amount: number };',
    '',
    'export class TallyAudit {',
    '  readonly #db: Database;',
    '',
    '  constructor(db: Database) {',
    '    this.#db = db;',
    '  }',
    '',
    '  async record(tallyId: string, amount: number): Promise<void> {',
    "    await this.#db.query('insert into tally_audit (tally_id, amount) values ($1, $2)', [tallyId, amount]);",
    '  }',
    '',
    '  async entries(tallyId: string): Promise<number[]> {',
    "    const { rows } = await this.#db.query<EntryRow>('select amount from tally_audit where tally_id = $1 order by seq', [tallyId]);",
    '    return rows.map((row) => row.amount);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'audit-adds': [
    "import type { Tally } from './tally.js';",
    "import type { TallyAudit } from './tally-audit.js';",
    '',
    'export interface SyncEvent {',
    '  readonly target: Tally;',
    "  readonly args: Parameters<Tally['add']>;",
    "  readonly result: Awaited<ReturnType<Tally['add']>>;",
    '}',
    '',
    'export interface SyncTargets {',
    '  readonly tallyAudit: TallyAudit;',
    '}',
    '',
    'export async function handle(event: SyncEvent, targets: SyncTargets): Promise<void> {',
    '  await targets.tallyAudit.record(event.target.id, event.args[0]);',
    '}',
    '',
  ].join('\n'),
  'tally-api': [
    "import { Invalid, errorResponse, unmatched, withScope, type Database } from '@ccc/runtime';",
    "import { Hono } from 'hono';",
    "import { z } from 'zod';",
    "import { InvalidAmount, Tally } from './tally.js';",
    "import type { TallyAudit } from './tally-audit.js';",
    "import type { TallyStore } from './tally-store.js';",
    '',
    'export interface TallyApiDeps {',
    '  readonly db: Database;',
    '  readonly tallyStore: TallyStore;',
    '  readonly tallyAudit: TallyAudit;',
    '}',
    '',
    'const addBody = z.object({ amount: z.number() });',
    '',
    'export function createHandler(deps: TallyApiDeps): (request: Request) => Promise<Response> {',
    '  const app = new Hono();',
    "  app.post('/tallies/:id/add', async (c) => {",
    '    const parsed = addBody.safeParse(await c.req.json());',
    '    if (!parsed.success) {',
    "      return errorResponse(new Invalid('amount must be a number'));",
    '    }',
    "    const id = c.req.param('id');",
    '    const tally = (await deps.tallyStore.load(id)) ?? new Tally(id);',
    '    try {',
    '      await withScope({ tally }, async () => {',
    '        tally.add(parsed.data.amount);',
    '      });',
    '    } catch (err) {',
    '      if (err instanceof InvalidAmount) {',
    '        return errorResponse(new Invalid(err.message));',
    '      }',
    '      throw err;',
    '    }',
    '    await deps.tallyStore.save(tally);',
    '    return c.json({ count: tally.count() });',
    '  });',
    "  app.get('/tallies/:id/audit', async (c) => c.json(await deps.tallyAudit.entries(c.req.param('id'))));",
    '  app.notFound(() => unmatched());',
    '  return async (request) => app.fetch(request);',
    '}',
    '',
  ].join('\n'),
};

export function adapterResponder(): FakeResponder {
  return (request) => {
    const id = conceptOf(request);
    return (artifactOf(request) === 'tests' ? ADAPTER_TESTS : ADAPTER_IMPL)[id] ?? null;
  };
}

export async function createAdapterProject(): Promise<string> {
  const root = await writeProject({ ...ADAPTER_FILES });
  await linkPackages(root, ['@ccc/runtime', 'hono', 'zod']);
  return root;
}
```

- [ ] **Step 2: Write the test**

`packages/cli/test/adapter-pipeline.test.ts`:
```ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pgliteDatabase } from '@ccc/runtime/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { approve, pendingApprovals } from '../src/approve.js';
import { runBuild } from '../src/build.js';
import { readFileOrNull } from '../src/fsutil.js';
import { readManifest, writeManifest } from '../src/manifest.js';
import { runVerify } from '../src/verify.js';
import { adapterResponder, createAdapterProject } from './adapter-fixture.js';
import { FakeGenerator } from './fake-generator.js';

let root = '';

beforeAll(async () => {
  root = await createAdapterProject();
  const result = await runBuild({ root, generator: new FakeGenerator(adapterResponder()) });
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
}, 300_000);

describe('adapter pipeline', () => {
  it('generates schema, wiring, and a composition root', async () => {
    expect(await readFileOrNull(root, '.ccc/gen/schema.sql')).toContain('create table tally_audit');
    expect(await readFileOrNull(root, '.ccc/gen/wiring.ts')).toContain("afterAction(result, 'audit-adds'");
    expect(await readFileOrNull(root, '.ccc/gen/server.ts')).toContain('tallyAudit: new a0.TallyAudit(db),');
  });

  it('serves requests with syncs firing inside the request scope', async () => {
    const server = await import(pathToFileURL(path.join(root, '.ccc/gen/server.ts')).href);
    const schema = await import(pathToFileURL(path.join(root, '.ccc/gen/schema.ts')).href);
    const db = pgliteDatabase();
    await db.exec(schema.schemaSql);
    const app = await server.createApp(db);
    const post = (amount: number) =>
      app(
        new Request('http://test/tallies/t/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amount }),
        }),
      );
    expect((await post(2)).status).toBe(200);
    const second = await post(3);
    expect(await second.json()).toEqual({ count: 5 });
    const audit = await app(new Request('http://test/tallies/t/audit'));
    expect(await audit.json()).toEqual([2, 3]);
    expect((await post(0)).status).toBe(400);
    expect((await app(new Request('http://test/elsewhere'))).status).toBe(404);
  });

  it('verifies once tests are approved', async () => {
    const { manifest } = await readManifest(root);
    approve(manifest, await pendingApprovals(root, manifest));
    await writeManifest(root, manifest);
    expect((await runVerify(root)).diagnostics).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm build && pnpm --filter @ccc/cli exec vitest run adapter-pipeline` (expected: PASS; allow a few minutes).

If it fails, the failure points at a concrete stage (conformance, wiring, composition, endpoint tests, or the live requests). Debug with superpowers:systematic-debugging. The canned code is known-good TypeScript, so a failure is a defect in Tasks 1–10: fix the defect, and never loosen the fixture.

- [ ] **Step 4: Gates and commit**

Run: `pnpm verify` (expected: all green).
```bash
git add packages/cli/test/adapter-fixture.ts packages/cli/test/adapter-pipeline.test.ts
git commit -m "Test the adapter pipeline end to end: stores, sync to a store, endpoint, live requests"
```

---

### Task 12: Documentation and spec amendments

**Files:**
- Create: `docs/runtime.md`
- Modify: `docs/schema.md`, `docs/building.md`, `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-24-ccc-design.md`

- [ ] **Step 1: Write `docs/runtime.md`**

````markdown
# Runtime and adapters

Generated services use `@ccc/runtime`, a small hand-written library, and are assembled by files `ccc build` writes into `.ccc/gen`.

## Adapter conventions (checked by `ccc check`)

| Kind | Must export | Notes |
|---|---|---|
| `store` | class named after the concept (`game-store` → `GameStore`) with `constructor(db: Database)` | `## Schema` holds a ```` ```sql ```` block; all stores' SQL is combined into `.ccc/gen/schema.sql` |
| `auth` | class with `constructor(db: Database)` and `authenticate(request): Promise<Identity \| null>` | |
| `endpoint` | `createHandler(deps): (request: Request) => Promise<Response>` | `deps` keys are `db` plus the camelCase ids of adapters (`gameStore`, `auth`) |

Interfaces may write `import type { Database } from '@ccc/runtime'`. That is the only import allowed.

## What the build writes

| File | Purpose |
|---|---|
| `.ccc/gen/schema.sql`, `schema.ts` | Every store's tables, in dependency order (`schemaSql` for tests) |
| `.ccc/gen/wiring.ts` | Patches each sync's trigger method so the handler runs after it |
| `.ccc/gen/server.ts` | `createApp(db, { endpoints? })`: builds adapters, binds them, routes requests to endpoints |
| `.ccc/gen/main.ts` | Node entry: `DATABASE_URL=… PORT=3000 tsx .ccc/gen/main.ts` (needs `pg` and `@hono/node-server`) |

## How syncs run

Every request runs inside `withScope(...)`, with the adapter singletons bound by concept id.

When a trigger action succeeds, its sync's handler is deferred into the current scope. Handlers resolve their targets as follows:

- **Adapters:** resolved from the scope.
- **Domain concepts:** resolved from bindings the endpoint adds with `withScope({ 'game': game }, …)`.
- **Function actions:** resolved from their module.

`withScope` waits for all deferred work, including syncs triggered by syncs, before it resolves. A failing handler therefore fails the whole operation, and a surrounding transaction rolls back. A missing binding fails with a message naming the sync and the concept id to bind.

## Databases

- **`pgDatabase(pool)`:** wraps a `pg.Pool` for production.
- **`pgliteDatabase()`:** creates a fresh in-memory Postgres. Tests use it (from `@ccc/runtime/pglite`).
- **`ccc db reset`:** drops everything in `DATABASE_URL` and applies `.ccc/gen/schema.sql`. For development only.

## Errors

Throw `Invalid` (400), `Unauthorized` (401), `NotFound` (404), or `Conflict` (409), and endpoints answer with `errorResponse(err)`. Endpoints return `unmatched()` for routes they don't own, so the next endpoint can try.
````

- [ ] **Step 2: Update the other docs and the spec**

1. `docs/schema.md`:
   - In the Kinds table, add each adapter's required export (store: primary class with `constructor(db: Database)`; auth: primary class with `authenticate(request)`; endpoint: `createHandler(deps)`).
   - In Fields, note the one allowed import, `import type { ... } from '@ccc/runtime'`.
   - Under Syncs, add: "`when` must be a method (it's wired by patching the class)."
   - Add to the `ccc check` list: "10. Adapter conventions; `server`, `main`, `wiring`, `schema` are reserved names."
2. `docs/building.md`: add the five composition files to the "What gets generated" table (no LLM), and a pointer to `docs/runtime.md`.
3. `README.md`: the status line becomes "Status: research prototype. The full pipeline works (`check`, `build`, `tests`, `approve`, `verify`, `stats`, `regen --compare`, `db reset`); the card-game example comes next." Add a link to `docs/runtime.md`.
4. `CLAUDE.md`: note that `pnpm verify` builds before type-checking and testing (the CLI needs `packages/runtime/dist`), and that running a single CLI test file needs `pnpm build` first.
5. The spec:
   - §5.1: the runtime's API is now `Database`/`Sql` with `pgDatabase` and `pgliteDatabase`, `withTransaction(db, fn)`, scopes (`withScope`, `afterAction`), `unmatched`/`errorResponse`/`json`.
   - §5.2: `createApp(db, { endpoints? })` returns a fetch-style handler; `main.ts` is the Node entry.
   - §5.3: the adapter conventions above.
   - §2.6: triggers must be methods, and sync targets resolve from scope bindings.
   - §3.1: add `wiring.ts`, `server.ts`, `main.ts`, `schema.sql`, `schema.ts`.
   - §3.4: endpoints build last, and the composition files are type-checked after the implementation stage.

- [ ] **Step 3: Gates and commit**

Run: `pnpm verify` (expected: all green).
```bash
git add docs README.md CLAUDE.md
git commit -m "Document the runtime, adapters, and composition; align the spec with Plan 3"
```
