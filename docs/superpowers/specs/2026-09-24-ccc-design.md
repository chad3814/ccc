# ccc (chris-chad-concepts): Design

**Date:** 2026-09-24
**Status:** Draft for review
**Authors:** Chad, Chris (design session with Claude)

## 1. Purpose

LLM chat sessions are becoming a higher-level programming language, but they are not reproducible, reproducing them costs money, and saving only the generated code throws away the reasoning behind it. ccc tests an alternative: developers edit a structured **concept model** (plain-text files in git) that is the **sole source of truth**, and ccc compiles it into TypeScript. Generated code is a read-only build artifact, cached and regenerated incrementally.

v1 is a **research prototype** for two developers (Chad and Chris). Its job is to answer one question:

> Can code regenerated from concepts + examples reliably pass independently approved tests, at an acceptable cost per change, with stable output across regenerations?

### 1.1 Principles

- **Single source of truth.** Developers edit concepts, never generated code. Hand-written code exists only as a concept node (`implementation: handwritten`), still bound by its interface and examples. Mixed sources of truth are what killed model-driven development.
- **Equivalence, not determinism.** Regenerated code need not be byte-identical; it must pass the concept's approved tests.
- **Generated code is a build cache.** Keyed by content hashes, committed to git, regenerated only when its inputs change.
- **Deterministic wherever possible.** Validation, wiring, composition, and enforcement never involve an LLM. Only implementation bodies, sync handlers, and tests are generated.

### 1.2 Success criteria

1. A multiplayer card game (auth, lobby/join, deal via sync, play, finish, leaderboard via domain→adapter sync) is described entirely in concepts, builds with `ccc build`, passes `ccc verify`, and serves a playable game over HTTP.
2. `ccc stats` and `ccc regen --compare` produce first-attempt pass rate, repair attempts, cost per concept/build, and regeneration stability.
3. Chris can clone the repo, read `docs/`, and add a concept without help.

Status (2026-09-24):
- **Criterion 1:** the card game is modeled completely (16 concepts). `ccc check` passes and the build plans 31 generations. The real build, approval, `verify`, and the smoke game need Claude credentials and are one command each (see `examples/card-game/README.md`).
- **Criterion 2:** `stats` and `regen --compare` exist.
- **Criterion 3:** `docs/` covers the schema, building, and the runtime.

### 1.3 Out of scope for v1

Concept templates (parameterized concepts); mechanical checking of invariant placement; async/eventual syncs; background jobs; live data migrations; any deploy target; the visual concept editor; agent-based generation.

## 2. Concept schema

### 2.1 Files and IDs

- Concepts live under `concepts/` as Markdown files with YAML frontmatter.
- **The ID is derived from the path**: `concepts/game/hand.md` → `game.hand`. IDs are never written in frontmatter.
- **Containment is directory structure**: `concepts/game.md` is the parent; `concepts/game/*.md` are its children. A child may itself have children (`concepts/game/player.md` + `concepts/game/player/`).
- Path segments are kebab-case; IDs join segments with `.`.

### 2.2 Kinds

| Group | Kind | Meaning | Kind-specific fields |
|---|---|---|---|
| Domain (pure) | `value` | No identity; equal if fields match | — |
| | `entity` | Has identity and lifecycle | — |
| | `collection` | Structure + operations over another concept | `of: <id>` (required) |
| | `aggregate` | Root that owns its children and enforces cross-child invariants | — |
| Adapter (I/O) | `store` | Persists one aggregate | `persists: <id>` (required) |
| | `endpoint` | HTTP routes orchestrating domain, stores, auth | — |
| | `auth` | Resolves requests to an identity | — |
| Wiring | `sync` | Connects an action on one concept to actions on others | `when`, `then` (required) |

**Domain concepts must not depend on adapter concepts.** Adapters and syncs may depend on anything visible.

### 2.3 Frontmatter fields

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | One of the kinds above |
| `interface` | yes, except `sync` | TypeScript declarations (types, classes, function signatures, error classes) that this concept exports. The precise boundary other concepts depend on. |
| `uses` | no | IDs whose exported interfaces this concept depends on. Must be complete: it defines the dependency graph and the cache key. |
| `implementation` | no | `generated` (default) or `handwritten` |
| `source` | when `handwritten` | Path to the hand-written module, relative to the project root |
| `of` / `persists` | per kind | See 2.2 |
| `when` / `then` | `sync` only | See 2.6 |

An aggregate implicitly uses its direct children; they need not be listed in `uses`.

### 2.4 Visibility

Visibility is **lexical**. A concept may reference (in `uses`, `of`, `persists`, `when`, `then`):

- its ancestors,
- its own direct children,
- its siblings,
- the siblings of any of its ancestors (which includes all top-level concepts).

Anything nested more deeply is private to its parent. Example: `game.player.hand` is visible to `game.player` and to `game.player`'s other children, but not to `game` or `game-api`. A directory must always have its parent concept file (`concepts/game/` requires `concepts/game.md`); there are no namespace-only directories.

### 2.5 Markdown sections

| Section | Required | Meaning |
|---|---|---|
| `## Intent` | yes | What the concept is for |
| `## Rules` | no | Invariants and behavioral rules, in prose. Guidance: place a rule on the lowest concept that can see everything it mentions. |
| `## Examples` | yes for a build to pass | Bulleted prose examples, one behavior per bullet. The source for generated tests. |
| `## Decisions` | no | The reasons behind choices. Included in generation context so reasoning is never lost. |

Unknown `##` sections are a validation error (catches typos like `## Example`).

### 2.6 Syncs

Syncs follow Daniel Jackson's concept-design model: concepts stay independent; syncs are separate files that connect them.

```markdown
concepts/game/deal-on-full-table.md
---
kind: sync
when: game.players#join
then: [game#deal]
---
## Intent
Start the round automatically once the table fills.

## Rules
- Only deal when the join made the table full and no round is in progress.

## Examples
- given 3 of 4 seats taken, join(user) → deal() called once
- given 2 of 4 seats taken, join(user) → deal() not called
```

- **Placement:** in the lowest common ancestor directory of the concepts it connects (same rule as invariants).
- **`when`**: one action, written `<concept-id>#<exported-member>` (`#` keeps concept IDs and member names unambiguous), that exists in a visible concept's interface. It must be a method of the concept's primary class, because wiring patches the class.
- **`then`**: one or more actions in the same form.
- **Action resolution:** `<concept-id>#<member>` resolves to an exported function named `<member>` in that concept's interface, or else a method named `<member>` on the concept's *primary class*: the exported class whose name is the PascalCase form of the ID's last segment (`game.players` → `Players`, `game-store` → `GameStore`).
- **Conditions and argument mapping** are prose in Rules/Examples; the LLM generates a handler `(triggerArgs, triggerResult, targets) => Promise<void>` that decides whether and how to invoke the `then` actions.
- **Wiring is deterministic.** ccc generates a wrapper for each concept that is the `when` of any sync; after the wrapped action succeeds, the wrapper invokes matching sync handlers in file-path order.
- **Complete when the scope resolves.** A sync's handler starts once its trigger action succeeds and runs alongside the caller; `withScope` waits for every handler (including syncs triggered by syncs) before it resolves, and rethrows the first failure. Endpoints therefore save and respond only after `await withScope(...)`. Triggers must run inside a scope; wiring checks this before the action's side effects.
- **Not transactional (v1).** Adapter targets are singletons bound to the app's `db`, so sync writes happen outside any endpoint transaction; a failing sync fails the request but doesn't undo writes already made. Endpoints must not wrap sync-triggering actions in `withTransaction` (with PGlite that deadlocks). A later version can rebind adapters to the transaction.
- **Domain→adapter syncs are allowed** (e.g., `when: game#finish`, `then: [leaderboard-store#record]`). The dependency lives in the sync, so the domain concept stays pure.

### 2.7 Complete concept example

```markdown
concepts/game/player/hand.md
---
kind: collection
of: card
uses: [card]
interface: |
  export class DuplicateCard extends Error {}
  export class CardNotInHand extends Error {}
  export class Hand {
    constructor(cards?: readonly Card[]);
    add(card: Card): void;
    remove(card: Card): Card;
    has(card: Card): boolean;
    size(): number;
    cards(): readonly Card[];
  }
---
## Intent
The cards a player currently holds.

## Rules
- A hand never contains the same card twice.

## Examples
- given an empty hand, add(A♠) → size is 1
- given hand [A♠], add(A♠) → throws DuplicateCard
- given hand [A♠, K♥], remove(K♥) → returns K♥, size is 1
- given hand [A♠], remove(K♥) → throws CardNotInHand

## Decisions
- Unordered; sorting is a display concern (2026-09).
```

### 2.8 Validation (`ccc check`, no LLM)

1. Every file parses; frontmatter matches the zod schema for its kind; required sections are present; no unknown sections.
2. Every referenced ID exists and is visible from the referencing concept.
3. The dependency graph (`uses`, `of`, `persists`, implicit aggregate→children, sync `when`/`then`) is acyclic.
4. No domain concept depends on an adapter concept.
5. All interfaces type-check together: ccc emits one `.d.ts` per concept (with imports derived from `uses`) and runs `tsc --noEmit`.
6. Every sync's `when` and `then` actions exist as exported members of the referenced interfaces.
7. The sync trigger graph is acyclic: no sync can directly or transitively re-trigger its own `when` action.
8. Every `handwritten` concept's `source` file exists.

Errors report the file path, line (where available), and a fix hint.

## 3. Project layout, cache, and build pipeline

### 3.1 Layout of a ccc project

```
ccc.config.ts        models, maxAttempts, concurrency, paths
concepts/            source of truth
handwritten/         sources for implementation: handwritten concepts
.ccc/
  gen/               generated TypeScript mirroring concept paths (read-only, committed)
    game/player/hand.ts
    game/player/hand.test.ts
    game/player/hand.contract.d.ts   the interface beside its module (deterministic)
    wiring.ts        sync wrappers (deterministic)
    server.ts        composition root (deterministic)
    schema.sql       combined store DDL (deterministic)
  interfaces/        emitted .d.ts files (deterministic, committed)
  conformance/       compile-time checks that each module matches its contract (deterministic, committed)
  package.json       {"type": "module"} so everything under .ccc is ESM
  .gitignore         ignores .tmp/, the scratch space for checks
  manifest.json      keys, hashes, approvals, generation stats
```

A contract file repeats the interface next to the generated module so that its relative imports resolve to the generated dependencies. Conformance compares against the contract rather than `.ccc/interfaces/`, because classes with private members compare nominally: `interfaces/hand.d.ts`'s `Hand` and `gen/hand.ts`'s `Hand` are different types.

Generated output is committed, so fresh clones and CI never regenerate.

`ccc.config.ts` exports:

```ts
export default defineConfig({
  models: {
    impl: { start: 'claude-haiku-4-5', cap: 'claude-opus-5' },
    tests: { start: 'claude-sonnet-5', cap: 'claude-opus-5' },
  },
  ladder: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1'],
  escalateAfter: 2,
  maxAttempts: 3,
  testMaxAttempts: 3,
  concurrency: 4,
});
```

Every setting is optional. A model may also be a plain name (`impl: 'claude-opus-5'`), which fixes that model and never escalates. `start` and `cap` must be on the ladder, with `start` at or below `cap`. `defineConfig` comes from `@ccc/runtime` (Plan 3); a plain object default export works too.

### 3.2 Cache keys

A concept's key includes its dependencies' **interfaces**, never their implementations or prose (separate compilation). Editing `game.player.hand`'s Rules regenerates `hand` only; `game` is untouched unless `hand`'s interface changes.

| Artifact | Key = SHA-256 of |
|---|---|
| Tests | normalized concept file + own interface + interfaces of all transitive dependencies + runtime version |
| Implementation | normalized concept file + dependency interfaces + current test file hash + runtime version |
| Sync handler | normalized sync file + `when`/`then` interfaces + current test file hash + runtime version |

- **Normalization:** frontmatter re-serialized with sorted keys; Markdown trailing whitespace trimmed and line endings normalized. Formatting-only edits do not invalidate.
- **Runtime version** = `@ccc/runtime` package version.
- **Models and prompts are not in the key.** Generated code is accepted because it passes its approved tests, not because a particular model or prompt wrote it; output is expected to differ between generations. Changing models, the ladder, or ccc's prompts leaves current code alone. `ccc build --fresh [id]` regenerates implementations on purpose, and `ccc tests --fresh [id]` regenerates tests (which then need approval again).

### 3.3 Manifest

`.ccc/manifest.json` records, per concept:

- `testKey`, `testFileHash`, `approvedTestHash` (null if pending)
- `implKey` (null for handwritten)
- `history`: one entry per generation: artifact (`tests` | `impl`), timestamp, model (of the last attempt), attempts, input/output tokens, cost (USD, each turn priced at the model that ran it), duration, outcome (`passed` | `failed`), escalations (ladder steps climbed)

A top-level `files` map records the hash of every file under `.ccc/gen`, `.ccc/interfaces`, and `.ccc/conformance`, plus `.ccc/package.json` and `.ccc/.gitignore`. Build uses it to notice edited or missing modules; verify uses it to name them. The manifest is written atomically (write a temp file, then rename).

### 3.4 `ccc build` stages

1. **Check** — run 2.8. Any failure stops the build before LLM spend.
2. **Plan** — topologically sort; compute keys; list stale tests and implementations. `--dry-run` stops here and prints the plan with call counts.
3. **Tests** — regenerate stale test files; mark them pending (`approvedTestHash = null`).
4. **Implementations** — regenerate stale implementations and sync handlers, topological level by level, up to `concurrency` in parallel within a level. Pending tests do not block this stage.
5. **Wiring** — always regenerate `wiring.ts`, `server.ts`, `schema.sql`, `interfaces/`.
6. **Full suite** — run all tests (exercises sync wiring and endpoint examples end to end).
7. **Manifest** — write.

`ccc build <id>` limits stages 3–4 to that concept and its stale dependencies.

### 3.5 Commands

| Command | Does | Calls LLM |
|---|---|---|
| `ccc check` | Validation (2.8) | no |
| `ccc build [id] [--dry-run] [--fresh]` | Pipeline (3.4); `--fresh` regenerates implementations (of `id`, or all) even when current, keeping tests | yes |
| `ccc tests [id] [--fresh]` | Stage 3 only; `--fresh` regenerates tests even when current | yes |
| `ccc approve [id]` | Shows each pending test file (diff against last approved), records approval on confirmation | no |
| `ccc verify` | CI gate (6) | no |
| `ccc stats` | First-attempt pass rate, mean attempts, escalations, cost per concept and by final model, from manifest history | no |
| `ccc regen --compare <id>` | Regenerates the implementation ignoring cache into a temp dir; reports approved-test pass/fail and diff size vs committed; does not write | yes |
| `ccc db reset` | Drops and recreates the dev database from `schema.sql` using `DATABASE_URL` | no |

## 4. Generation and verification

### 4.1 Implementation context (exactly this, nothing else)

- Versioned system prompt: implement exactly the declared interface, no extra exports; strict TypeScript, no `any`; only the imports allowed for this kind (4.3); use `@ccc/runtime` error types and helpers.
- The concept's full file (Intent, Rules, Examples, Decisions, interface).
- The `.d.ts` of every dependency (including an aggregate's children), with the import paths to use.
- The concept's current test file.

### 4.2 Output

The model returns code through a tool call `write_module({ code: string })` (strict schema, `tool_choice: auto`). Requests stream with `max_tokens: 64000`. Thinking and fallbacks are per model: adaptive thinking on current frontier models, with server-side refusal fallbacks (`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`) on Opus 5, Opus 5.5, and Fable; a thinking budget on Haiku 4.5; neither on unknown models. Persistent rate limits, bad credentials, and unknown models stop the build with one diagnostic (`GeneratorUnavailable`). A reply with no tool call, a truncated call, or a refusal counts as a failed attempt. ccc prepends a deterministic header:

```ts
// @generated by ccc from concept game.player.hand (key 3f2a91…). Do not edit.
```

### 4.3 Allowed imports per kind (enforced by ccc's import scanner, not by the prompt)

| Kind | Allowed |
|---|---|
| domain kinds | dependency modules, `@ccc/runtime` |
| `store` | + `pg` |
| `endpoint` | + `hono`, `zod` |
| `auth` | + `hono` (types), Web Crypto (global) |
| `sync` | `when`/`then` modules, `@ccc/runtime` |

Node built-ins are not on any list, so no kind can import them. oxlint enforces `typescript/no-explicit-any` on every generated module. Tests may import the module under test and all of its transitive dependencies (so they can build values), plus `@ccc/runtime`.

### 4.4 Test generation (independent pass)

- Context: the whole concept (Intent, Rules, Examples, Decisions, Schema), its interface, and the interfaces of all transitive dependencies. **Never an implementation.** The independence that matters is from the implementation; the Rules are specification, and hiding them made tests guess at things the concept states (request shapes, turn order). Each test still checks exactly what its example states.
- Each example bullet becomes exactly one Vitest test named `[ex N] <summary>` (N is the 1-based bullet index). ccc parses the returned file and rejects it if the set of `[ex N]` names does not equal `1..count(examples)`; this counts as a failed attempt.
- Test failures map directly back to example bullets.
- Adapter tests are hermetic: stores run against PGlite; endpoints run through Hono `app.request()` with PGlite-backed stores; auth likewise.
- Test generation retries only on parse/count/type errors (it cannot run against a missing implementation); it has its own `maxAttempts`.

### 4.5 Repair loop (per implementation)

1. Reject the candidate before writing it if it imports anything not allowed (4.3) or exports a name its interface doesn't declare.
2. Write it in place at `.ccc/gen/<id>.ts`. Run `tsc` on the module, its conformance file, and its tests (only errors in those files count); run oxlint on the module; run the concept's tests. Skipped tests count as failures.
3. On failure, put the previous module back immediately, then send the trimmed problems (first 50) back in the same conversation and retry, up to `maxAttempts`.
4. On success, keep the file; the manifest records its hash.
5. **Escalation.** Each artifact's attempts climb the ladder from its `start` model: after every `escalateAfter` failed attempts, the next attempt runs on the next stronger model, up to `cap`. The conversation continues, so the stronger model sees every earlier attempt and its problems; request settings (thinking, fallbacks) follow the model of each turn. `maxAttempts` counts attempts across all models. Every generation starts again at `start`; nothing is remembered between builds. Test generation escalates the same way.
6. On exhaustion, or on a generator error (the SDK has already retried transient failures), the concept fails with the last problems. The last good version stays; dependents are skipped for this build; unrelated concepts continue.

The manifest records hashes only for files the build itself wrote, so a hand edit anywhere else stays visible to the next build and to `verify`. Entries for deleted concepts are dropped.

Conformance compares the module with its contract in both directions for values (assignable, no extra exports) and for exported interfaces and non-generic type aliases (identical).

### 4.6 Handwritten concepts

No generation. The `source` module is re-exported from the concept's `.ccc/gen` path so dependents import it identically, and it goes through the same `tsc`, oxlint, and approved-test checks. Its tests are generated and approved like any other concept's.

## 5. Runtime and adapters

### 5.1 `@ccc/runtime`

A small hand-written library (`packages/runtime`); its version is part of every cache key.

- **Errors:** `DomainError` and `Invalid` (400), `Unauthorized` (401), `NotFound` (404), `Conflict` (409); `httpStatusOf(err)`.
- **HTTP:** `json(body, status)`, `errorResponse(err)`, `unmatched()` / `isUnmatched(response)` (a 404 marked so the composition root tries the next endpoint).
- **Databases:** `Sql` (`query<R>(text, params)`, `exec(text)`) and `Database` (adds `transaction(fn)`); `pgDatabase(pool)` wraps a `pg.Pool`; `pgliteDatabase()` from `@ccc/runtime/pglite` is a fresh in-memory Postgres for tests; `withTransaction(db, fn)`.
- **Scopes:** `withScope(bindings, fn)` runs a unit of work (AsyncLocalStorage); `afterAction(result, sync, run)` defers sync work into the current scope; `withScope` drains deferred work (including chains) before resolving and rethrows the first failure. A missing binding throws `SyncTargetMissing`, naming the sync and the concept id.
- **Config:** `defineConfig(config)`.

### 5.2 Composition (deterministic files in `.ccc/gen`)

- `wiring.ts` patches each sync's trigger method (`Class.prototype.method`): the original runs, then the handler is deferred with `afterAction`. Class targets resolve from the scope by concept id; function-action targets are module namespaces. Syncs on the same trigger fire in sync-id order.
- `server.ts` exports `createApp(db, { endpoints? })`, returning `(request: Request) => Promise<Response>`. It builds every store and auth adapter (`new Class(db)`), binds them as scope singletons by concept id, lazily loads each endpoint's `createHandler(container)` (container: `db` plus adapters keyed by camelCase id), runs each request in `withScope`, and tries endpoints in order until one doesn't answer `unmatched()`.
- `main.ts` is the Node entry: a `pg.Pool` from `DATABASE_URL`, served with `@hono/node-server` on `PORT`.
- `schema.sql` / `schema.ts` combine every store's SQL in dependency order.

Endpoints build last (after every other concept), because their tests run the whole app through `createApp`. After the implementation stage the build type-checks `wiring.ts` and `server.ts`.

### 5.3 Adapter kinds

- **`store`**: primary class with `constructor(db: Database)`; `## Schema` holds a fenced `sql` block.
- **`endpoint`**: exports `createHandler(deps)`; builds routes with Hono, validates bodies with zod, answers unknown routes with `unmatched()`, and binds the aggregates its actions touch with `withScope({ '<id>': instance }, ...)` so syncs can resolve them.
- **`auth`**: primary class with `constructor(db: Database)` and `authenticate(request): Promise<Identity | null>`. **Generated security code; acceptable for a prototype only.**
- Interfaces may `import type { ... } from '@ccc/runtime'`; no other import.

### 5.4 Database changes

No migrations in v1. When store DDL changes, `ccc db reset` rebuilds the dev database. Live-data migrations (e.g., with Neon branching) are a later milestone.

## 6. CI enforcement (`ccc verify`)

Never calls the LLM; CI needs no API key. Fails if any of:

1. `ccc check` fails.
2. Any file under `.ccc/gen` or `.ccc/interfaces` does not match its manifest hash, or exists without a manifest entry (catches hand edits).
3. Any concept's current key differs from its manifest key (a concept changed without a rebuild).
4. Any test file is unapproved.
5. The full test suite fails.

## 7. ccc repository

### 7.1 Layout (pnpm workspace)

```
packages/cli/          the `ccc` command
packages/runtime/      @ccc/runtime
examples/card-game/    concepts + committed .ccc/gen; the acceptance test
docs/                  schema reference, specs
```

### 7.2 CLI modules

| Module | Responsibility |
|---|---|
| `schema` | zod schemas for frontmatter per kind; the executable definition of the schema |
| `loader` | Read files, split frontmatter and sections, derive IDs from paths |
| `graph` | Visibility, reference resolution, domain→adapter rule, dependency and sync cycle detection |
| `interfaces` | Emit `.d.ts`, type-check them, list exported members (via `@typescript/typescript6` compiler API, isolated here so it can move to the TS 7.1 API later) |
| `keys` | Normalization and hashing |
| `llm` | `Generator` interface; `AnthropicGenerator` (`@anthropic-ai/sdk`) and `FakeGenerator` for tests |
| `generate` | Context assembly, prompt templates, repair loop, test-count check |
| `toolchain` | Async runners for `tsc`, oxlint, Vitest (child processes) |
| `manifest` | Atomic read/write of `.ccc/manifest.json` |
| `commands` | One file per command in 3.5 |

Code style: TypeScript strict, 2-space indent, semicolons, no `any`/`unknown` (validation via zod), async APIs only.

### 7.3 Secrets

`ANTHROPIC_API_KEY` is read only from the environment (e.g., `op run -- ccc build`). ccc never logs it, writes it, or includes it in manifests or errors.

### 7.4 Testing ccc

- **Unit:** loader, schema, graph checks (each rule in 2.8 with passing and failing fixtures), key stability (same input → same key; dependency implementation change → dependent key unchanged; dependency interface change → dependent key changed), normalization, manifest atomicity.
- **Pipeline (with `FakeGenerator`, no API spend, deterministic):** stale planning; repair loop fail-then-succeed; exhaustion keeps last good output and skips dependents; example-count rejection; approval gating in `verify`; wiring and composition-root generation.
- **Live (`pnpm test:live`, opt-in script):** real build of a tiny fixture project against the Claude API.
- **Acceptance:** `examples/card-game` builds for real, passes `ccc verify`, and serves a playable game.

### 7.5 Tooling note

typescript-eslint does not support TypeScript 7 (peer range `<6.1`), so linting (ccc's own code and generated code) uses **oxlint**, which enforces `no-explicit-any` and `no-restricted-imports` without depending on the TypeScript API. `tsc` is TypeScript 7; the TS 6 API (`@typescript/typescript6`) is used only for reading interface declarations. pnpm is required (not npm): npm links `@typescript/typescript6`'s transitive `tsc` over TypeScript 7's.

## 8. Risks and open questions

- **Concept granularity.** Too fine becomes pseudocode; too coarse under-specifies. Settled by using the card game, not up front.
- **Test-approval fatigue.** If every regeneration needs re-approval, developers will rubber-stamp. Tests regenerate whenever their concept changes (the test writer sees the whole concept), so any concept edit means re-approving that concept's tests; `ccc stats` should track approval frequency.
- **Prose ambiguity in syncs.** Conditions live in prose; if handlers misread them often, a structured `where` clause may be needed.
- **Whole-project `tsc` per attempt** may be slow as projects grow; acceptable for v1, revisit with incremental `tsc --build` if needed.
- **Generated auth code** is a security risk outside the prototype.
