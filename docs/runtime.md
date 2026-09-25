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

Handlers start after their trigger succeeds and run alongside the caller. `withScope` waits for all deferred work, including syncs triggered by syncs, before it resolves, and rethrows the first failure. So save and respond only after `await withScope(...)` returns. A trigger called outside any scope throws before it does anything. A missing binding fails with a message naming the sync and the concept id to bind.

Syncs are not transactional in this version. Adapters are bound to the app's `db`, so a failing sync fails the request but doesn't undo writes already made. Don't wrap sync-triggering actions in `withTransaction`: with PGlite it deadlocks.

## Databases

- **`pgDatabase(pool)`:** wraps a `pg.Pool` for production.
- **`pgliteDatabase()`:** creates a fresh in-memory Postgres. Tests use it (from `@ccc/runtime/pglite`).
- **`ccc db reset`:** drops everything in `DATABASE_URL` and applies `.ccc/gen/schema.sql`. For development only.

## Errors

Throw `Invalid` (400), `Unauthorized` (401), `NotFound` (404), or `Conflict` (409), and endpoints answer with `errorResponse(err)`. Endpoints return `unmatched()` for routes they don't own, so the next endpoint can try.
