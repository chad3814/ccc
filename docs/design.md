# Design

Why ccc works the way it does, and how its pieces fit together. For the details of each piece, see [writing-concepts.md](writing-concepts.md) (writing concepts well), [schema.md](schema.md) (the concept format), [building.md](building.md) (the build, approval, and CI), and [runtime.md](runtime.md) (adapters and syncs at run time).

## The idea

LLM chat sessions are becoming a higher-level programming language, but they aren't reproducible, reproducing them costs money, and keeping only the generated code throws away the reasoning behind it. ccc tries something else: developers edit a structured **concept model**, plain-text files in git that are the only source of truth, and ccc compiles it into TypeScript. Generated code is a build artifact: cached, committed, and regenerated when its inputs change.

ccc is a research prototype, built to answer one question:

> Can code regenerated from concepts and examples reliably pass independently approved tests, at an acceptable cost per change, with stable output across regenerations?

The card game in [examples/card-game](../examples/card-game) is the test case. It has auth, a lobby, dealing by sync, play, and a leaderboard.

## Principles

- **One source of truth.** Developers edit concepts, never generated code. Hand-written code is allowed only as a concept (`implementation: handwritten`), still bound by its interface and examples. Mixed sources of truth are what sank model-driven development.
- **Equivalence, not determinism.** Regenerated code doesn't have to match byte for byte; it has to pass the concept's approved tests. Whichever model wrote it, passing code is current.
- **Generated code is a build cache.** Keyed by content hashes, committed to git, regenerated only when its inputs change. Clones and CI never call the LLM.
- **Deterministic wherever possible.** Validation, wiring, composition, and enforcement never involve an LLM. Only implementations, sync handlers, and tests are generated.

## Concepts

A concept is a Markdown file with YAML frontmatter: a TypeScript `interface`, then `## Intent`, `## Rules`, `## Examples`, and `## Decisions`. The Examples become tests. The Decisions go into every generation, so the reasoning travels with the code.

- **IDs come from paths, and containment is directories.** `concepts/game/player/hand.md` is `game.player.hand`, a child of `game.player`. Visibility is lexical, like nested scopes. A concept sees its ancestors, its children, its siblings, and its ancestors' siblings. Anything deeper is private. An invariant goes on the lowest concept that can see everything it mentions.
- **Domain and adapter kinds are separate.** `value`, `entity`, `collection`, and `aggregate` are pure. `store`, `endpoint`, and `auth` do I/O. Domain concepts may never depend on adapters, which keeps the domain testable without a database or a server.
- **Syncs connect concepts without coupling them.** Following Daniel Jackson's concept design, a sync says "when this action succeeds, invoke those actions" (`when: game.players#join`, `then: [game#deal]`). The dependency lives in the sync, so `game.players` never learns about `game`. That's also how a domain concept reaches an adapter (`game#finish` → `leaderboard-store#record`) and stays pure.
- **Interfaces are the contract between concepts.** A concept depends on its dependencies' interfaces only, never their implementations or prose. That's separate compilation. Editing `hand`'s Rules regenerates `hand` and nothing else, unless its interface changes.

The full format is in [schema.md](schema.md).

## The pipeline

```
concepts/ ──check──▶ interfaces ──plan──▶ tests ──approve──▶ implementations ──▶ composition ──▶ full suite
            (no LLM)   (no LLM)  (keys)   (LLM)   (human)       (LLM, repair loop)   (no LLM)       (no LLM)
```

1. **Check** (`ccc check`) validates everything that can be checked without an LLM: frontmatter, visibility, cycles, the domain/adapter rule, sync actions, adapter conventions. It emits every interface as a `.d.ts` and type-checks them together. A build never spends money on a model that doesn't check.
2. **Plan** computes each artifact's cache key and compares it with the manifest.
3. **Tests** are generated from the whole concept and its dependencies' interfaces, one test per example, then approved by a person (`ccc approve`).
4. **Implementations** are generated level by level in dependency order, each checked against its approved tests in a repair loop.
5. **Composition** files are written deterministically: sync wiring, the server, the Node entry point, the combined SQL schema.
6. **The full suite** runs, exercising syncs and endpoints end to end.

`ccc verify` is the CI gate. With no LLM call, it confirms that everything is current, unedited, approved, and passing. [building.md](building.md) has the commands and the files each stage writes.

## Tests are written independently

The test writer never sees an implementation. It works from the concept (Intent, Rules, Examples, Decisions, Schema) and the interfaces of everything the concept depends on. The independence that matters is from the implementation. The Rules are specification: when they were hidden, tests had to guess at things the concept states, such as request shapes and turn order.

- Each example bullet becomes exactly one test named `[ex N] …`, so a failing test points straight back to a bullet. A file with any other set of tags is rejected.
- Tests must assert only what their example states, and must never assume what seeded or random setup produces.
- **Approval is the human gate.** Generated tests start pending. Implementations can be generated against pending tests, but `ccc verify` fails until each test file is approved. The approved hash is recorded, so a changed test needs approving again.

## Implementations are repaired, not trusted

Each implementation gets one conversation with the model. A candidate is checked, and every problem goes back as feedback:

1. **Before writing:** reject disallowed imports and exports the interface doesn't declare. Allowed imports per kind are enforced by ccc's import scanner, not by asking nicely in the prompt. Domain code can't import `pg`, and nothing can import Node built-ins.
2. **In place:** write the module into `.ccc/gen`, then run `tsc` (including a conformance check against the interface), oxlint (no `any`), and the concept's tests. Skipped tests count as failures.
3. **On failure:** put the previous module back at once, so `.ccc/gen` never holds a failing candidate, and retry with the problems.

**Conformance** compares the module with a contract file, a copy of the interface placed beside the module. Values must be assignable in both directions with no extra exports, and exported types must be identical. The contract has to sit beside the module because classes with private members compare nominally. The `Hand` in `interfaces/hand.d.ts` and the `Hand` in `gen/hand.ts` are different types. A copy next to the module resolves its imports to the same generated dependencies.

When attempts run out, or the generator errors, the concept fails. The last good version stays, its dependents are skipped for this build, and unrelated concepts carry on. If the generator can't serve anything (a persistent rate limit, bad credentials, an unknown model), the build stops at once with one message.

## Models escalate

Cheap models write most code correctly, and expensive ones are needed only sometimes. Each artifact therefore starts low on a model ladder and climbs when it keeps failing. By default implementations start on Haiku and tests on Sonnet, and both stop at Opus. After every `escalateAfter` failed attempts (default 2), the next attempt runs on the next model up.

- The conversation continues, so the stronger model sees every earlier attempt and what was wrong with it.
- Request settings follow the model of each turn. Current frontier models get adaptive thinking and, where offered, server-side refusal fallbacks. Haiku gets a thinking budget.
- Every generation starts again at the bottom. Nothing is remembered between builds; `ccc stats` shows which concepts keep climbing.

## Cache keys

| Artifact | Key = SHA-256 of |
|---|---|
| Tests | the normalized concept + its interface + interfaces of all transitive dependencies + runtime version |
| Implementation | the normalized concept + direct dependencies' interfaces + the test file's hash + runtime version |

- Normalization sorts frontmatter keys and trims whitespace, so formatting-only edits don't regenerate anything.
- **Models and prompts are deliberately not in the key.** Code is current because it passes its approved tests, not because a particular model or prompt wrote it. Switching models or upgrading ccc's prompts leaves passing code alone. `ccc build --fresh` and `ccc tests --fresh` regenerate on purpose.
- The runtime version is in the key because generated code is written against the runtime's API.

`.ccc/manifest.json` holds the keys, the approvals, a hash of every file ccc wrote, and a history of every generation (model, attempts, escalations, tokens, cost, outcome). The file hashes make hand edits to generated code visible to the next build and to `ccc verify`. The history feeds `ccc stats`.

## Running the generated code

Generated services use `@ccc/runtime`, a small hand-written library. It provides:
- HTTP error types;
- a `Database` abstraction over `pg`, plus in-memory PGlite for tests;
- **scopes**, which carry sync work through a request.

Composition is deterministic:

- **`wiring.ts`** patches each sync's trigger method, which is why a sync's `when` must be a method of the concept's primary class. After the method succeeds, the sync's handler is deferred into the current scope. `withScope` waits for every handler, including syncs triggered by syncs, and rethrows the first failure. Endpoints respond only after it resolves.
- **`server.ts`** builds each store and auth adapter once, binds them by concept id, and tries endpoints in order. An endpoint answers routes it doesn't own with `unmatched()`, so concepts describe only their own routes.
- **Syncs aren't transactional yet.** Adapters are bound to the app's `db`, so a failing sync fails the request but doesn't undo writes already made.
- **No migrations.** When store SQL changes, `ccc db reset` rebuilds the development database.

[runtime.md](runtime.md) has the conventions each adapter kind must follow.

## The repository

```
packages/cli/        the ccc command, published as @chchco/cli
packages/runtime/    the runtime, published as @chchco/runtime (imported as @ccc/runtime)
examples/card-game/  the acceptance test: 16 concepts and their committed .ccc/
docs/                these documents; docs/superpowers/ holds the original spec and plans
```

The CLI's modules group by stage:

| Stage | Modules |
|---|---|
| Reading concepts | `parse` (frontmatter and sections), `load` (IDs from paths), `schema` (zod schemas per kind: the executable definition of the format) |
| Checking | `check` (runs every rule), `graph` and `cycles` (visibility, references, cycles), `syncs`, `adapters`, `imports` (the import scanner), `interfaces` and `typecheck` (emit and type-check `.d.ts` files) |
| Planning | `keys`, `hash`, `versions`, `manifest`, `order` (dependency levels) |
| Generating | `context` (what each request contains), `generation` (the attempt loop and escalation), `testgen`, `implgen`, `llm` (the `Generator` interface), `anthropic` (the Claude implementation), `pricing` |
| Checking output | `toolchain` (`tsc`, oxlint, and Vitest as child processes), `tsc` |
| Composing | `emit`, `compose`, `synciface` (the interface synthesized for each sync), `layout` (paths under `.ccc/`) |
| Commands | `cli`, `build`, `verify`, `approve`, `regen`, `stats`, `dbreset` |

Tests never call the Claude API. A scripted `FakeGenerator` stands in, and pipeline tests run the real `tsc`, oxlint, and Vitest against temporary projects. `pnpm --filter @chchco/cli test:live` makes a real build of a tiny project and costs money.

### Tooling choices

- **TypeScript 7** compiles everything. Its compiler API isn't available yet, so reading interface declarations uses the TypeScript 6 API (`@typescript/typescript6`). That use is isolated in `interfaces`.
- **oxlint**, not typescript-eslint, which doesn't support TypeScript 7.
- **pnpm**, not npm. npm links TypeScript 6's `tsc` over TypeScript 7's.
- **Secrets:** ccc never reads `ANTHROPIC_API_KEY` itself; the Anthropic SDK does. It never logs it or writes it anywhere.

## Out of scope

Parameterized concept templates; mechanical checking of where invariants are placed; asynchronous or eventual syncs; background jobs; live data migrations; deployment; a visual concept editor; agent-based generation.

## Open questions

- **Concept granularity.** Too fine becomes pseudocode; too coarse under-specifies. The card game is how we find out.
- **Test-approval fatigue.** Tests regenerate whenever their concept changes, so every concept edit means re-approving that concept's tests. If approval becomes rubber-stamping, the human gate is worthless.
- **Prose conditions in syncs.** If handlers often misread conditions written in prose, syncs may need a structured `where` clause.
- **Type-checking cost.** Every attempt runs `tsc`; larger projects may need incremental builds.
- **Generated auth code** is acceptable in a prototype and nowhere else.
