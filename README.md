# ccc: chris-chad-concepts

Write software as a structured **concept model** (Markdown + YAML under `concepts/`) and let ccc compile it into TypeScript. The concept model is the only source of truth; generated code is a read-only build artifact.

Status: research prototype. The full pipeline works; the card-game example in `examples/card-game` is modeled and checks clean, and generating it needs Claude credentials (see its README).

- Design: [docs/design.md](docs/design.md)
- Writing concepts: [docs/schema.md](docs/schema.md)
- Building and CI: [docs/building.md](docs/building.md)
- Runtime and adapters: [docs/runtime.md](docs/runtime.md)
- Example: [examples/card-game](examples/card-game)
- Example model: [packages/cli/test/fixtures/card-game](packages/cli/test/fixtures/card-game)
- Original spec and plans: [docs/superpowers](docs/superpowers)

## Installing

ccc is published to npm as `@chchco/cli` and `@chchco/runtime`. Generated code imports the runtime as `@ccc/runtime`, so install it under that name with an npm alias:

```bash
npm install @ccc/runtime@npm:@chchco/runtime
npm install --save-dev @chchco/cli
npx ccc check
```

Projects with adapters also need the packages their kinds import: `pg` for stores, `hono` and `zod` for endpoints and auth.

## Development

```bash
corepack enable pnpm
pnpm install
pnpm verify          # lint, typecheck, test, build
node packages/cli/dist/bin.js check -C packages/cli/test/fixtures/card-game
```

## Releasing

CI (`.github/workflows/ci.yml`) runs `pnpm verify` on every pull request and every push to `main`. After CI passes on `main`, the release workflow packs both packages and uploads the tarballs as an artifact. Any package whose `package.json` version is not on npm yet gets published and tagged (`runtime-v0.2.0`, `cli-v0.2.0`). To release, bump the version in a pull request. When the runtime's version changes, the CLI needs a new version too, because it depends on the runtime's exact version.

Publishing uses npm trusted publishing (OIDC); no npm token is stored in GitHub. Each package's settings on npmjs.com must list this repository and the `release.yml` workflow as a trusted publisher.
