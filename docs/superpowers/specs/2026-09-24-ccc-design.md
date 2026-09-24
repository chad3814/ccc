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
- **`when`**: one action, written `<concept-id>#<exported-member>` (`#` keeps concept IDs and member names unambiguous), that exists in a visible concept's interface.
- **`then`**: one or more actions in the same form.
- **Action resolution:** `<concept-id>#<member>` resolves to an exported function named `<member>` in that concept's interface, or else a method named `<member>` on the concept's *primary class*: the exported class whose name is the PascalCase form of the ID's last segment (`game.players` → `Players`, `game-store` → `GameStore`).
- **Conditions and argument mapping** are prose in Rules/Examples; the LLM generates a handler `(triggerArgs, triggerResult, targets) => Promise<void>` that decides whether and how to invoke the `then` actions.
- **Wiring is deterministic.** ccc generates a wrapper for each concept that is the `when` of any sync; after the wrapped action succeeds, the wrapper invokes matching sync handlers in file-path order.
- **Synchronous and atomic.** Syncs run inside the triggering operation. If any handler or `then` action throws, the whole operation throws; when an endpoint wraps it in `withTransaction`, persistence rolls back.
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
    wiring.ts        sync wrappers (deterministic)
    server.ts        composition root (deterministic)
    schema.sql       combined store DDL (deterministic)
  interfaces/        emitted .d.ts files (deterministic, committed)
  manifest.json      keys, hashes, approvals, generation stats
```

Generated output is committed, so fresh clones and CI never regenerate.

`ccc.config.ts` exports:

```ts
export default defineConfig({
  models: { impl: 'claude-opus-5-5', tests: 'claude-opus-5-5' },
  maxAttempts: 3,
  concurrency: 4,
});
```

### 3.2 Cache keys

A concept's key includes its dependencies' **interfaces**, never their implementations or prose (separate compilation). Editing `game.player.hand`'s Rules regenerates `hand` only; `game` is untouched unless `hand`'s interface changes.

| Artifact | Key = SHA-256 of |
|---|---|
| Tests | own interface + Intent + Examples + dependency interfaces + test prompt version + test model + runtime version |
| Implementation | normalized concept file + dependency interfaces + current test file hash + impl prompt version + impl model + runtime version |
| Sync handler | normalized sync file + `when`/`then` interfaces + current test file hash + prompt version + model + runtime version |

- **Normalization:** frontmatter re-serialized with sorted keys; Markdown trailing whitespace trimmed and line endings normalized. Formatting-only edits do not invalidate.
- **Prompt version** = hash of the prompt template file shipped with ccc. **Runtime version** = `@ccc/runtime` package version.
- Changing a model in config invalidates everything it produced; model upgrades are explicit, visible rebuilds.

### 3.3 Manifest

`.ccc/manifest.json` records, per concept:

- `testKey`, `testFileHash`, `approvedTestHash` (null if pending)
- `implKey`, `implFileHash` (absent for handwritten)
- `history`: one entry per generation: artifact (`tests` | `impl`), timestamp, model, attempts, input/output tokens, cost (USD), duration, outcome (`passed` | `failed`)

Written atomically (write temp file, rename).

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
| `ccc build [id] [--dry-run]` | Pipeline (3.4) | yes |
| `ccc tests [id]` | Stage 3 only | yes |
| `ccc approve [id]` | Shows each pending test file (diff against last approved), records approval on confirmation | no |
| `ccc verify` | CI gate (6) | no |
| `ccc stats` | First-attempt pass rate, mean attempts, cost per concept and per build, from manifest history | no |
| `ccc regen --compare <id>` | Regenerates the implementation ignoring cache into a temp dir; reports approved-test pass/fail and diff size vs committed; does not write | yes |
| `ccc db reset` | Drops and recreates the dev database from `schema.sql` using `DATABASE_URL` | no |

## 4. Generation and verification

### 4.1 Implementation context (exactly this, nothing else)

- Versioned system prompt: implement exactly the declared interface, no extra exports; strict TypeScript, no `any`; only the imports allowed for this kind (4.3); use `@ccc/runtime` error types and helpers.
- The concept's full file (Intent, Rules, Examples, Decisions, interface).
- The `.d.ts` of every dependency (including an aggregate's children), with the import paths to use.
- The concept's current test file.

### 4.2 Output

The model returns code through a tool call `write_module({ code: string })`. ccc prepends a deterministic header:

```ts
// @generated by ccc from concept game.player.hand (key 3f2a91…). Do not edit.
```

### 4.3 Allowed imports per kind (enforced by oxlint `no-restricted-imports`, not by the prompt)

| Kind | Allowed |
|---|---|
| domain kinds | dependency modules, `@ccc/runtime` |
| `store` | + `pg` |
| `endpoint` | + `hono`, `zod` |
| `auth` | + `hono` (types), Web Crypto (global) |
| `sync` | `when`/`then` modules, `@ccc/runtime` |

Also enforced by lint in all generated code: `typescript/no-explicit-any`, no Node built-ins in domain kinds.

### 4.4 Test generation (independent pass)

- Context: Intent, Examples, own interface, dependency interfaces. **Never an implementation, never the Rules.** The examples are the specification.
- Each example bullet becomes exactly one Vitest test named `[ex N] <summary>` (N is the 1-based bullet index). ccc parses the returned file and rejects it if the set of `[ex N]` names does not equal `1..count(examples)`; this counts as a failed attempt.
- Test failures map directly back to example bullets.
- Adapter tests are hermetic: stores run against PGlite; endpoints run through Hono `app.request()` with PGlite-backed stores; auth likewise.
- Test generation retries only on parse/count/type errors (it cannot run against a missing implementation); it has its own `maxAttempts`.

### 4.5 Repair loop (per implementation)

1. Generate into a temp directory overlaying `.ccc/gen`.
2. Run `tsc --noEmit` (whole project with the candidate in place), then oxlint on the candidate, then Vitest on the concept's tests.
3. On failure, send trimmed diagnostics (first 50 errors, file/line/message) back in the same conversation; retry up to `maxAttempts`.
4. On success, write atomically to `.ccc/gen`; update the manifest.
5. On exhaustion, the concept fails. **Failing output is never written**; the last good version stays. Dependents are skipped for this build; unrelated concepts continue. The report names the concept and the failing `[ex N]` examples.

### 4.6 Handwritten concepts

No generation. The `source` module is re-exported from the concept's `.ccc/gen` path so dependents import it identically, and it goes through the same `tsc`, oxlint, and approved-test checks. Its tests are generated and approved like any other concept's.

## 5. Runtime and adapters

### 5.1 `@ccc/runtime`

Small, hand-written, tested normally; its version is part of every cache key.

- `withTransaction<T>(pool, fn: (tx: Tx) => Promise<T>): Promise<T>` — unit of work.
- Sync dispatcher used by generated wrappers.
- Error base classes: `DomainError`, `NotFound`, `Conflict`, `Unauthorized`, `Invalid`; default HTTP mapping (404, 409, 401, 400; anything else 500).
- `defineConfig` for `ccc.config.ts`.

### 5.2 Composition root (`.ccc/gen/server.ts`, deterministic)

- `createApp({ pool }): Hono` — instantiates stores and auth, wraps domain concepts with their syncs, mounts all endpoints on one Hono app.
- `main()` — reads `DATABASE_URL`, serves with `@hono/node-server`. Run with `tsx .ccc/gen/server.ts`.
- Tests call `createApp` with a PGlite-backed pool.

### 5.3 Adapter kinds

- **`store`**: persists one aggregate (`persists`). Declares its table DDL in a fenced `sql` block under a `## Schema` section (a store-only section, added to the allowed sections for `store`). ccc concatenates all store DDL into `schema.sql` in topological order. Store methods take a `Tx` and run inside the caller's transaction.
- **`endpoint`**: authenticate via the `auth` concept, validate input with zod, call one entry action inside `withTransaction` (making syncs atomic with persistence), save, respond. Examples are HTTP-level: `POST /games/:id/play with a card not in hand → 409`.
- **`auth`**: interface must include `authenticate(request: Request): Promise<Identity | null>`; may declare further actions (`signup`, `login`, `logout`). For the card game: email + password, PBKDF2 via Web Crypto, sessions in Postgres. **Generated security code; acceptable for a prototype only.**

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
- **Test-approval fatigue.** If every regeneration needs re-approval, developers will rubber-stamp. Tests regenerate only when interface, Intent, or Examples change, which should keep approvals rare; `ccc stats` should track approval frequency.
- **Prose ambiguity in syncs.** Conditions live in prose; if handlers misread them often, a structured `where` clause may be needed.
- **Whole-project `tsc` per attempt** may be slow as projects grow; acceptable for v1, revisit with incremental `tsc --build` if needed.
- **Generated auth code** is a security risk outside the prototype.
