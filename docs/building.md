# Building with ccc

`ccc build` turns concepts into tested TypeScript under `.ccc/`. Everything it writes is committed to git, so clones and CI never need to regenerate.

## Workflow

```bash
ccc check                       # validate concepts (no LLM)
ccc build --dry-run             # show what would be generated
op run -- ccc build             # generate; needs ANTHROPIC_API_KEY or `ant auth login`
ccc approve                     # read each new test file and approve it
ccc verify                      # CI gate: current, approved, passing (no LLM)
git add concepts .ccc && git commit
```

`ccc tests [concept]` generates tests only. `ccc build <concept>` limits the build to one concept and whatever it depends on.

## What gets generated

| Path | What | LLM? |
|---|---|---|
| `.ccc/gen/<id>.test.ts` | Tests, one per example, written from the concept and its dependencies' interfaces (never an implementation) | yes |
| `.ccc/gen/<id>.ts` | Implementation (or a re-export of a handwritten source) | yes (no for handwritten) |
| `.ccc/interfaces/<id>.d.ts` | Each concept's interface; syncs get a synthesized one | no |
| `.ccc/gen/<id>.contract.d.ts` | The interface again, beside the module, so its imports resolve to the generated dependencies | no |
| `.ccc/conformance/<id>.ts` | Compile-time proof the module matches its contract, with no extra exports | no |
| `.ccc/gen/wiring.ts`, `server.ts`, `main.ts`, `schema.sql`, `schema.ts` | Sync wiring, the composition root, the Node entry point, and the combined schema (see [runtime.md](runtime.md)) | no |
| `.ccc/package.json`, `.ccc/.gitignore` | ESM marker; ignores `.ccc/.tmp/` scratch space | no |
| `.ccc/manifest.json` | Cache keys, approvals, file hashes, generation history | no |

Never edit these files. `ccc verify` names any file that changed since the build.

## When things regenerate

- **Tests** regenerate when anything in the concept changes, or a dependency's interface changes. New tests need approval again.
- **Implementations** regenerate when anything in the concept changes (Rules and Decisions included), when a dependency's interface changes, or when the tests change.
- A dependency's Rules, Decisions, or implementation never trigger regeneration: concepts depend on interfaces only.
- Changing models or ccc's prompts regenerates nothing: code that passes its approved tests stays current, whichever model wrote it. Upgrading `@ccc/runtime` invalidates everything.
- `ccc build --fresh [id]` regenerates implementations even when they're current (all of them, or just `id`; its dependencies still follow the cache). Tests are kept. `ccc tests --fresh [id]` regenerates tests, which then need approval again.
- To regenerate one concept's tests by hand (say a generated test is wrong), delete `.ccc/gen/<id>.test.ts` and run `ccc tests <id>`. When every implementation attempt that runs the tests fails the same unapproved test, the build error says so and points at the test file.
- A build writes the manifest when it finishes. If you interrupt it, work generated so far stays on disk but is regenerated next time.

## How generation works

Each artifact gets one conversation with Claude. The generated code is checked, and every problem goes back as feedback, up to `maxAttempts` times.

- **Tests** must have exactly one `it('[ex N] …')` per example, import only allowed modules, and type-check against the interfaces.
- **Implementations** are written into `.ccc/gen` and must pass all of these:
  - import only dependencies and the packages allowed for their kind;
  - type-check, including the conformance file;
  - lint clean (no `any`);
  - pass their tests.

  A failing implementation is never kept; the previous version is restored.

### Model escalation

Each artifact starts on a cheaper model and moves up when it keeps failing. By default implementations start on `claude-haiku-4-5` and tests on `claude-sonnet-5`, both capped at `claude-opus-5`. After every `escalateAfter` (default 2) failed attempts, the next attempt runs on the next model up the ladder, and the conversation continues, so the stronger model sees the earlier attempts and their problems. `maxAttempts` counts attempts across all models: with `maxAttempts: 8`, an implementation gets Haiku twice, Sonnet twice, then Opus four times. Every generation starts again at `start`.

Request settings depend on the model of each turn. `claude-opus-5`, Opus 5.5, and Fable get adaptive thinking and server-side refusal fallbacks (`fallbacks: "default"`); Sonnet 5 and the Opus 4.6–4.8 family get adaptive thinking; `claude-haiku-4-5` gets a 16,000-token thinking budget; any other model gets neither setting.

The SDK retries rate limits up to 6 times, honoring `retry-after`. If the generator still can't serve requests (a persistent rate limit, bad credentials, or an unknown model), the build stops at once with one message saying which, and completed work is kept. A 429 with no rate-limit headers usually means your organization has no allowance for that model; check the console under Settings → Limits, or pick another model:

```ts
export default { models: { impl: 'claude-haiku-4-5', tests: 'claude-haiku-4-5' } }; // fixed models, no escalation
```

## Configuration

`ccc.config.ts` in the project root is optional:

```ts
export default {
  models: {
    impl: { start: 'claude-haiku-4-5', cap: 'claude-opus-5' },  // or a plain name for one fixed model
    tests: { start: 'claude-sonnet-5', cap: 'claude-opus-5' },
  },
  ladder: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1'],  // weakest to strongest
  escalateAfter: 2,     // failed attempts on one model before moving up
  maxAttempts: 6,       // implementation attempts per build, across all models (a warning says if they can't reach the cap)
  testMaxAttempts: 3,   // test attempts per build
  concurrency: 4,       // parallel generations within a stage
};
```

## Measuring

- `ccc stats` shows first-attempt pass rates, mean attempts, escalations, and cost per artifact type, per concept, and by the model that finished each generation (its cost includes the weaker models it escalated from).
- `ccc regen --compare <concept>` regenerates one implementation while ignoring the cache, checks it against the approved tests, and reports how many lines differ from the committed version. It writes nothing.
