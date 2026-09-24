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
| `.ccc/gen/<id>.test.ts` | Tests, one per example, written from the interface, Intent, and Examples only | yes |
| `.ccc/gen/<id>.ts` | Implementation (or a re-export of a handwritten source) | yes (no for handwritten) |
| `.ccc/interfaces/<id>.d.ts` | Each concept's interface; syncs get a synthesized one | no |
| `.ccc/gen/<id>.contract.d.ts` | The interface again, beside the module, so its imports resolve to the generated dependencies | no |
| `.ccc/conformance/<id>.ts` | Compile-time proof the module matches its contract, with no extra exports | no |
| `.ccc/package.json`, `.ccc/.gitignore` | ESM marker; ignores `.ccc/.tmp/` scratch space | no |
| `.ccc/manifest.json` | Cache keys, approvals, file hashes, generation history | no |

Never edit these files. `ccc verify` names any file that changed since the build.

## When things regenerate

- **Tests** regenerate when a concept's interface, Intent, or Examples change, or a dependency's interface changes. New tests need approval again.
- **Implementations** regenerate when anything in the concept changes (Rules and Decisions included), when a dependency's interface changes, or when the tests change.
- A dependency's Rules, Decisions, or implementation never trigger regeneration: concepts depend on interfaces only.
- Changing a model or upgrading ccc (its prompts) invalidates everything that model or prompt produced.

## How generation works

Each artifact gets one conversation with Claude. The generated code is checked, and every problem goes back as feedback, up to `maxAttempts` times.

- **Tests** must have exactly one `it('[ex N] …')` per example, import only allowed modules, and type-check against the interfaces.
- **Implementations** are written into `.ccc/gen` and must pass all of these:
  - import only dependencies and the packages allowed for their kind;
  - type-check, including the conformance file;
  - lint clean (no `any`);
  - pass their tests.

  A failing implementation is never kept; the previous version is restored.

Requests use `claude-opus-5` with adaptive thinking and server-side refusal fallbacks (`fallbacks: "default"`).

## Configuration

`ccc.config.ts` in the project root is optional:

```ts
export default {
  models: { impl: 'claude-opus-5', tests: 'claude-opus-5' },
  maxAttempts: 3,       // implementation attempts per build
  testMaxAttempts: 3,   // test attempts per build
  concurrency: 4,       // parallel generations within a stage
};
```

## Measuring

- `ccc stats` shows first-attempt pass rates, mean attempts, and cost per artifact type and per concept.
- `ccc regen --compare <concept>` regenerates one implementation while ignoring the cache, checks it against the approved tests, and reports how many lines differ from the committed version. It writes nothing.
