# ccc (chris-chad-concepts)

Compiles concept models (Markdown + YAML frontmatter under `concepts/`) into TypeScript.
Design: `docs/superpowers/specs/2026-09-24-ccc-design.md`. Schema reference: `docs/schema.md`.

## Commands
- `pnpm install`: install (pnpm only, never npm; enable with `corepack enable pnpm`)
- `pnpm verify`: lint + build + typecheck + test; must pass before any commit (the CLI resolves `@ccc/runtime` from `packages/runtime/dist`, so build comes first)
- `pnpm --filter @chchco/cli exec vitest run <pattern>`: run a subset of CLI tests (run `pnpm build` first)

## Conventions
- TypeScript strict; never write `any` or `unknown` (validate with zod)
- 2-space indent, semicolons always, ESM, `.js` extensions on relative imports, `import type` for types
- Async APIs only; no `*Sync`
- Lint is oxlint (typescript-eslint doesn't support TS 7)
- User-facing problems are returned as `Diagnostic[]`, never thrown
- Tests live in `packages/*/test/`
- Tests never call the Claude API; use `test/fake-generator.ts` and `test/pipeline-fixture.ts`
- Build-pipeline tests run the real tsc/oxlint/Vitest toolchain
- `pnpm --filter @chchco/cli test:live` builds a concept with the real API (costs money; not part of `pnpm verify`)
