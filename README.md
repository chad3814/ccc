# ccc: chris-chad-concepts

Write software as a structured **concept model** (Markdown + YAML under `concepts/`) and let ccc compile it into TypeScript. The concept model is the only source of truth; generated code is a read-only build artifact.

Status: research prototype. Only `ccc check` exists so far.

- Design: [docs/superpowers/specs/2026-09-24-ccc-design.md](docs/superpowers/specs/2026-09-24-ccc-design.md)
- Writing concepts: [docs/schema.md](docs/schema.md)
- Example model: [packages/cli/test/fixtures/card-game](packages/cli/test/fixtures/card-game)

## Development

```bash
corepack enable pnpm
pnpm install
pnpm verify          # lint, typecheck, test, build
node packages/cli/dist/bin.js check -C packages/cli/test/fixtures/card-game
```
