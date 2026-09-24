# ccc Plan 2: Build Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ccc build` / `tests` / `approve` / `verify` / `stats` / `regen --compare` turn a checked concept model into generated, tested TypeScript under `.ccc/`, cached by content keys, with every LLM call going through a replaceable `Generator`.

**Architecture:** Pure modules compute keys (`keys`), paths (`layout`), synthesized sync interfaces (`synciface`), import rules (`imports`) and prompts (`context`). Side-effecting modules run the TS 7 / oxlint / Vitest toolchain (`toolchain`), call Claude (`anthropic`), and write files (`fsutil`, `emit`, `manifest`). `generation` runs the send → check → feedback loop shared by `testgen` and `implgen`. `build` orchestrates the stages from spec §3.4. Tests use a scripted `FakeGenerator` and a four-concept pipeline fixture; they run the real toolchain.

**Tech Stack:** Plan 1's stack plus `@anthropic-ai/sdk` 0.128 (beta Messages API, streaming, strict tool use, `fallbacks: 'default'`), Vitest 5 run as a child process with the JSON reporter, oxlint 1 with `-f json`, TypeScript 7 `tsc` via Plan 1's `tsc.ts`.

**Spec:** `docs/superpowers/specs/2026-09-24-ccc-design.md` (§3, §4, §6, §7). Plan 1 (`docs/superpowers/plans/2026-09-24-ccc-plan-1-foundation-and-check.md`) is complete on branch `plan-1-foundation`.

**Plan series:** Plan 2 of 4. Plan 3 adds `@ccc/runtime`, adapter wiring, the composition root and `db reset`; Plan 4 builds the card game.

**Where to work:** worktree `worktrees/plan-2-build` on branch `plan-2-build`, which starts at `plan-1-foundation`'s head.

## Global Constraints

- Everything in Plan 1's Global Constraints still applies (Node ≥24, pnpm only, strict TS with no `any`/`unknown`, 2-space indent, semicolons, async APIs only, oxlint, `Diagnostic[]` for user errors, `pnpm verify` green after every task).
- Default model: `claude-opus-5` for both implementation and tests (configurable in `ccc.config.ts`).
- Every Claude request: `client.beta.messages.stream(...).finalMessage()`, `max_tokens: 64000`, `thinking: { type: 'adaptive' }`, `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`, one strict tool `write_module({ code })`, `tool_choice: { type: 'auto' }`. Check `stop_reason` (`refusal`, `max_tokens`) before reading content. Append the whole `content` array on every turn.
- `ANTHROPIC_API_KEY` (or an `ant auth login` profile) is read only by the SDK; ccc never reads, logs or stores it.
- Generated artifacts live under `.ccc/`: `gen/` (modules and tests), `interfaces/` (`.d.ts`), `conformance/`, `package.json` (`{"type":"module"}`), `.gitignore` (`.tmp/`), `manifest.json`. Scratch work happens in `.ccc/.tmp/` and is always removed.
- ccc's own tests never call the real API; they use `FakeGenerator`.

## Review Focus

1. A generated module that type-checks and passes its tests but exports an extra value or a mismatched signature. The conformance file must fail it. Tested in Task 12.
2. A build interrupted after writing some files. The next build must regenerate anything whose file hash no longer matches the manifest, and never trust a half-written module. Tested in Task 13 ("regenerates a module edited or removed since the last build").
3. A generation failure part-way through a level. The previous good module must stay on disk, dependents are skipped, and unrelated concepts still build. Tested in Task 13.
4. Hand edits to generated or test files. `verify` must name each modified, missing, or unrecorded file, and `approve` must refuse a test file edited since generation. Tested in Task 15.
5. A Claude reply with no tool call, a truncated tool call, or a refusal. It counts as a failed attempt with a clear note, and any open `tool_use` gets a `tool_result` on the next turn. Tested in Task 8.

---

### Task 1: Config, pricing, and hashing

**Files:**
- Create: `packages/cli/src/config.ts`, `packages/cli/src/pricing.ts`, `packages/cli/src/hash.ts`
- Test: `packages/cli/test/config.test.ts`, `packages/cli/test/pricing.test.ts`, `packages/cli/test/hash.test.ts`

**Interfaces:**
- Consumes: `error`, `Diagnostic` (Plan 1 `diagnostics.ts`); `Concept` (Plan 1 `parse.ts`); test helpers `writeProject`, `concept` (Plan 1 `test/helpers.ts`).
- Produces:
  - `config.ts`: `DEFAULT_MODEL = 'claude-opus-5'`; `CONFIG_FILE = 'ccc.config.ts'`; `configSchema`; `type Config = { models: { impl: string; tests: string }; maxAttempts: number; testMaxAttempts: number; concurrency: number }`; `interface ConfigResult { config: Config; diagnostics: Diagnostic[] }`; `loadConfig(root: string): Promise<ConfigResult>`
  - `pricing.ts`: `interface Price { inputPerMTok: number; outputPerMTok: number }`; `PRICES`; `costUsd(model: string, inputTokens: number, outputTokens: number): number | null`
  - `hash.ts`: `type JsonValue`; `stableStringify(value: JsonValue): string`; `sha256(text: string): Promise<string>` (lowercase hex); `normalizeConcept(concept: Concept): string`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, loadConfig } from '../src/config.js';
import { writeProject } from './helpers.js';

describe('loadConfig', () => {
  it('returns defaults when there is no config file', async () => {
    const root = await writeProject({ 'concepts/.keep': '' });
    expect(await loadConfig(root)).toEqual({
      config: { models: { impl: DEFAULT_MODEL, tests: DEFAULT_MODEL }, maxAttempts: 3, testMaxAttempts: 3, concurrency: 4 },
      diagnostics: [],
    });
  });

  it('merges a partial config with the defaults', async () => {
    const root = await writeProject({
      'ccc.config.ts': "export default { maxAttempts: 5, models: { impl: 'claude-sonnet-5' } };\n",
    });
    const { config, diagnostics } = await loadConfig(root);
    expect(diagnostics).toEqual([]);
    expect(config).toEqual({
      models: { impl: 'claude-sonnet-5', tests: DEFAULT_MODEL },
      maxAttempts: 5,
      testMaxAttempts: 3,
      concurrency: 4,
    });
  });

  it('reports invalid values and unknown keys', async () => {
    const root = await writeProject({ 'ccc.config.ts': 'export default { maxAttempts: 0, retries: 2 };\n' });
    const { diagnostics } = await loadConfig(root);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^maxAttempts: /), expect.stringMatching(/^config: .*retries/)]),
    );
    expect(diagnostics.every((d) => d.file === 'ccc.config.ts')).toBe(true);
  });

  it('reports a config file that fails to load', async () => {
    const root = await writeProject({ 'ccc.config.ts': 'export default {\n' });
    const { config, diagnostics } = await loadConfig(root);
    expect(config.maxAttempts).toBe(3);
    expect(diagnostics[0]?.message).toMatch(/^cannot load config: /);
  });
});
```

`packages/cli/test/pricing.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { costUsd } from '../src/pricing.js';

describe('costUsd', () => {
  it('prices known models per million tokens', () => {
    expect(costUsd('claude-opus-5', 1_000_000, 1_000_000)).toBe(30);
    expect(costUsd('claude-opus-5', 1000, 500)).toBe(0.0175);
    expect(costUsd('claude-sonnet-5', 2_000_000, 0)).toBe(4);
  });
  it('returns null for an unknown model', () => {
    expect(costUsd('some-future-model', 10, 10)).toBeNull();
  });
});
```

`packages/cli/test/hash.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeConcept, sha256, stableStringify } from '../src/hash.js';
import { parseConcept } from '../src/parse.js';

function parsed(text: string) {
  const result = parseConcept('a', 'concepts/a.md', text);
  if (result.concept === null) throw new Error('fixture');
  return result.concept;
}

const A = '---\nkind: value\ninterface: export type A = string;\nuses: []\n---\n## Intent\nAn A.   \n\n## Rules\n- one\n\n## Examples\n- e\n';

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('sha256', () => {
  it('hashes text as lowercase hex', async () => {
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('normalizeConcept', () => {
  it('ignores key order, section order, trailing whitespace, and line endings', () => {
    const reordered = '---\nuses: []\nkind: value\ninterface: export type A = string;\n---\n## Rules\n- one\n\n## Intent\nAn A.\n\n## Examples\n- e\n';
    expect(normalizeConcept(parsed(reordered))).toBe(normalizeConcept(parsed(A)));
    expect(normalizeConcept(parsed(A.replace(/\n/g, '\r\n')))).toBe(normalizeConcept(parsed(A)));
  });
  it('changes when content changes', () => {
    expect(normalizeConcept(parsed(A.replace('- one', '- two')))).not.toBe(normalizeConcept(parsed(A)));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run config pricing hash`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/cli/src/config.ts`:
```ts
import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { error, type Diagnostic } from './diagnostics.js';

export const DEFAULT_MODEL = 'claude-opus-5';
export const CONFIG_FILE = 'ccc.config.ts';

export const configSchema = z.strictObject({
  models: z
    .strictObject({
      impl: z.string().min(1).default(DEFAULT_MODEL),
      tests: z.string().min(1).default(DEFAULT_MODEL),
    })
    .prefault({}),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  testMaxAttempts: z.number().int().min(1).max(10).default(3),
  concurrency: z.number().int().min(1).max(16).default(4),
});

export type Config = z.output<typeof configSchema>;

export interface ConfigResult {
  config: Config;
  diagnostics: Diagnostic[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// Node 24 strips TypeScript types on import. The query string defeats the
// module cache so a changed config is re-read within one process.
async function importDefault(file: string) {
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return mod.default;
}

export async function loadConfig(root: string): Promise<ConfigResult> {
  const defaults = configSchema.parse({});
  const file = path.join(root, CONFIG_FILE);
  if (!(await exists(file))) {
    return { config: defaults, diagnostics: [] };
  }
  try {
    const parsed = configSchema.safeParse(await importDefault(file));
    if (!parsed.success) {
      return {
        config: defaults,
        diagnostics: parsed.error.issues.map((issue) =>
          error(CONFIG_FILE, `${issue.path.map(String).join('.') || 'config'}: ${issue.message}`),
        ),
      };
    }
    return { config: parsed.data, diagnostics: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { config: defaults, diagnostics: [error(CONFIG_FILE, `cannot load config: ${message}`)] };
  }
}
```

`packages/cli/src/pricing.ts`:
```ts
export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

// First-party API list prices in USD per million tokens (2026-06).
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  if (price === undefined) {
    return null;
  }
  const dollars = (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
```

`packages/cli/src/hash.ts`:
```ts
import type { Concept } from './parse.js';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => compareKeys(a, b)))
      : inner,
  );
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(digest).toString('hex');
}

// Canonical form for cache keys: formatting-only edits (key order, section
// order, trailing whitespace, line endings) don't change it.
export function normalizeConcept(concept: Concept): string {
  const frontmatter: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(concept.frontmatter)) {
    if (value !== undefined) {
      frontmatter[key] = value;
    }
  }
  const sections = [...concept.sections.values()]
    .map((section): [string, string] => [section.heading, section.lines.map((line) => line.trimEnd()).join('\n').trim()])
    .sort(([a], [b]) => compareKeys(a, b));
  return stableStringify({ id: concept.id, frontmatter, sections });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run config pricing hash`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/config.ts packages/cli/src/pricing.ts packages/cli/src/hash.ts packages/cli/test/config.test.ts packages/cli/test/pricing.test.ts packages/cli/test/hash.test.ts
git commit -m "Add config loading, model pricing, and stable hashing"
```

---

### Task 2: Generated-file layout

**Files:**
- Create: `packages/cli/src/layout.ts`
- Modify: `packages/cli/src/interfaces.ts` (move `interfacePath` / `relativeImport` into `layout.ts`, re-export them)
- Test: `packages/cli/test/layout.test.ts`

**Interfaces:**
- Consumes: `ConceptId` (Plan 1).
- Produces (`layout.ts`): constants `CCC_DIR = '.ccc'`, `GEN_DIR = '.ccc/gen'`, `INTERFACES_DIR = '.ccc/interfaces'`, `CONFORMANCE_DIR = '.ccc/conformance'`, `SCRATCH_DIR = '.ccc/.tmp'`, `MANIFEST_FILE = '.ccc/manifest.json'`, `CCC_PACKAGE_JSON`, `CCC_GITIGNORE`; functions `interfacePath(id)` (`'game/hand.d.ts'`), `relativeImport(from, to)`, `modulePath(id)`, `testPath(id)`, `interfaceFile(id)`, `conformancePath(id)`, `ownModuleSpecifier(id)`, `generatedHeader(id, key)`, `conformanceSource(id)`, `handwrittenModuleSource(id, source)`. All return `string`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  conformancePath,
  conformanceSource,
  generatedHeader,
  handwrittenModuleSource,
  interfaceFile,
  interfacePath,
  modulePath,
  ownModuleSpecifier,
  relativeImport,
  testPath,
} from '../src/layout.js';
import * as interfaces from '../src/interfaces.js';

describe('paths', () => {
  it('maps concept ids to generated file paths', () => {
    expect(modulePath('game.player.hand')).toBe('.ccc/gen/game/player/hand.ts');
    expect(testPath('game.player.hand')).toBe('.ccc/gen/game/player/hand.test.ts');
    expect(interfaceFile('card')).toBe('.ccc/interfaces/card.d.ts');
    expect(interfacePath('game.hand')).toBe('game/hand.d.ts');
    expect(conformancePath('game.hand')).toBe('.ccc/conformance/game/hand.ts');
    expect(ownModuleSpecifier('game.player.hand')).toBe('./hand.js');
    expect(relativeImport('game.player.hand', 'card')).toBe('../../card.js');
  });

  it('keeps the old exports on interfaces.ts', () => {
    expect(interfaces.relativeImport).toBe(relativeImport);
    expect(interfaces.interfacePath).toBe(interfacePath);
  });
});

describe('sources', () => {
  it('writes a header with a short key', () => {
    expect(generatedHeader('card', 'abcdef0123456789')).toBe(
      '// @generated by ccc from concept card (key abcdef012345). Do not edit.',
    );
  });

  it('writes conformance checks relative to .ccc', () => {
    expect(conformanceSource('card')).toBe(
      [
        '// @generated by ccc from concept card. Do not edit.',
        "import * as impl from '../gen/card.js';",
        "import type * as iface from '../interfaces/card.js';",
        '',
        'export const conforms: typeof iface = impl;',
        'type Extra = Exclude<keyof typeof impl, keyof typeof iface>;',
        'export const noExtraExports: [Extra] extends [never] ? true : Extra = true;',
        '',
      ].join('\n'),
    );
    expect(conformanceSource('game.player.hand')).toContain("import * as impl from '../../../gen/game/player/hand.js';");
  });

  it('re-exports handwritten sources', () => {
    expect(handwrittenModuleSource('user', 'handwritten/user.ts')).toBe(
      "// @generated by ccc from concept user. Do not edit.\nexport * from '../../handwritten/user.js';\n",
    );
    expect(handwrittenModuleSource('game.player', 'handwritten/player.ts')).toContain(
      "export * from '../../../handwritten/player.js';",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run layout`
Expected: FAIL, `../src/layout.js` not found.

- [ ] **Step 3: Implement `layout.ts`**

`packages/cli/src/layout.ts`:
```ts
import path from 'node:path';
import type { ConceptId } from './ids.js';

export const CCC_DIR = '.ccc';
export const GEN_DIR = '.ccc/gen';
export const INTERFACES_DIR = '.ccc/interfaces';
export const CONFORMANCE_DIR = '.ccc/conformance';
export const SCRATCH_DIR = '.ccc/.tmp';
export const MANIFEST_FILE = '.ccc/manifest.json';
export const CCC_PACKAGE_JSON = '{\n  "type": "module"\n}\n';
export const CCC_GITIGNORE = '.tmp/\n';

function idPath(id: ConceptId): string {
  return id.split('.').join('/');
}

export function interfacePath(id: ConceptId): string {
  return `${idPath(id)}.d.ts`;
}

// Specifier from one concept's module to another's. Generated modules and
// interfaces share the same tree shape, so one function serves both.
export function relativeImport(from: ConceptId, to: ConceptId): string {
  const rel = path.posix
    .relative(path.posix.dirname(interfacePath(from)), interfacePath(to))
    .replace(/\.d\.ts$/, '.js');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export function modulePath(id: ConceptId): string {
  return `${GEN_DIR}/${idPath(id)}.ts`;
}

export function testPath(id: ConceptId): string {
  return `${GEN_DIR}/${idPath(id)}.test.ts`;
}

export function interfaceFile(id: ConceptId): string {
  return `${INTERFACES_DIR}/${interfacePath(id)}`;
}

export function conformancePath(id: ConceptId): string {
  return `${CONFORMANCE_DIR}/${idPath(id)}.ts`;
}

export function ownModuleSpecifier(id: ConceptId): string {
  return `./${id.split('.').at(-1) ?? id}.js`;
}

export function generatedHeader(id: ConceptId, key: string): string {
  return `// @generated by ccc from concept ${id} (key ${key.slice(0, 12)}). Do not edit.`;
}

// Compile-time proof that a generated module matches its interface: its
// value exports must be assignable to the interface's, with none extra.
export function conformanceSource(id: ConceptId): string {
  const up = '../'.repeat(id.split('.').length);
  const target = idPath(id);
  return [
    `// @generated by ccc from concept ${id}. Do not edit.`,
    `import * as impl from '${up}gen/${target}.js';`,
    `import type * as iface from '${up}interfaces/${target}.js';`,
    '',
    'export const conforms: typeof iface = impl;',
    'type Extra = Exclude<keyof typeof impl, keyof typeof iface>;',
    'export const noExtraExports: [Extra] extends [never] ? true : Extra = true;',
    '',
  ].join('\n');
}

export function handwrittenModuleSource(id: ConceptId, source: string): string {
  const rel = path.posix.relative(path.posix.dirname(modulePath(id)), source.replace(/\.ts$/, '.js'));
  return [
    `// @generated by ccc from concept ${id}. Do not edit.`,
    `export * from '${rel.startsWith('.') ? rel : `./${rel}`}';`,
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Move the helpers out of `interfaces.ts`**

In `packages/cli/src/interfaces.ts`, delete the `interfacePath` and `relativeImport` function definitions (and the now-unused `import path from 'node:path';`), then add near the other imports:
```ts
import { interfacePath, relativeImport } from './layout.js';
```
and after the imports:
```ts
export { interfacePath, relativeImport } from './layout.js';
```

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run layout interfaces` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/layout.ts packages/cli/src/interfaces.ts packages/cli/test/layout.test.ts
git commit -m "Add generated-file layout and conformance sources"
```

---

### Task 3: Synthesized sync interfaces

**Files:**
- Create: `packages/cli/src/synciface.ts`
- Modify: `packages/cli/src/interfaces.ts` (`emitInterfaces` emits syncs)
- Modify: `packages/cli/test/interfaces.test.ts` (the "skips syncs" test becomes "emits synthesized interfaces for syncs")
- Test: `packages/cli/test/synciface.test.ts`

**Interfaces:**
- Consumes: `ExportInfo` (Plan 1 `interfaces.ts`, type-only); `relativeImport` (Task 2); `parseActionRef` (Plan 1); `primaryClassName` (Plan 1 `syncs.ts`); `error`, `Diagnostic`; `Concept`.
- Produces: `interface SyncInterface { source: string | null; diagnostics: Diagnostic[] }`; `targetKey(id: ConceptId): string` (`'game.players'` → `'gamePlayers'`); `syncInterface(sync: Concept, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): SyncInterface`. The synthesized module exports `SyncEvent`, `SyncTargets`, and `handle(event: SyncEvent, targets: SyncTargets): Promise<void>`. `emitInterfaces` now includes one `EmittedInterface` per sync (`headerLines: 0`).

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/synciface.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { collectExports } from '../src/interfaces.js';
import { syncInterface, targetKey } from '../src/synciface.js';
import { concept, projectFrom } from './helpers.js';

const HAND = concept('kind: collection\nof: card\ninterface: |\n  export class Hand {\n    add(card: Card): void;\n  }');
const CARD = concept(
  'kind: value\ninterface: |\n  export interface Card { readonly rank: string }\n  export function card(rank: string): Card;\n  export function sameCard(a: Card, b: Card): boolean;',
);
const COUNTER = concept('kind: entity\ninterface: |\n  export class Counter {\n    increment(): void;\n    value(): number;\n  }');

function synthesize(files: Record<string, string>, id: string) {
  const project = projectFrom(files);
  const sync = project.concepts.get(id);
  if (sync === undefined) throw new Error('fixture');
  return syncInterface(sync, collectExports(project));
}

describe('targetKey', () => {
  it('camel-cases concept ids', () => {
    expect(targetKey('game.players')).toBe('gamePlayers');
    expect(targetKey('game-store')).toBe('gameStore');
    expect(targetKey('card')).toBe('card');
  });
});

describe('syncInterface', () => {
  it('types a method trigger and class targets', () => {
    const { source, diagnostics } = synthesize(
      {
        'card.md': CARD,
        'hand.md': HAND,
        'counter.md': COUNTER,
        'count-adds.md': concept('kind: sync\nwhen: hand#add\nthen: [counter#increment]'),
      },
      'count-adds',
    );
    expect(diagnostics).toEqual([]);
    expect(source).toBe(
      [
        '// @generated by ccc from sync count-adds. Do not edit.',
        "import { Counter } from './counter.js';",
        "import { Hand } from './hand.js';",
        '',
        'export interface SyncEvent {',
        '  readonly target: Hand;',
        "  readonly args: Parameters<Hand['add']>;",
        "  readonly result: Awaited<ReturnType<Hand['add']>>;",
        '}',
        'export interface SyncTargets {',
        '  readonly counter: Counter;',
        '}',
        'export function handle(event: SyncEvent, targets: SyncTargets): Promise<void>;',
        '',
      ].join('\n'),
    );
  });

  it('types a function trigger and module targets', () => {
    const { source } = synthesize(
      { 'card.md': CARD, 'deal.md': concept('kind: sync\nwhen: card#card\nthen: [card#sameCard]') },
      'deal',
    );
    expect(source).toBe(
      [
        '// @generated by ccc from sync deal. Do not edit.',
        "import { card } from './card.js';",
        "import * as cardModule from './card.js';",
        '',
        'export interface SyncEvent {',
        '  readonly args: Parameters<typeof card>;',
        '  readonly result: Awaited<ReturnType<typeof card>>;',
        '}',
        'export interface SyncTargets {',
        '  readonly card: typeof cardModule;',
        '}',
        'export function handle(event: SyncEvent, targets: SyncTargets): Promise<void>;',
        '',
      ].join('\n'),
    );
  });

  it('reports two concepts whose primary classes share a name', () => {
    const { diagnostics } = synthesize(
      {
        'card.md': CARD,
        'hand.md': HAND,
        'game.md': concept('kind: aggregate\ninterface: export class Game {}'),
        'game/hand.md': HAND,
        'deal.md': concept('kind: sync\nwhen: hand#add\nthen: [game.hand#add]'),
      },
      'deal',
    );
    expect(diagnostics.map((d) => d.message)).toEqual([
      "sync needs 'Hand' from both hand and game.hand; rename one of them",
    ]);
  });

  it('returns no source when a referenced concept is unknown', () => {
    expect(synthesize({ 'card.md': CARD, 'deal.md': concept('kind: sync\nwhen: nope#x\nthen: [card#card]') }, 'deal').source).toBeNull();
  });
});
```

In `packages/cli/test/interfaces.test.ts`, replace the whole test named `'skips syncs and dependencies with no exports'` with:
```ts
  it('emits synthesized interfaces for syncs', () => {
    const project = projectFrom({
      'card.md': CARD,
      'deal.md': concept('kind: sync\nwhen: card#card\nthen: [card#card]'),
    });
    const { files, diagnostics } = emitInterfaces(project, collectExports(project));
    expect(diagnostics).toEqual([]);
    expect(files.map((f) => f.id)).toEqual(['card', 'deal']);
    const deal = files.find((f) => f.id === 'deal');
    expect(deal?.path).toBe('deal.d.ts');
    expect(deal?.headerLines).toBe(0);
    expect(deal?.content).toContain('export function handle(event: SyncEvent, targets: SyncTargets): Promise<void>;');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run synciface interfaces`
Expected: FAIL. `synciface.js` is not found, and the interfaces test sees only `['card']`.

- [ ] **Step 3: Implement `synciface.ts`**

`packages/cli/src/synciface.ts`:
```ts
import { error, type Diagnostic } from './diagnostics.js';
import { parseActionRef, type ConceptId } from './ids.js';
import type { ExportInfo } from './interfaces.js';
import { relativeImport } from './layout.js';
import type { Concept } from './parse.js';
import { primaryClassName } from './syncs.js';

export interface SyncInterface {
  source: string | null;
  diagnostics: Diagnostic[];
}

export function targetKey(id: ConceptId): string {
  return id
    .split(/[.-]/)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// Builds the interface a sync handler implements, from the `when` and `then`
// actions. Method actions use the concept's primary class; function actions
// use the function (trigger) or the module namespace (targets).
export function syncInterface(sync: Concept, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): SyncInterface {
  const fm = sync.frontmatter;
  if (fm.kind !== 'sync') {
    return { source: null, diagnostics: [] };
  }
  const diagnostics: Diagnostic[] = [];
  const named = new Map<ConceptId, Set<string>>();
  const namespaces = new Map<ConceptId, string>();
  const owners = new Map<string, ConceptId>();
  const importName = (conceptId: ConceptId, name: string): void => {
    const owner = owners.get(name);
    if (owner !== undefined && owner !== conceptId) {
      diagnostics.push(
        error(sync.file, `sync needs '${name}' from both ${owner} and ${conceptId}; rename one of them`, { line: 1 }),
      );
      return;
    }
    owners.set(name, conceptId);
    const names = named.get(conceptId) ?? new Set<string>();
    names.add(name);
    named.set(conceptId, names);
  };

  const when = parseActionRef(fm.when);
  const whenInfo = exportsByConcept.get(when.conceptId);
  if (whenInfo === undefined) {
    return { source: null, diagnostics };
  }
  let event: string[];
  if (whenInfo.functions.includes(when.member)) {
    importName(when.conceptId, when.member);
    event = [
      `  readonly args: Parameters<typeof ${when.member}>;`,
      `  readonly result: Awaited<ReturnType<typeof ${when.member}>>;`,
    ];
  } else {
    const cls = primaryClassName(when.conceptId);
    importName(when.conceptId, cls);
    event = [
      `  readonly target: ${cls};`,
      `  readonly args: Parameters<${cls}['${when.member}']>;`,
      `  readonly result: Awaited<ReturnType<${cls}['${when.member}']>>;`,
    ];
  }

  const actionsByTarget = new Map<ConceptId, string[]>();
  for (const ref of fm.then) {
    const { conceptId, member } = parseActionRef(ref);
    actionsByTarget.set(conceptId, [...(actionsByTarget.get(conceptId) ?? []), member]);
  }
  const targets: string[] = [];
  for (const [conceptId, members] of actionsByTarget) {
    const info = exportsByConcept.get(conceptId);
    if (info === undefined) {
      return { source: null, diagnostics };
    }
    const key = targetKey(conceptId);
    if (members.every((member) => !info.functions.includes(member))) {
      const cls = primaryClassName(conceptId);
      importName(conceptId, cls);
      targets.push(`  readonly ${key}: ${cls};`);
    } else {
      const alias = `${key}Module`;
      namespaces.set(conceptId, alias);
      targets.push(`  readonly ${key}: typeof ${alias};`);
    }
  }

  const imports = [...new Set([...named.keys(), ...namespaces.keys()])].sort().flatMap((conceptId) => {
    const lines: string[] = [];
    const names = named.get(conceptId);
    if (names !== undefined) {
      lines.push(`import { ${[...names].sort().join(', ')} } from '${relativeImport(sync.id, conceptId)}';`);
    }
    const alias = namespaces.get(conceptId);
    if (alias !== undefined) {
      lines.push(`import * as ${alias} from '${relativeImport(sync.id, conceptId)}';`);
    }
    return lines;
  });

  const source = [
    `// @generated by ccc from sync ${sync.id}. Do not edit.`,
    ...imports,
    '',
    'export interface SyncEvent {',
    ...event,
    '}',
    'export interface SyncTargets {',
    ...targets,
    '}',
    'export function handle(event: SyncEvent, targets: SyncTargets): Promise<void>;',
    '',
  ].join('\n');
  return { source, diagnostics };
}
```

- [ ] **Step 4: Emit sync interfaces**

In `packages/cli/src/interfaces.ts`, add `import { syncInterface } from './synciface.js';` and change the start of the loop body in `emitInterfaces` from:
```ts
    const fm = concept.frontmatter;
    const own = exportsByConcept.get(concept.id);
    if (fm.kind === 'sync' || own === undefined) {
      continue;
    }
```
to:
```ts
    const fm = concept.frontmatter;
    if (fm.kind === 'sync') {
      const synthesized = syncInterface(concept, exportsByConcept);
      diagnostics.push(...synthesized.diagnostics);
      if (synthesized.source !== null) {
        files.push({
          id: concept.id,
          conceptFile: concept.file,
          path: interfacePath(concept.id),
          content: synthesized.source,
          headerLines: 0,
        });
      }
      continue;
    }
    const own = exportsByConcept.get(concept.id);
    if (own === undefined) {
      continue;
    }
```

The import cycle (`interfaces` → `synciface` → type-only `interfaces`) is safe because `synciface` imports only a type from `interfaces`.

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run synciface interfaces` (expected: PASS), then `pnpm verify` (expected: all green; the Plan 1 card-game fixture's sync now type-checks as part of `ccc check`).
```bash
git add packages/cli/src/synciface.ts packages/cli/src/interfaces.ts packages/cli/test/synciface.test.ts packages/cli/test/interfaces.test.ts
git commit -m "Synthesize and type-check sync handler interfaces"
```

---

### Task 4: Prompts, versions, and cache keys

**Files:**
- Create: `packages/cli/prompts/impl.md`, `packages/cli/prompts/tests.md`, `packages/cli/prompts/sync.md`
- Create: `packages/cli/src/versions.ts`, `packages/cli/src/keys.ts`
- Test: `packages/cli/test/versions.test.ts`, `packages/cli/test/keys.test.ts`

**Interfaces:**
- Consumes: `sha256`, `stableStringify`, `normalizeConcept` (Task 1); `Config` (Task 1); `syncInterface` (Task 3); `dependenciesOf` (Plan 1 `graph.ts`); `ExportInfo`, `collectExports` (Plan 1).
- Produces:
  - `versions.ts`: `type PromptName = 'impl' | 'tests' | 'sync'`; `RUNTIME_VERSION = '0.0.0'`; `interface Versions { implPrompt: string; testPrompt: string; syncPrompt: string; implModel: string; testModel: string; runtime: string }`; `readPrompt(name: PromptName): Promise<string>`; `loadVersions(config: Config): Promise<Versions>`
  - `keys.ts`: `type ExportsByConcept = ReadonlyMap<ConceptId, ExportInfo>`; `interfaceTextOf(concept: Concept, exportsByConcept: ExportsByConcept): string`; `testKey(concept, project, exportsByConcept, versions): Promise<string>`; `implKey(concept, project, exportsByConcept, versions, testFileHash: string): Promise<string>`

- [ ] **Step 1: Write the prompt files**

`packages/cli/prompts/impl.md`:
```markdown
You are the code generator for ccc, a tool that compiles concept models into TypeScript.

Each request asks for exactly one TypeScript module. Deliver it by calling the write_module tool with the complete file. Never put the code in a plain-text reply.

Every module must:
- Export exactly the declarations in the concept's interface, with the same names and signatures. Add no other exports.
- Re-declare the exported types (interfaces, type aliases) exactly as the interface declares them.
- Implement the behavior in the concept's Intent, Rules, and Examples. The Rules are invariants; enforce them.
- Pass the provided tests without changes to them.
- Compile under TypeScript strict mode. Never use the `any` type.
- Import only the dependency paths and packages the request lists, using the exact specifiers given (relative imports end in `.js`).
- Avoid I/O, global state, and randomness unless the interface passes them in.
- Stay small and readable. Don't write comments that restate the code.

When you get feedback about failed checks, fix every listed problem and call write_module again with the complete corrected file.
```

`packages/cli/prompts/tests.md`:
```markdown
You are the test writer for ccc, a tool that compiles concept models into TypeScript.

Each request asks for one Vitest test file. Deliver it by calling the write_module tool with the complete file. Never put the code in a plain-text reply.

Every test file must:
- Contain exactly one `it(...)` per example, and each test name must start with the example's tag, for example `it('[ex 2] rejects a duplicate card', ...)`. Test nothing else.
- Test only through the interface you are given. You haven't seen the implementation, so don't depend on internals.
- Use the Vitest globals (describe, it, expect, vi). Don't import 'vitest'.
- Import the module under test and its dependencies only from the specifiers given, ending in `.js`.
- Compile under TypeScript strict mode. Never use the `any` type.
- Assert the outcome each example states, including the class of any thrown error.

When you get feedback, fix every problem and call write_module again with the complete file.
```

`packages/cli/prompts/sync.md`:
```markdown
You are the code generator for ccc, a tool that compiles concept models into TypeScript.

Each request asks for the handler module of one sync. A sync reacts after an action on one concept succeeds and may invoke actions on other concepts. Deliver the module by calling the write_module tool with the complete file. Never put the code in a plain-text reply.

The handler module must:
- Export exactly `SyncEvent`, `SyncTargets`, and `handle`, declared as in the given interface.
- Decide from the sync's Rules whether to act, then invoke the target actions through `targets`. Never construct concepts yourself.
- Pass the provided tests without changes to them.
- Compile under TypeScript strict mode. Never use the `any` type.
- Import only the specifiers given; use `import type` when only types are needed.
- Stay small and readable.

When you get feedback about failed checks, fix every listed problem and call write_module again with the complete corrected file.
```

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/versions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, configSchema } from '../src/config.js';
import { RUNTIME_VERSION, loadVersions, readPrompt } from '../src/versions.js';

describe('versions', () => {
  it('reads the shipped prompts', async () => {
    expect(await readPrompt('impl')).toContain('write_module');
    expect(await readPrompt('tests')).toContain('[ex 2]');
    expect(await readPrompt('sync')).toContain('SyncTargets');
  });

  it('hashes prompts and records models and the runtime version', async () => {
    const versions = await loadVersions(configSchema.parse({ models: { tests: 'claude-sonnet-5' } }));
    expect(versions.implPrompt).toMatch(/^[0-9a-f]{64}$/);
    expect(versions.testPrompt).not.toBe(versions.implPrompt);
    expect(versions.syncPrompt).not.toBe(versions.implPrompt);
    expect(versions.implModel).toBe(DEFAULT_MODEL);
    expect(versions.testModel).toBe('claude-sonnet-5');
    expect(versions.runtime).toBe(RUNTIME_VERSION);
  });
});
```

`packages/cli/test/keys.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { collectExports } from '../src/interfaces.js';
import { implKey, interfaceTextOf, testKey } from '../src/keys.js';
import type { Versions } from '../src/versions.js';
import { concept, projectFrom } from './helpers.js';

const VERSIONS: Versions = { implPrompt: 'ip', testPrompt: 'tp', syncPrompt: 'sp', implModel: 'm1', testModel: 'm2', runtime: 'r' };

const CARD = (extra = '') =>
  concept(`kind: value\ninterface: |\n  export interface Card { readonly rank: string }${extra}`, '## Intent\nA card.\n\n## Rules\n- ranks are strings\n\n## Examples\n- a\n');
const HAND = (rules = '- no duplicates', examples = '- add a card') =>
  concept('kind: collection\nof: card\ninterface: |\n  export class Hand {\n    add(card: Card): void;\n  }', `## Intent\nCards held.\n\n## Rules\n${rules}\n\n## Examples\n${examples}\n`);

async function keysFor(files: Record<string, string>, id: string, versions: Versions = VERSIONS, testHash = 'h') {
  const project = projectFrom(files);
  const exportsByConcept = collectExports(project);
  const target = project.concepts.get(id);
  if (target === undefined) throw new Error('fixture');
  return {
    test: await testKey(target, project, exportsByConcept, versions),
    impl: await implKey(target, project, exportsByConcept, versions, testHash),
  };
}

const BASE = { 'card.md': CARD(), 'hand.md': HAND() };

describe('cache keys', () => {
  it('are deterministic', async () => {
    expect(await keysFor(BASE, 'hand')).toEqual(await keysFor(BASE, 'hand'));
  });

  it('change only the implementation key when Rules change', async () => {
    const before = await keysFor(BASE, 'hand');
    const after = await keysFor({ ...BASE, 'hand.md': HAND('- no duplicates, ever') }, 'hand');
    expect(after.test).toBe(before.test);
    expect(after.impl).not.toBe(before.impl);
  });

  it('change both keys when Examples change', async () => {
    const before = await keysFor(BASE, 'hand');
    const after = await keysFor({ ...BASE, 'hand.md': HAND(undefined, '- add two cards') }, 'hand');
    expect(after.test).not.toBe(before.test);
    expect(after.impl).not.toBe(before.impl);
  });

  it('follow dependency interfaces but not dependency prose', async () => {
    const before = await keysFor(BASE, 'hand');
    const iface = await keysFor({ ...BASE, 'card.md': CARD('\n  export type Suit = string;') }, 'hand');
    expect(iface.test).not.toBe(before.test);
    expect(iface.impl).not.toBe(before.impl);
    const prose = await keysFor({ ...BASE, 'card.md': CARD().replace('ranks are strings', 'ranks are short strings') }, 'hand');
    expect(prose).toEqual(before);
  });

  it('include the test file hash, models, and prompt versions', async () => {
    const before = await keysFor(BASE, 'hand');
    const testHash = await keysFor(BASE, 'hand', VERSIONS, 'other');
    expect(testHash.test).toBe(before.test);
    expect(testHash.impl).not.toBe(before.impl);
    const implModel = await keysFor(BASE, 'hand', { ...VERSIONS, implModel: 'm3' });
    expect(implModel.test).toBe(before.test);
    expect(implModel.impl).not.toBe(before.impl);
    const testModel = await keysFor(BASE, 'hand', { ...VERSIONS, testModel: 'm3' });
    expect(testModel.test).not.toBe(before.test);
    expect(testModel.impl).toBe(before.impl);
  });

  it('use the sync prompt for syncs', async () => {
    const files = {
      ...BASE,
      'counter.md': concept('kind: entity\ninterface: |\n  export class Counter {\n    increment(): void;\n  }'),
      'count-adds.md': concept('kind: sync\nwhen: hand#add\nthen: [counter#increment]'),
    };
    const before = await keysFor(files, 'count-adds');
    expect((await keysFor(files, 'count-adds', { ...VERSIONS, implPrompt: 'other' })).impl).toBe(before.impl);
    expect((await keysFor(files, 'count-adds', { ...VERSIONS, syncPrompt: 'other' })).impl).not.toBe(before.impl);
  });

  it('expose the synthesized interface text for syncs', () => {
    const project = projectFrom({
      ...BASE,
      'counter.md': concept('kind: entity\ninterface: |\n  export class Counter {\n    increment(): void;\n  }'),
      'count-adds.md': concept('kind: sync\nwhen: hand#add\nthen: [counter#increment]'),
    });
    const sync = project.concepts.get('count-adds');
    if (sync === undefined) throw new Error('fixture');
    expect(interfaceTextOf(sync, collectExports(project))).toContain('export interface SyncTargets');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run versions keys`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`packages/cli/src/versions.ts`:
```ts
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { sha256 } from './hash.js';

export type PromptName = 'impl' | 'tests' | 'sync';

// Replaced by the @ccc/runtime package version in Plan 3.
export const RUNTIME_VERSION = '0.0.0';

export interface Versions {
  implPrompt: string;
  testPrompt: string;
  syncPrompt: string;
  implModel: string;
  testModel: string;
  runtime: string;
}

// Prompts ship in packages/cli/prompts, one level above both src/ and dist/.
export async function readPrompt(name: PromptName): Promise<string> {
  return readFile(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
}

export async function loadVersions(config: Config): Promise<Versions> {
  const [impl, tests, sync] = await Promise.all([readPrompt('impl'), readPrompt('tests'), readPrompt('sync')]);
  return {
    implPrompt: await sha256(impl),
    testPrompt: await sha256(tests),
    syncPrompt: await sha256(sync),
    implModel: config.models.impl,
    testModel: config.models.tests,
    runtime: RUNTIME_VERSION,
  };
}
```

`packages/cli/src/keys.ts`:
```ts
import { dependenciesOf } from './graph.js';
import { normalizeConcept, sha256, stableStringify } from './hash.js';
import type { ConceptId } from './ids.js';
import type { ExportInfo } from './interfaces.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { syncInterface } from './synciface.js';
import type { Versions } from './versions.js';

export type ExportsByConcept = ReadonlyMap<ConceptId, ExportInfo>;

export function interfaceTextOf(concept: Concept, exportsByConcept: ExportsByConcept): string {
  const fm = concept.frontmatter;
  return fm.kind === 'sync' ? (syncInterface(concept, exportsByConcept).source ?? '') : fm.interface;
}

// Dependencies contribute their interfaces only, never their implementations
// or prose (spec §3.2: separate compilation).
function dependencyInterfaces(concept: Concept, project: Project, exportsByConcept: ExportsByConcept): [string, string][] {
  return dependenciesOf(concept, project).flatMap((id): [string, string][] => {
    const dep = project.concepts.get(id);
    return dep === undefined ? [] : [[id, interfaceTextOf(dep, exportsByConcept)]];
  });
}

export async function testKey(
  concept: Concept,
  project: Project,
  exportsByConcept: ExportsByConcept,
  versions: Versions,
): Promise<string> {
  return sha256(
    stableStringify({
      artifact: 'tests',
      id: concept.id,
      kind: concept.frontmatter.kind,
      interface: interfaceTextOf(concept, exportsByConcept),
      intent: concept.sections.get('Intent')?.body ?? '',
      examples: concept.examples,
      dependencies: dependencyInterfaces(concept, project, exportsByConcept),
      prompt: versions.testPrompt,
      model: versions.testModel,
      runtime: versions.runtime,
    }),
  );
}

export async function implKey(
  concept: Concept,
  project: Project,
  exportsByConcept: ExportsByConcept,
  versions: Versions,
  testFileHash: string,
): Promise<string> {
  return sha256(
    stableStringify({
      artifact: 'impl',
      concept: normalizeConcept(concept),
      dependencies: dependencyInterfaces(concept, project, exportsByConcept),
      tests: testFileHash,
      prompt: concept.frontmatter.kind === 'sync' ? versions.syncPrompt : versions.implPrompt,
      model: versions.implModel,
      runtime: versions.runtime,
    }),
  );
}
```

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run versions keys` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/prompts packages/cli/src/versions.ts packages/cli/src/keys.ts packages/cli/test/versions.test.ts packages/cli/test/keys.test.ts
git commit -m "Add generation prompts, version hashing, and cache keys"
```

---

### Task 5: File helpers and manifest

**Files:**
- Create: `packages/cli/src/fsutil.ts`, `packages/cli/src/manifest.ts`
- Test: `packages/cli/test/fsutil.test.ts`, `packages/cli/test/manifest.test.ts`

**Interfaces:**
- Consumes: `sha256`, `stableStringify` (Task 1); layout constants (Task 2); `error`, `Diagnostic`.
- Produces:
  - `fsutil.ts` (all paths project-relative, POSIX): `readFileOrNull(root, rel): Promise<string | null>`; `writeFileAtomic(root, rel, content): Promise<void>` (creates parent dirs, writes a temp file, renames it over the target); `removeFile(root, rel): Promise<void>`; `fileHash(root, rel): Promise<string | null>`; `listFilesUnder(root, relDir): Promise<string[]>` (sorted, recursive, files only, `[]` when missing)
  - `manifest.ts`: types `Generation`, `ManifestEntry`, `Manifest`; `manifestSchema`; `emptyManifest(): Manifest`; `entryFor(manifest, id): ManifestEntry` (creates when missing); `readManifest(root): Promise<{ manifest: Manifest; diagnostics: Diagnostic[] }>`; `writeManifest(root, manifest): Promise<void>`; `listCccFiles(root): Promise<string[]>` (files under gen/interfaces/conformance plus `.ccc/package.json` and `.ccc/.gitignore` when present); `hashFiles(root, files): Promise<Record<string, string>>`

`Generation` = `{ artifact: 'tests' | 'impl'; at: string; model: string; attempts: number; inputTokens: number; outputTokens: number; costUsd: number | null; durationMs: number; outcome: 'passed' | 'failed' }`.
`ManifestEntry` = `{ testKey: string | null; testFileHash: string | null; approvedTestHash: string | null; implKey: string | null; history: Generation[] }`.
`Manifest` = `{ version: 1; concepts: Record<string, ManifestEntry>; files: Record<string, string> }`.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/fsutil.test.ts`:
```ts
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileHash, listFilesUnder, readFileOrNull, removeFile, writeFileAtomic } from '../src/fsutil.js';
import { writeProject } from './helpers.js';

describe('fsutil', () => {
  it('writes atomically, creating directories, and reads back', async () => {
    const root = await writeProject({});
    await writeFileAtomic(root, '.ccc/gen/a/b.ts', 'x');
    expect(await readFileOrNull(root, '.ccc/gen/a/b.ts')).toBe('x');
    expect(await readdir(path.join(root, '.ccc/gen/a'))).toEqual(['b.ts']);
  });

  it('returns null or nothing for missing files', async () => {
    const root = await writeProject({});
    expect(await readFileOrNull(root, 'nope.txt')).toBeNull();
    expect(await fileHash(root, 'nope.txt')).toBeNull();
    expect(await listFilesUnder(root, '.ccc/gen')).toEqual([]);
    await removeFile(root, 'nope.txt');
  });

  it('hashes and lists files', async () => {
    const root = await writeProject({ '.ccc/gen/z.ts': 'z', '.ccc/gen/a/b.ts': 'abc' });
    expect(await fileHash(root, '.ccc/gen/a/b.ts')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await listFilesUnder(root, '.ccc/gen')).toEqual(['.ccc/gen/a/b.ts', '.ccc/gen/z.ts']);
  });
});
```

`packages/cli/test/manifest.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { readFileOrNull } from '../src/fsutil.js';
import { emptyManifest, entryFor, hashFiles, listCccFiles, readManifest, writeManifest } from '../src/manifest.js';
import { writeProject } from './helpers.js';

describe('manifest', () => {
  it('starts empty when missing', async () => {
    const root = await writeProject({});
    expect(await readManifest(root)).toEqual({ manifest: emptyManifest(), diagnostics: [] });
  });

  it('round-trips with sorted keys', async () => {
    const root = await writeProject({});
    const manifest = emptyManifest();
    const entry = entryFor(manifest, 'hand');
    entry.testKey = 'k';
    entry.history.push({
      artifact: 'tests',
      at: '2026-09-24T00:00:00.000Z',
      model: 'claude-opus-5',
      attempts: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.000175,
      durationMs: 12,
      outcome: 'passed',
    });
    manifest.files['.ccc/gen/hand.ts'] = 'abc';
    await writeManifest(root, manifest);
    const text = await readFileOrNull(root, '.ccc/manifest.json');
    expect(text?.endsWith('\n')).toBe(true);
    expect(text?.indexOf('"concepts"')).toBeLessThan(text?.indexOf('"files"') ?? 0);
    expect((await readManifest(root)).manifest).toEqual(manifest);
  });

  it('creates entries on demand and reuses them', () => {
    const manifest = emptyManifest();
    const entry = entryFor(manifest, 'card');
    expect(entry).toEqual({ testKey: null, testFileHash: null, approvedTestHash: null, implKey: null, history: [] });
    expect(entryFor(manifest, 'card')).toBe(entry);
  });

  it('reports invalid JSON and invalid shapes', async () => {
    const bad = await writeProject({ '.ccc/manifest.json': '{nope' });
    const badResult = await readManifest(bad);
    expect(badResult.diagnostics[0]?.message).toBe('invalid manifest: not valid JSON');
    expect(badResult.diagnostics[0]?.hint).toBe('restore it from git, or delete it to rebuild everything');
    const shape = await writeProject({ '.ccc/manifest.json': '{"version":2,"concepts":{},"files":{}}' });
    expect((await readManifest(shape)).diagnostics[0]?.message).toMatch(/^invalid manifest: /);
  });

  it('lists and hashes generated files, skipping scratch and the manifest', async () => {
    const root = await writeProject({
      '.ccc/gen/card.ts': 'a',
      '.ccc/interfaces/card.d.ts': 'b',
      '.ccc/conformance/card.ts': 'c',
      '.ccc/package.json': 'd',
      '.ccc/.tmp/run-1/x.ts': 'e',
      '.ccc/manifest.json': '{}',
    });
    const files = await listCccFiles(root);
    expect(files).toEqual(['.ccc/conformance/card.ts', '.ccc/gen/card.ts', '.ccc/interfaces/card.d.ts', '.ccc/package.json']);
    const hashes = await hashFiles(root, files);
    expect(Object.keys(hashes)).toEqual(files);
    expect(hashes['.ccc/gen/card.ts']).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run fsutil manifest`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/cli/src/fsutil.ts`:
```ts
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './hash.js';

export async function readFileOrNull(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

export async function writeFileAtomic(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  const temp = `${full}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content);
  await rename(temp, full);
}

export async function removeFile(root: string, rel: string): Promise<void> {
  await rm(path.join(root, rel), { force: true });
}

export async function fileHash(root: string, rel: string): Promise<string | null> {
  const text = await readFileOrNull(root, rel);
  return text === null ? null : sha256(text);
}

export async function listFilesUnder(root: string, relDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, relDir), { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
  } catch {
    return [];
  }
}
```

`packages/cli/src/manifest.ts`:
```ts
import { z } from 'zod';
import { error, type Diagnostic } from './diagnostics.js';
import { fileHash, listFilesUnder, readFileOrNull, writeFileAtomic } from './fsutil.js';
import { stableStringify } from './hash.js';
import type { ConceptId } from './ids.js';
import { CONFORMANCE_DIR, GEN_DIR, INTERFACES_DIR, MANIFEST_FILE } from './layout.js';

const generationSchema = z.strictObject({
  artifact: z.enum(['tests', 'impl']),
  at: z.string(),
  model: z.string(),
  attempts: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().nullable(),
  durationMs: z.number(),
  outcome: z.enum(['passed', 'failed']),
});

const entrySchema = z.strictObject({
  testKey: z.string().nullable(),
  testFileHash: z.string().nullable(),
  approvedTestHash: z.string().nullable(),
  implKey: z.string().nullable(),
  history: z.array(generationSchema),
});

export const manifestSchema = z.strictObject({
  version: z.literal(1),
  concepts: z.record(z.string(), entrySchema),
  files: z.record(z.string(), z.string()),
});

export type Generation = z.output<typeof generationSchema>;
export type ManifestEntry = z.output<typeof entrySchema>;
export type Manifest = z.output<typeof manifestSchema>;

const manifestJson = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not valid JSON' });
      return z.NEVER;
    }
  })
  .pipe(manifestSchema);

export function emptyManifest(): Manifest {
  return { version: 1, concepts: {}, files: {} };
}

export function entryFor(manifest: Manifest, id: ConceptId): ManifestEntry {
  const existing = manifest.concepts[id];
  if (existing !== undefined) {
    return existing;
  }
  const created: ManifestEntry = { testKey: null, testFileHash: null, approvedTestHash: null, implKey: null, history: [] };
  manifest.concepts[id] = created;
  return created;
}

export async function readManifest(root: string): Promise<{ manifest: Manifest; diagnostics: Diagnostic[] }> {
  const text = await readFileOrNull(root, MANIFEST_FILE);
  if (text === null) {
    return { manifest: emptyManifest(), diagnostics: [] };
  }
  const parsed = manifestJson.safeParse(text);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'unknown problem';
    return {
      manifest: emptyManifest(),
      diagnostics: [
        error(MANIFEST_FILE, `invalid manifest: ${message}`, {
          hint: 'restore it from git, or delete it to rebuild everything',
        }),
      ],
    };
  }
  return { manifest: parsed.data, diagnostics: [] };
}

export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const sorted = JSON.parse(stableStringify(manifest));
  await writeFileAtomic(root, MANIFEST_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

export async function listCccFiles(root: string): Promise<string[]> {
  const trees = await Promise.all([GEN_DIR, INTERFACES_DIR, CONFORMANCE_DIR].map((dir) => listFilesUnder(root, dir)));
  const extras = await Promise.all(
    ['.ccc/package.json', '.ccc/.gitignore'].map(async (file) => ((await readFileOrNull(root, file)) === null ? null : file)),
  );
  return [...trees.flat(), ...extras.filter((file): file is string => file !== null)].sort();
}

export async function hashFiles(root: string, files: readonly string[]): Promise<Record<string, string>> {
  const hashes = await Promise.all(files.map(async (file) => [file, await fileHash(root, file)] as const));
  const result: Record<string, string> = {};
  for (const [file, hash] of hashes) {
    if (hash !== null) {
      result[file] = hash;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run fsutil manifest` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/fsutil.ts packages/cli/src/manifest.ts packages/cli/test/fsutil.test.ts packages/cli/test/manifest.test.ts
git commit -m "Add atomic file helpers and the build manifest"
```

---

### Task 6: Import rules for generated code

**Files:**
- Create: `packages/cli/src/imports.ts`
- Test: `packages/cli/test/imports.test.ts`

**Interfaces:**
- Consumes: `dependenciesOf` (Plan 1); `relativeImport`, `ownModuleSpecifier` (Task 2); `Kind` (Plan 1 `schema.ts`); `Project`, `Concept`.
- Produces: `interface ImportRef { specifier: string; line: number; dynamic: boolean }`; `scanImports(source: string): ImportRef[]`; `PACKAGES_BY_KIND: Readonly<Record<Kind, readonly string[]>>`; `TEST_PACKAGES: readonly string[]`; `packageName(specifier: string): string`; `transitiveDependencies(concept, project): ConceptId[]` (sorted); `moduleImportsFor(concept, project): Set<string>`; `testImportsFor(concept, project): Set<string>`; `checkImports(source: string, allowedModules: ReadonlySet<string>, allowedPackages: readonly string[]): string[]`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/imports.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  PACKAGES_BY_KIND,
  checkImports,
  moduleImportsFor,
  packageName,
  scanImports,
  testImportsFor,
  transitiveDependencies,
} from '../src/imports.js';
import { concept, projectFrom } from './helpers.js';

describe('scanImports', () => {
  it('finds static, type-only, re-export, dynamic, and require imports with lines', () => {
    const source = [
      "import { a } from './a.js';",
      "import type { B } from '../b.js';",
      "export * from './c.js';",
      "const d = await import('./d.js');",
      "const e = require('e');",
      "import f = require('f');",
    ].join('\n');
    expect(scanImports(source)).toEqual([
      { specifier: './a.js', line: 1, dynamic: false },
      { specifier: '../b.js', line: 2, dynamic: false },
      { specifier: './c.js', line: 3, dynamic: false },
      { specifier: './d.js', line: 4, dynamic: true },
      { specifier: 'e', line: 5, dynamic: true },
      { specifier: 'f', line: 6, dynamic: true },
    ]);
  });
});

describe('packageName', () => {
  it('strips subpaths', () => {
    expect(packageName('hono/cors')).toBe('hono');
    expect(packageName('@ccc/runtime/errors')).toBe('@ccc/runtime');
    expect(packageName('node:fs')).toBe('node:fs');
  });
});

describe('checkImports', () => {
  const allowed = new Set(['./card.js']);
  it('accepts allowed modules and packages', () => {
    expect(checkImports("import { card } from './card.js';\nimport { Hono } from 'hono/tiny';", allowed, ['hono'])).toEqual([]);
  });
  it('reports undeclared modules, disallowed packages, and dynamic imports', () => {
    const source = "import { x } from './secret.js';\nimport fs from 'node:fs';\nconst m = await import('./card.js');";
    expect(checkImports(source, allowed, PACKAGES_BY_KIND.value)).toEqual([
      "line 1: './secret.js' is not a dependency of this concept (allowed: ./card.js)",
      "line 2: package 'node:fs' is not allowed here (allowed: @ccc/runtime)",
      'line 3: dynamic import() and require() are not allowed',
    ]);
  });
});

describe('allowed imports per concept', () => {
  const project = projectFrom({
    'card.md': concept('kind: value\ninterface: export interface Card { readonly rank: string }'),
    'hand.md': concept('kind: collection\nof: card\ninterface: |\n  export class Hand {\n    add(card: Card): void;\n  }'),
    'counter.md': concept('kind: entity\ninterface: |\n  export class Counter {\n    increment(): void;\n  }'),
    'count-adds.md': concept('kind: sync\nwhen: hand#add\nthen: [counter#increment]'),
  });
  const get = (id: string) => {
    const found = project.concepts.get(id);
    if (found === undefined) throw new Error('fixture');
    return found;
  };

  it('lets modules import their direct dependencies', () => {
    expect([...moduleImportsFor(get('hand'), project)]).toEqual(['./card.js']);
    expect([...moduleImportsFor(get('count-adds'), project)]).toEqual(['./counter.js', './hand.js']);
  });

  it('lets tests import the module under test and all transitive dependencies', () => {
    expect(transitiveDependencies(get('count-adds'), project)).toEqual(['card', 'counter', 'hand']);
    expect([...testImportsFor(get('count-adds'), project)].sort()).toEqual([
      './card.js',
      './count-adds.js',
      './counter.js',
      './hand.js',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run imports`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/imports.ts`:
```ts
import ts from '@typescript/typescript6';
import { dependenciesOf } from './graph.js';
import type { ConceptId } from './ids.js';
import { ownModuleSpecifier, relativeImport } from './layout.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import type { Kind } from './schema.js';

export interface ImportRef {
  specifier: string;
  line: number;
  dynamic: boolean;
}

export function scanImports(source: string): ImportRef[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs: ImportRef[] = [];
  const lineOf = (node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      refs.push({ specifier: node.moduleSpecifier.text, line: lineOf(node), dynamic: false });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      refs.push({ specifier: ts.isStringLiteral(expression) ? expression.text : '', line: lineOf(node), dynamic: true });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const arg = node.arguments[0];
      refs.push({ specifier: arg !== undefined && ts.isStringLiteral(arg) ? arg.text : '', line: lineOf(node), dynamic: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return refs;
}

// Spec §4.3: packages each kind may import. Everything else must be a
// dependency's generated module.
export const PACKAGES_BY_KIND: Readonly<Record<Kind, readonly string[]>> = {
  value: ['@ccc/runtime'],
  entity: ['@ccc/runtime'],
  collection: ['@ccc/runtime'],
  aggregate: ['@ccc/runtime'],
  store: ['@ccc/runtime', 'pg'],
  endpoint: ['@ccc/runtime', 'hono', 'zod'],
  auth: ['@ccc/runtime', 'hono'],
  sync: ['@ccc/runtime'],
};

export const TEST_PACKAGES: readonly string[] = ['@ccc/runtime'];

export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

export function transitiveDependencies(concept: Concept, project: Project): ConceptId[] {
  const seen = new Set<ConceptId>();
  const queue = [...dependenciesOf(concept, project)];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const dep = project.concepts.get(id);
    if (dep !== undefined) {
      queue.push(...dependenciesOf(dep, project));
    }
  }
  seen.delete(concept.id);
  return [...seen].sort();
}

export function moduleImportsFor(concept: Concept, project: Project): Set<string> {
  return new Set(dependenciesOf(concept, project).map((id) => relativeImport(concept.id, id)));
}

// Tests may build values from any concept their subject depends on, directly
// or not, plus the module under test itself.
export function testImportsFor(concept: Concept, project: Project): Set<string> {
  return new Set([
    ownModuleSpecifier(concept.id),
    ...transitiveDependencies(concept, project).map((id) => relativeImport(concept.id, id)),
  ]);
}

export function checkImports(source: string, allowedModules: ReadonlySet<string>, allowedPackages: readonly string[]): string[] {
  return scanImports(source).flatMap((ref) => {
    if (ref.dynamic) {
      return [`line ${ref.line}: dynamic import() and require() are not allowed`];
    }
    if (ref.specifier.startsWith('.')) {
      return allowedModules.has(ref.specifier)
        ? []
        : [
            `line ${ref.line}: '${ref.specifier}' is not a dependency of this concept (allowed: ${[...allowedModules].join(', ') || 'none'})`,
          ];
    }
    return allowedPackages.includes(packageName(ref.specifier))
      ? []
      : [`line ${ref.line}: package '${ref.specifier}' is not allowed here (allowed: ${allowedPackages.join(', ')})`];
  });
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run imports` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/imports.ts packages/cli/test/imports.test.ts
git commit -m "Enforce per-kind import rules for generated code"
```

---

### Task 7: Toolchain runners

**Files:**
- Create: `packages/cli/src/toolchain.ts`
- Modify: `packages/cli/package.json` (move `vitest` to `dependencies`; add `oxlint` to `dependencies`)
- Test: `packages/cli/test/toolchain.test.ts`

**Interfaces:**
- Consumes: `runTsc`, `parseTscLines` (Plan 1 `tsc.ts`); `SCRATCH_DIR` (Task 2).
- Produces: `interface ToolIssue { file: string; line: number | null; message: string }` (`file` project-relative, `''` when unknown); `vitestGlobalsPath(): string`; `withScratch<T>(root, fn: (dir: string) => Promise<T>): Promise<T>` (a fresh dir under `.ccc/.tmp`, always removed); `typecheckFiles(root, files: readonly string[]): Promise<ToolIssue[]>`; `lintFiles(root, files): Promise<ToolIssue[]>`; `interface TestCase { file: string; name: string; status: 'passed' | 'failed' | 'skipped'; message: string }`; `interface TestRun { cases: TestCase[]; errors: ToolIssue[] }`; `runTests(root, testFiles): Promise<TestRun>`

- [ ] **Step 1: Move the dependencies**

Run:
```bash
pnpm --filter @ccc/cli add vitest@^5.0.1 oxlint@^1.85.0
```
Expected: `packages/cli/package.json` lists both under `dependencies` and no longer lists `vitest` under `devDependencies`. If pnpm leaves `vitest` in `devDependencies` too, delete that entry by hand and run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/cli/test/toolchain.test.ts`:
```ts
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintFiles, runTests, typecheckFiles, withScratch } from '../src/toolchain.js';
import { writeProject } from './helpers.js';

const CARD = 'export function card(rank: string): { rank: string } {\n  return { rank };\n}\n';
const CARD_TEST = [
  "import { card } from './card.js';",
  '',
  "describe('card', () => {",
  "  it('[ex 1] passes', () => {",
  "    expect(card('A').rank).toBe('A');",
  '  });',
  "  it('[ex 2] fails', () => {",
  "    expect(card('A').rank).toBe('K');",
  '  });',
  '});',
  '',
].join('\n');

async function project(files: Record<string, string>): Promise<string> {
  return writeProject({ 'package.json': '{"type":"module"}\n', ...files });
}

describe('typecheckFiles', () => {
  it('reports errors with project-relative files and lines, and knows Vitest globals', async () => {
    const root = await project({
      '.ccc/gen/card.ts': CARD,
      '.ccc/gen/card.test.ts': CARD_TEST,
      '.ccc/gen/bad.ts': "export const n: number = 'x';\n",
    });
    const issues = await typecheckFiles(root, ['.ccc/gen/card.test.ts', '.ccc/gen/bad.ts']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe('.ccc/gen/bad.ts');
    expect(issues[0]?.line).toBe(1);
    expect(issues[0]?.message).toMatch(/\(TS2322\)$/);
  });
});

describe('lintFiles', () => {
  it('reports explicit any', async () => {
    const root = await project({ '.ccc/gen/any.ts': 'export const x: any = 1;\n', '.ccc/gen/ok.ts': CARD });
    const issues = await lintFiles(root, ['.ccc/gen/any.ts', '.ccc/gen/ok.ts']);
    expect(issues).toEqual([
      { file: '.ccc/gen/any.ts', line: 1, message: expect.stringMatching(/no-explicit-any/) },
    ]);
  });
});

describe('runTests', () => {
  it('reports passing and failing cases', async () => {
    const root = await project({ '.ccc/gen/card.ts': CARD, '.ccc/gen/card.test.ts': CARD_TEST });
    const run = await runTests(root, ['.ccc/gen/card.test.ts']);
    expect(run.errors).toEqual([]);
    expect(run.cases.map((c) => `${c.file} ${c.name} ${c.status}`)).toEqual([
      '.ccc/gen/card.test.ts [ex 1] passes passed',
      '.ccc/gen/card.test.ts [ex 2] fails failed',
    ]);
    expect(run.cases[1]?.message).toContain("expected 'A' to be 'K'");
  });

  it('reports a test file that cannot run', async () => {
    const root = await project({ '.ccc/gen/broken.test.ts': "import { nope } from './missing.js';\nit('[ex 1] x', () => nope());\n" });
    const run = await runTests(root, ['.ccc/gen/broken.test.ts']);
    expect(run.cases).toEqual([]);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]?.file).toBe('.ccc/gen/broken.test.ts');
  });
});

describe('withScratch', () => {
  it('removes its directory afterwards', async () => {
    const root = await project({});
    const seen = await withScratch(root, async (dir) => dir);
    expect(await readdir(path.dirname(seen))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run toolchain`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`packages/cli/src/toolchain.ts`:
```ts
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { SCRATCH_DIR } from './layout.js';
import { parseTscLines, runTsc } from './tsc.js';

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

export interface ToolIssue {
  file: string;
  line: number | null;
  message: string;
}

function packageDir(name: string): string {
  return path.dirname(requireFromHere.resolve(`${name}/package.json`));
}

export function vitestGlobalsPath(): string {
  return path.join(packageDir('vitest'), 'globals.d.ts');
}

// Scratch space inside the project so module resolution still finds the
// project's node_modules.
export async function withScratch<T>(root: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const base = path.join(await realpath(root), SCRATCH_DIR);
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'run-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function toProjectPath(realRoot: string, absolute: string): string {
  return path.relative(realRoot, absolute).split(path.sep).join('/');
}

// Child tools inherit a clean environment: no Vitest variables from a parent
// test run, and PWD matching cwd (TS 7 prints paths relative to $PWD).
function childEnv(cwd: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  return { ...env, PWD: cwd };
}

interface ToolOutput {
  stdout: string;
  stderr: string;
}

async function runAllowingFailure(args: readonly string[], cwd: string): Promise<ToolOutput> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...args], {
      cwd,
      env: childEnv(cwd),
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
    });
    return { stdout, stderr };
  } catch (err) {
    if (err instanceof Error && 'stdout' in err && typeof err.stdout === 'string') {
      return { stdout: err.stdout, stderr: 'stderr' in err && typeof err.stderr === 'string' ? err.stderr : '' };
    }
    throw err;
  }
}

const GENERATED_COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  module: 'nodenext',
  moduleResolution: 'nodenext',
  target: 'es2024',
  lib: ['es2024', 'dom'],
  types: [],
  skipLibCheck: true,
};

export async function typecheckFiles(root: string, files: readonly string[]): Promise<ToolIssue[]> {
  const realRoot = await realpath(root);
  return withScratch(root, async (dir) => {
    const tsconfig = path.join(dir, 'tsconfig.json');
    await writeFile(
      tsconfig,
      JSON.stringify(
        {
          compilerOptions: GENERATED_COMPILER_OPTIONS,
          files: [vitestGlobalsPath(), ...files.map((file) => path.join(realRoot, file))],
        },
        null,
        2,
      ),
    );
    const { messages, other } = parseTscLines(await runTsc(tsconfig, dir));
    return [
      ...messages.map((m) => ({
        file: toProjectPath(realRoot, path.resolve(dir, m.file)),
        line: m.line,
        message: `${m.message} (${m.code})`,
      })),
      ...other.map((line) => ({ file: '', line: null, message: line })),
    ];
  });
}

const oxlintReportSchema = z.object({
  diagnostics: z.array(
    z.object({
      message: z.string(),
      code: z.string().default(''),
      severity: z.string().default('error'),
      filename: z.string(),
      labels: z.array(z.object({ span: z.object({ line: z.number() }) })).default([]),
    }),
  ),
});

export async function lintFiles(root: string, files: readonly string[]): Promise<ToolIssue[]> {
  if (files.length === 0) {
    return [];
  }
  const realRoot = await realpath(root);
  return withScratch(root, async (dir) => {
    const config = path.join(dir, 'oxlintrc.json');
    await writeFile(config, JSON.stringify({ plugins: ['typescript'], rules: { 'typescript/no-explicit-any': 'error' } }));
    const { stdout } = await runAllowingFailure(
      [path.join(packageDir('oxlint'), 'bin', 'oxlint'), '-c', config, '-f', 'json', ...files.map((f) => path.join(realRoot, f))],
      realRoot,
    );
    const report = oxlintReportSchema.parse(JSON.parse(stdout.slice(stdout.indexOf('{'))));
    return report.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => ({
        file: toProjectPath(realRoot, path.resolve(realRoot, d.filename)),
        line: d.labels[0]?.span.line ?? null,
        message: `${d.message} (${d.code})`,
      }));
  });
}

export interface TestCase {
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  message: string;
}

export interface TestRun {
  cases: TestCase[];
  errors: ToolIssue[];
}

const vitestReportSchema = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string().default(''),
      assertionResults: z
        .array(
          z.object({
            title: z.string(),
            status: z.string(),
            failureMessages: z.array(z.string()).nullable().default([]),
          }),
        )
        .default([]),
    }),
  ),
});

function caseStatus(status: string): TestCase['status'] {
  return status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped';
}

export async function runTests(root: string, testFiles: readonly string[]): Promise<TestRun> {
  if (testFiles.length === 0) {
    return { cases: [], errors: [] };
  }
  const realRoot = await realpath(root);
  return withScratch(root, async (dir) => {
    const config = path.join(dir, 'vitest.config.mjs');
    const report = path.join(dir, 'report.json');
    const settings = {
      cacheDir: path.join(dir, 'cache'),
      test: { globals: true, include: ['.ccc/gen/**/*.test.ts'], watch: false, testTimeout: 10_000 },
    };
    await writeFile(config, `export default ${JSON.stringify(settings)};\n`);
    const { stdout, stderr } = await runAllowingFailure(
      [
        path.join(packageDir('vitest'), 'vitest.mjs'),
        'run',
        '--root',
        realRoot,
        '--config',
        config,
        '--reporter=json',
        `--outputFile=${report}`,
        ...testFiles,
      ],
      realRoot,
    );
    const text = await readFile(report, 'utf8').catch(() => null);
    if (text === null) {
      return { cases: [], errors: [{ file: '', line: null, message: `vitest produced no report:\n${`${stdout}${stderr}`.slice(-2000)}` }] };
    }
    const parsed = vitestReportSchema.parse(JSON.parse(text));
    const cases: TestCase[] = [];
    const errors: ToolIssue[] = [];
    for (const result of parsed.testResults) {
      const file = toProjectPath(realRoot, await realpath(result.name).catch(() => result.name));
      if (result.assertionResults.length === 0 && result.status !== 'passed') {
        errors.push({ file, line: null, message: result.message || 'test file failed to run' });
      }
      for (const assertion of result.assertionResults) {
        cases.push({
          file,
          name: assertion.title,
          status: caseStatus(assertion.status),
          message: (assertion.failureMessages ?? []).join('\n'),
        });
      }
    }
    return { cases, errors };
  });
}
```

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run toolchain` (expected: PASS; allow about 10 s), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/package.json pnpm-lock.yaml packages/cli/src/toolchain.ts packages/cli/test/toolchain.test.ts
git commit -m "Run tsc, oxlint, and Vitest on generated code"
```

---

### Task 8: Generators (Claude and fake)

**Files:**
- Create: `packages/cli/src/llm.ts`, `packages/cli/src/anthropic.ts`, `packages/cli/test/fake-generator.ts`
- Modify: `packages/cli/package.json` (add `@anthropic-ai/sdk`)
- Test: `packages/cli/test/anthropic.test.ts`, `packages/cli/test/fake-generator.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `llm.ts`: `interface Usage { inputTokens: number; outputTokens: number }`; `interface Turn { code: string | null; note: string; usage: Usage; model: string }`; `interface Session { send(message: string): Promise<Turn> }`; `interface SessionOptions { model: string; system: string }`; `interface Generator { start(options: SessionOptions): Session }`; `NO_TOOL_CALL_NOTE = 'you did not call write_module'`
  - `anthropic.ts`: `MAX_TOKENS = 64_000`; `WRITE_MODULE_TOOL: BetaTool`; `interface StreamedReply`; `type Streamer = (params: BetaMessageStreamParams) => Promise<StreamedReply>`; `defaultStreamer(): Streamer`; `buildRequest(options, messages): BetaMessageStreamParams`; `class AnthropicGenerator implements Generator` (`constructor(streamer: Streamer | null = null)`; the real client is created on the first `start`)
  - `test/fake-generator.ts`: `interface FakeRequest { model: string; system: string; messages: readonly string[] }`; `type FakeResponder = (request: FakeRequest) => string | null`; `class FakeGenerator implements Generator` with `requests: FakeRequest[]` and `constructor(responder: FakeResponder)`; each turn reports usage `{ inputTokens: 100, outputTokens: 50 }`

- [ ] **Step 1: Add the SDK**

Run: `pnpm --filter @ccc/cli add @anthropic-ai/sdk@^0.128.0`
Expected: added under `dependencies`.

- [ ] **Step 2: Write the fake generator and the failing tests**

`packages/cli/test/fake-generator.ts`:
```ts
import { NO_TOOL_CALL_NOTE, type Generator, type Session, type SessionOptions } from '../src/llm.js';

export interface FakeRequest {
  model: string;
  system: string;
  messages: readonly string[];
}

export type FakeResponder = (request: FakeRequest) => string | null;

// Scripted stand-in for Claude: the responder sees the whole session so far
// and returns the code for this turn (null means "no tool call").
export class FakeGenerator implements Generator {
  readonly requests: FakeRequest[] = [];
  readonly #responder: FakeResponder;

  constructor(responder: FakeResponder) {
    this.#responder = responder;
  }

  start(options: SessionOptions): Session {
    const messages: string[] = [];
    return {
      send: async (message) => {
        messages.push(message);
        const request: FakeRequest = { model: options.model, system: options.system, messages: [...messages] };
        this.requests.push(request);
        const code = this.#responder(request);
        return {
          code,
          note: code === null ? NO_TOOL_CALL_NOTE : '',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: options.model,
        };
      },
    };
  }
}
```

`packages/cli/test/fake-generator.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeGenerator } from './fake-generator.js';

describe('FakeGenerator', () => {
  it('records each turn with the session history', async () => {
    const fake = new FakeGenerator((request) => (request.messages.length === 1 ? null : 'code'));
    const session = fake.start({ model: 'm', system: 's' });
    expect((await session.send('first')).code).toBeNull();
    expect((await session.send('second')).code).toBe('code');
    expect(fake.requests.map((r) => r.messages)).toEqual([['first'], ['first', 'second']]);
  });
});
```

`packages/cli/test/anthropic.test.ts`:
```ts
import type {
  BetaContentBlock,
  BetaMessageStreamParams,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { AnthropicGenerator, MAX_TOKENS, type StreamedReply } from '../src/anthropic.js';

function reply(content: BetaContentBlock[], stopReason: BetaStopReason = 'tool_use'): StreamedReply {
  return {
    content,
    stop_reason: stopReason,
    model: 'claude-opus-5',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: null },
  };
}
const writeCall = (id: string, code: string): BetaContentBlock => ({ type: 'tool_use', id, name: 'write_module', input: { code } });
const text = (value: string): BetaContentBlock => ({ type: 'text', text: value, citations: null });

function scripted(replies: StreamedReply[]) {
  const params: BetaMessageStreamParams[] = [];
  const generator = new AnthropicGenerator(async (request) => {
    params.push(request);
    const next = replies.shift();
    if (next === undefined) throw new Error('no scripted reply left');
    return next;
  });
  return { params, generator };
}

describe('AnthropicGenerator', () => {
  it('sends the request shape ccc relies on', async () => {
    const { params, generator } = scripted([reply([writeCall('t1', 'export {};')])]);
    const turn = await generator.start({ model: 'claude-opus-5', system: 'sys' }).send('write it');
    expect(turn).toEqual({ code: 'export {};', note: '', usage: { inputTokens: 13, outputTokens: 5 }, model: 'claude-opus-5' });
    const [first] = params;
    expect(first?.model).toBe('claude-opus-5');
    expect(first?.max_tokens).toBe(MAX_TOKENS);
    expect(first?.system).toBe('sys');
    expect(first?.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(first?.fallbacks).toBe('default');
    expect(first?.thinking).toEqual({ type: 'adaptive' });
    expect(first?.tool_choice).toEqual({ type: 'auto' });
    expect(first?.tools?.[0]).toMatchObject({ name: 'write_module', strict: true });
    expect(first?.messages).toEqual([{ role: 'user', content: 'write it' }]);
  });

  it('answers the previous tool call with an error result when sending feedback', async () => {
    const { params, generator } = scripted([reply([text('ok'), writeCall('t1', 'a')]), reply([writeCall('t2', 'b')])]);
    const session = generator.start({ model: 'claude-opus-5', system: 's' });
    await session.send('first');
    const second = await session.send('fix it');
    expect(second.code).toBe('b');
    const messages = params[1]?.messages ?? [];
    expect(messages[1]).toEqual({ role: 'assistant', content: [text('ok'), writeCall('t1', 'a')] });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'fix it' }],
    });
  });

  it('treats a reply without a tool call as a failed turn and continues with plain text', async () => {
    const { params, generator } = scripted([reply([text('I think...')], 'end_turn'), reply([writeCall('t1', 'c')])]);
    const session = generator.start({ model: 'claude-opus-5', system: 's' });
    expect(await session.send('go')).toMatchObject({ code: null, note: 'you did not call write_module' });
    await session.send('call the tool');
    expect(params[1]?.messages[2]).toEqual({ role: 'user', content: 'call the tool' });
  });

  it('reports refusals and truncation, and still closes a truncated tool call', async () => {
    const refusal = scripted([reply([], 'refusal')]);
    expect(await refusal.generator.start({ model: 'claude-opus-5', system: 's' }).send('go')).toMatchObject({
      code: null,
      note: 'the model declined this request',
    });

    const truncated: BetaContentBlock = { type: 'tool_use', id: 't9', name: 'write_module', input: {} };
    const cut = scripted([reply([truncated], 'max_tokens'), reply([writeCall('t10', 'd')])]);
    const session = cut.generator.start({ model: 'claude-opus-5', system: 's' });
    expect((await session.send('go')).note).toBe('the reply hit max_tokens (64000) and was cut off; write a shorter module');
    await session.send('shorter please');
    expect(cut.params[1]?.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'shorter please' }],
    });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run anthropic fake-generator`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`packages/cli/src/llm.ts`:
```ts
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// One model turn: the module it wrote (null if it didn't call write_module)
// and why not.
export interface Turn {
  code: string | null;
  note: string;
  usage: Usage;
  model: string;
}

export interface Session {
  send(message: string): Promise<Turn>;
}

export interface SessionOptions {
  model: string;
  system: string;
}

export interface Generator {
  start(options: SessionOptions): Session;
}

export const NO_TOOL_CALL_NOTE = 'you did not call write_module';
```

`packages/cli/src/anthropic.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaStopReason,
  BetaTool,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import { NO_TOOL_CALL_NOTE, type Generator, type Session, type SessionOptions, type Turn } from './llm.js';

export const MAX_TOKENS = 64_000;

export const WRITE_MODULE_TOOL: BetaTool = {
  name: 'write_module',
  description: 'Write the complete TypeScript source of the requested module. Always pass the whole file.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { code: { type: 'string', description: 'Complete TypeScript source of the module' } },
    required: ['code'],
    additionalProperties: false,
  },
};

// The subset of BetaMessage ccc reads; the SDK's message satisfies it.
export interface StreamedReply {
  content: BetaContentBlock[];
  stop_reason: BetaStopReason | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
}

export type Streamer = (params: BetaMessageStreamParams) => Promise<StreamedReply>;

const writeModuleCall = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.literal('write_module'),
  input: z.object({ code: z.string() }),
});
const toolUse = z.object({ type: z.literal('tool_use'), id: z.string() });

// Credentials come from the SDK's own resolution (ANTHROPIC_API_KEY or an
// `ant auth login` profile); ccc never reads them.
export function defaultStreamer(): Streamer {
  const client = new Anthropic();
  return (params) => client.beta.messages.stream(params).finalMessage();
}

export function buildRequest(options: SessionOptions, messages: readonly BetaMessageParam[]): BetaMessageStreamParams {
  return {
    model: options.model,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system: options.system,
    tools: [WRITE_MODULE_TOOL],
    tool_choice: { type: 'auto' },
    messages: [...messages],
  };
}

export class AnthropicGenerator implements Generator {
  #streamer: Streamer | null;

  constructor(streamer: Streamer | null = null) {
    this.#streamer = streamer;
  }

  start(options: SessionOptions): Session {
    this.#streamer ??= defaultStreamer();
    const stream = this.#streamer;
    const messages: BetaMessageParam[] = [];
    let openToolUses: string[] = [];
    return {
      send: async (text: string): Promise<Turn> => {
        if (openToolUses.length === 0) {
          messages.push({ role: 'user', content: text });
        } else {
          // Every tool_use needs a tool_result; feedback goes on the first.
          const results: BetaToolResultBlockParam[] = openToolUses.map((id, index) => ({
            type: 'tool_result',
            tool_use_id: id,
            is_error: true,
            content: index === 0 ? text : 'Ignored: only the first write_module call is used.',
          }));
          messages.push({ role: 'user', content: results });
        }
        const reply = await stream(buildRequest(options, messages));
        messages.push({ role: 'assistant', content: reply.content });
        openToolUses = reply.content.flatMap((block) => {
          const parsed = toolUse.safeParse(block);
          return parsed.success ? [parsed.data.id] : [];
        });
        const usage = {
          inputTokens:
            reply.usage.input_tokens + (reply.usage.cache_read_input_tokens ?? 0) + (reply.usage.cache_creation_input_tokens ?? 0),
          outputTokens: reply.usage.output_tokens,
        };
        const turn = (code: string | null, note: string): Turn => ({ code, note, usage, model: reply.model });
        if (reply.stop_reason === 'refusal') {
          return turn(null, 'the model declined this request');
        }
        if (reply.stop_reason === 'max_tokens') {
          return turn(null, `the reply hit max_tokens (${MAX_TOKENS}) and was cut off; write a shorter module`);
        }
        for (const block of reply.content) {
          const call = writeModuleCall.safeParse(block);
          if (call.success) {
            return turn(call.data.input.code, '');
          }
        }
        return turn(null, NO_TOOL_CALL_NOTE);
      },
    };
  }
}
```

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run anthropic fake-generator` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/package.json pnpm-lock.yaml packages/cli/src/llm.ts packages/cli/src/anthropic.ts packages/cli/test/fake-generator.ts packages/cli/test/fake-generator.test.ts packages/cli/test/anthropic.test.ts
git commit -m "Add the Generator interface, Claude generator, and a fake for tests"
```

---

### Task 9: Request assembly

**Files:**
- Create: `packages/cli/src/context.ts`
- Test: `packages/cli/test/context.test.ts`

**Interfaces:**
- Consumes: `interfaceTextOf`, `ExportsByConcept` (Task 4); `dependenciesOf` (Plan 1); `modulePath`, `testPath`, `ownModuleSpecifier`, `relativeImport` (Task 2); `PACKAGES_BY_KIND` (Task 6).
- Produces: `interface DependencyView { id: ConceptId; specifier: string; declarations: string }`; `dependencyViews(concept, project, exportsByConcept, ids?: readonly ConceptId[]): DependencyView[]`; `testRequest(concept, project, exportsByConcept, testDependencies: readonly ConceptId[]): string`; `implRequest(concept, project, exportsByConcept, testSource: string): string`; `MAX_FEEDBACK_PROBLEMS = 50`; `feedbackMessage(problems: readonly string[]): string`. Every request's first line contains ``concept `<id>` `` (the fake generator routes on it).

- [ ] **Step 1: Write the failing test**

`packages/cli/test/context.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { feedbackMessage, implRequest, testRequest } from '../src/context.js';
import { collectExports } from '../src/interfaces.js';
import { concept, projectFrom } from './helpers.js';

const project = projectFrom({
  'card.md': concept('kind: value\ninterface: export interface Card { readonly rank: string }'),
  'hand.md': concept(
    'kind: collection\nof: card\ninterface: |\n  export class Hand {\n    add(card: Card): void;\n  }',
    '## Intent\nCards held.\n\n## Rules\n- no duplicates\n\n## Examples\n- add a card\n- reject a duplicate\n',
  ),
});
const exportsByConcept = collectExports(project);
const hand = project.concepts.get('hand');
if (hand === undefined) throw new Error('fixture');

describe('testRequest', () => {
  it('asks for one tagged test per example against the interface only', () => {
    const request = testRequest(hand, project, exportsByConcept, ['card']);
    expect(request.split('\n')[0]).toBe('Write the Vitest test file for concept `hand` (collection).');
    expect(request).toContain('Test file: .ccc/gen/hand.test.ts');
    expect(request).toContain("Import the module under test from './hand.js'.");
    expect(request).toContain('[ex 1] add a card\n[ex 2] reject a duplicate');
    expect(request).toContain("### card: import from './card.js'");
    expect(request).toContain('export class Hand {');
    expect(request).not.toContain('no duplicates');
  });
});

describe('implRequest', () => {
  it('includes the concept, dependencies, allowed packages, and tests', () => {
    const request = implRequest(hand, project, exportsByConcept, "it('[ex 1] adds', () => {});");
    expect(request.split('\n')[0]).toBe('Write the implementation module for concept `hand` (collection).');
    expect(request).toContain('Module: .ccc/gen/hand.ts');
    expect(request).toContain('Allowed packages: @ccc/runtime.');
    expect(request).toContain('## Rules\n- no duplicates');
    expect(request).toContain("### card: import from './card.js'\n```ts\nexport interface Card { readonly rank: string }\n```");
    expect(request).toContain("## Tests your module must pass (.ccc/gen/hand.test.ts)\n```ts\nit('[ex 1] adds', () => {});\n```");
  });

  it('says so when there are no dependencies', () => {
    const card = project.concepts.get('card');
    if (card === undefined) throw new Error('fixture');
    expect(implRequest(card, project, exportsByConcept, '')).toContain('## Dependencies\nNone.');
  });
});

describe('feedbackMessage', () => {
  it('lists problems and caps the list', () => {
    expect(feedbackMessage(['a', 'b'])).toBe(
      'Your module failed these checks. Fix every problem and call write_module again with the complete file.\n\n- a\n- b',
    );
    const many = feedbackMessage(Array.from({ length: 52 }, (_, i) => `p${i}`));
    expect(many).toContain('- p49\n- …and 2 more');
    expect(many).not.toContain('- p50');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run context`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/context.ts`:
```ts
import { dependenciesOf } from './graph.js';
import type { ConceptId } from './ids.js';
import { PACKAGES_BY_KIND } from './imports.js';
import { interfaceTextOf, type ExportsByConcept } from './keys.js';
import { modulePath, ownModuleSpecifier, relativeImport, testPath } from './layout.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';

export interface DependencyView {
  id: ConceptId;
  specifier: string;
  declarations: string;
}

export function dependencyViews(
  concept: Concept,
  project: Project,
  exportsByConcept: ExportsByConcept,
  ids?: readonly ConceptId[],
): DependencyView[] {
  return (ids ?? dependenciesOf(concept, project)).flatMap((id) => {
    const dep = project.concepts.get(id);
    return dep === undefined
      ? []
      : [{ id, specifier: relativeImport(concept.id, id), declarations: interfaceTextOf(dep, exportsByConcept).trim() }];
  });
}

function fence(code: string): string {
  return ['```ts', code.trimEnd(), '```'].join('\n');
}

function dependencySection(views: readonly DependencyView[]): string[] {
  if (views.length === 0) {
    return ['## Dependencies', 'None.'];
  }
  return [
    '## Dependencies you may import',
    ...views.flatMap((view) => ['', `### ${view.id}: import from '${view.specifier}'`, fence(view.declarations)]),
  ];
}

// The test writer sees the interface, Intent, and Examples only; never the
// Rules or an implementation (spec §4.4).
export function testRequest(
  concept: Concept,
  project: Project,
  exportsByConcept: ExportsByConcept,
  testDependencies: readonly ConceptId[],
): string {
  return [
    `Write the Vitest test file for concept \`${concept.id}\` (${concept.frontmatter.kind}).`,
    '',
    `Test file: ${testPath(concept.id)}`,
    `Import the module under test from '${ownModuleSpecifier(concept.id)}'.`,
    'Vitest globals (describe, it, expect, vi) are available; do not import vitest.',
    '',
    '## Interface of the module under test',
    fence(interfaceTextOf(concept, exportsByConcept)),
    '',
    '## Intent',
    concept.sections.get('Intent')?.body ?? '',
    '',
    '## Examples',
    'Write exactly one test per example. Start each test name with its tag.',
    ...concept.examples.map((example, index) => `[ex ${index + 1}] ${example}`),
    '',
    ...dependencySection(dependencyViews(concept, project, exportsByConcept, testDependencies)),
    '',
  ].join('\n');
}

export function implRequest(concept: Concept, project: Project, exportsByConcept: ExportsByConcept, testSource: string): string {
  const sections = ['Intent', 'Rules', 'Examples', 'Decisions', 'Schema'].flatMap((name) => {
    const section = concept.sections.get(name);
    return section === undefined ? [] : ['', `## ${name}`, section.body];
  });
  return [
    `Write the implementation module for concept \`${concept.id}\` (${concept.frontmatter.kind}).`,
    '',
    `Module: ${modulePath(concept.id)}`,
    'Export exactly the declarations in the interface below: no more, no fewer.',
    `Allowed packages: ${PACKAGES_BY_KIND[concept.frontmatter.kind].join(', ')}.`,
    '',
    '## Interface',
    fence(interfaceTextOf(concept, exportsByConcept)),
    ...sections,
    '',
    ...dependencySection(dependencyViews(concept, project, exportsByConcept)),
    '',
    `## Tests your module must pass (${testPath(concept.id)})`,
    fence(testSource),
    '',
  ].join('\n');
}

export const MAX_FEEDBACK_PROBLEMS = 50;

export function feedbackMessage(problems: readonly string[]): string {
  const shown = problems
    .slice(0, MAX_FEEDBACK_PROBLEMS)
    .map((problem) => `- ${problem.length > 2000 ? `${problem.slice(0, 2000)}…` : problem}`);
  const more = problems.length > MAX_FEEDBACK_PROBLEMS ? [`- …and ${problems.length - MAX_FEEDBACK_PROBLEMS} more`] : [];
  return [
    'Your module failed these checks. Fix every problem and call write_module again with the complete file.',
    '',
    ...shown,
    ...more,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run context` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/context.ts packages/cli/test/context.test.ts
git commit -m "Assemble generation requests and feedback messages"
```

---

### Task 10: Generation loop and test generation

**Files:**
- Create: `packages/cli/src/generation.ts`, `packages/cli/src/testgen.ts`, `packages/cli/test/pipeline-fixture.ts`
- Test: `packages/cli/test/generation.test.ts`, `packages/cli/test/testgen.test.ts`

**Interfaces:**
- Consumes: `Generator`, `Usage` (Task 8); `feedbackMessage`, `testRequest` (Task 9); `Generation` (Task 5); `costUsd` (Task 1); `Config` (Task 1); `ExportsByConcept` (Task 4); `readPrompt` (Task 4); `checkImports`, `testImportsFor`, `transitiveDependencies`, `TEST_PACKAGES` (Task 6); `typecheckFiles`, `withScratch` (Task 7); `emitInterfaces` (Plan 1 + Task 3).
- Produces:
  - `generation.ts`: `interface GenerationOutcome { source: string | null; record: Generation; problems: string[] }`; `interface LoopOptions { generator: Generator; model: string; system: string; firstMessage: string; maxAttempts: number; artifact: 'tests' | 'impl'; now: () => number; check: (code: string) => Promise<string[]> }`; `generationLoop(options: LoopOptions): Promise<GenerationOutcome>`; `generationRecord(...)`
  - `testgen.ts`: `interface GenerateContext { root: string; project: Project; exportsByConcept: ExportsByConcept; generator: Generator; config: Config; now: () => number }`; `exampleTags(source: string): number[]`; `tagProblems(tags: readonly number[], count: number): string[]`; `checkTestSource(ctx, concept, source): Promise<string[]>`; `generateTests(ctx, concept): Promise<GenerationOutcome>`
  - `test/pipeline-fixture.ts`: `PIPELINE_FILES`, `CANNED_TESTS`, `CANNED_IMPL` (records keyed by concept id), `conceptOf(request)`, `artifactOf(request)`, `type Overrides = Readonly<Record<string, (attempt: number) => string | null>>` keyed `'tests:<id>'` / `'impl:<id>'`, `pipelineResponder(overrides?: Overrides): FakeResponder`, `createPipelineProject(): Promise<string>`, `pipelineContext(root, generator, config?: Partial<Config>): Promise<GenerateContext>`

- [ ] **Step 1: Write the pipeline fixture**

`packages/cli/test/pipeline-fixture.ts`:
```ts
import { configSchema, type Config } from '../src/config.js';
import { collectExports } from '../src/interfaces.js';
import type { Generator } from '../src/llm.js';
import { loadProject } from '../src/load.js';
import type { GenerateContext } from '../src/testgen.js';
import type { FakeRequest, FakeResponder } from './fake-generator.js';
import { writeProject } from './helpers.js';

// Four concepts covering functions, a class with a dependency, an entity, and
// a sync. Levels: card, counter → hand → count-adds.
export const PIPELINE_FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "type": "module" }\n',
  'concepts/card.md': [
    '---',
    'kind: value',
    'interface: |',
    '  export interface Card {',
    '    readonly rank: string;',
    '    readonly suit: string;',
    '  }',
    '  export function card(rank: string, suit: string): Card;',
    '  export function sameCard(a: Card, b: Card): boolean;',
    '---',
    '## Intent',
    'A playing card.',
    '',
    '## Examples',
    '- card("A", "♠") → { rank: "A", suit: "♠" }',
    '- sameCard(card("A", "♠"), card("A", "♠")) → true',
    '',
  ].join('\n'),
  'concepts/hand.md': [
    '---',
    'kind: collection',
    'of: card',
    'interface: |',
    '  export class DuplicateCard extends Error {}',
    '  export class Hand {',
    '    constructor(cards?: readonly Card[]);',
    '    add(card: Card): void;',
    '    size(): number;',
    '  }',
    '---',
    '## Intent',
    'The cards a player holds.',
    '',
    '## Rules',
    '- A hand never holds the same card twice.',
    '',
    '## Examples',
    '- given an empty hand, add(A♠) → size is 1',
    '- given hand [A♠], add(A♠) → throws DuplicateCard',
    '',
  ].join('\n'),
  'concepts/counter.md': [
    '---',
    'kind: entity',
    'interface: |',
    '  export class Counter {',
    '    increment(): void;',
    '    value(): number;',
    '  }',
    '---',
    '## Intent',
    'Counts events.',
    '',
    '## Examples',
    '- new Counter().value() → 0',
    '- after increment(), value() → 1',
    '',
  ].join('\n'),
  'concepts/count-adds.md': [
    '---',
    'kind: sync',
    'when: hand#add',
    'then: [counter#increment]',
    '---',
    '## Intent',
    'Count every card added to a hand.',
    '',
    '## Examples',
    '- given a hand and a counter at 0, adding a card → counter is 1',
    '',
  ].join('\n'),
};

export const CANNED_TESTS: Readonly<Record<string, string>> = {
  card: [
    "import { card, sameCard } from './card.js';",
    '',
    "describe('card', () => {",
    "  it('[ex 1] builds a card', () => {",
    "    expect(card('A', '♠')).toEqual({ rank: 'A', suit: '♠' });",
    '  });',
    "  it('[ex 2] compares cards by rank and suit', () => {",
    "    expect(sameCard(card('A', '♠'), card('A', '♠'))).toBe(true);",
    '  });',
    '});',
    '',
  ].join('\n'),
  hand: [
    "import { card } from './card.js';",
    "import { DuplicateCard, Hand } from './hand.js';",
    '',
    "describe('Hand', () => {",
    "  it('[ex 1] adds a card to an empty hand', () => {",
    '    const hand = new Hand();',
    "    hand.add(card('A', '♠'));",
    '    expect(hand.size()).toBe(1);',
    '  });',
    "  it('[ex 2] rejects a duplicate card', () => {",
    "    const hand = new Hand([card('A', '♠')]);",
    "    expect(() => hand.add(card('A', '♠'))).toThrow(DuplicateCard);",
    '  });',
    '});',
    '',
  ].join('\n'),
  counter: [
    "import { Counter } from './counter.js';",
    '',
    "describe('Counter', () => {",
    "  it('[ex 1] starts at zero', () => {",
    '    expect(new Counter().value()).toBe(0);',
    '  });',
    "  it('[ex 2] counts increments', () => {",
    '    const counter = new Counter();',
    '    counter.increment();',
    '    expect(counter.value()).toBe(1);',
    '  });',
    '});',
    '',
  ].join('\n'),
  'count-adds': [
    "import { card } from './card.js';",
    "import { Counter } from './counter.js';",
    "import { Hand } from './hand.js';",
    "import { handle } from './count-adds.js';",
    '',
    "describe('count-adds', () => {",
    "  it('[ex 1] increments the counter when a card is added', async () => {",
    '    const hand = new Hand();',
    '    const counter = new Counter();',
    "    await handle({ target: hand, args: [card('A', '♠')], result: undefined }, { counter });",
    '    expect(counter.value()).toBe(1);',
    '  });',
    '});',
    '',
  ].join('\n'),
};

export const CANNED_IMPL: Readonly<Record<string, string>> = {
  card: [
    'export interface Card {',
    '  readonly rank: string;',
    '  readonly suit: string;',
    '}',
    '',
    'export function card(rank: string, suit: string): Card {',
    '  return { rank, suit };',
    '}',
    '',
    'export function sameCard(a: Card, b: Card): boolean {',
    '  return a.rank === b.rank && a.suit === b.suit;',
    '}',
    '',
  ].join('\n'),
  hand: [
    "import { sameCard, type Card } from './card.js';",
    '',
    'export class DuplicateCard extends Error {}',
    '',
    'export class Hand {',
    '  readonly #cards: Card[];',
    '',
    '  constructor(cards: readonly Card[] = []) {',
    '    this.#cards = [...cards];',
    '  }',
    '',
    '  add(card: Card): void {',
    '    if (this.#cards.some((held) => sameCard(held, card))) {',
    '      throw new DuplicateCard(`${card.rank}${card.suit} is already in the hand`);',
    '    }',
    '    this.#cards.push(card);',
    '  }',
    '',
    '  size(): number {',
    '    return this.#cards.length;',
    '  }',
    '}',
    '',
  ].join('\n'),
  counter: [
    'export class Counter {',
    '  #count = 0;',
    '',
    '  increment(): void {',
    '    this.#count += 1;',
    '  }',
    '',
    '  value(): number {',
    '    return this.#count;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'count-adds': [
    "import type { Counter } from './counter.js';",
    "import type { Hand } from './hand.js';",
    '',
    'export interface SyncEvent {',
    '  readonly target: Hand;',
    "  readonly args: Parameters<Hand['add']>;",
    "  readonly result: Awaited<ReturnType<Hand['add']>>;",
    '}',
    '',
    'export interface SyncTargets {',
    '  readonly counter: Counter;',
    '}',
    '',
    'export async function handle(_event: SyncEvent, targets: SyncTargets): Promise<void> {',
    '  targets.counter.increment();',
    '}',
    '',
  ].join('\n'),
};

export function conceptOf(request: FakeRequest): string {
  return /concept `([^`]+)`/.exec(request.messages[0] ?? '')?.[1] ?? '';
}

export function artifactOf(request: FakeRequest): 'tests' | 'impl' {
  return request.system.startsWith('You are the test writer') ? 'tests' : 'impl';
}

export type Overrides = Readonly<Record<string, (attempt: number) => string | null>>;

// Answers with the canned source for the concept unless an override for
// `<artifact>:<id>` exists; overrides get the attempt number (1-based).
export function pipelineResponder(overrides: Overrides = {}): FakeResponder {
  return (request) => {
    const id = conceptOf(request);
    const artifact = artifactOf(request);
    const override = overrides[`${artifact}:${id}`];
    if (override !== undefined) {
      return override(request.messages.length);
    }
    return (artifact === 'tests' ? CANNED_TESTS : CANNED_IMPL)[id] ?? null;
  };
}

export async function createPipelineProject(): Promise<string> {
  return writeProject({ ...PIPELINE_FILES });
}

export async function pipelineContext(root: string, generator: Generator, config: Partial<Config> = {}): Promise<GenerateContext> {
  const { project } = await loadProject(root);
  return {
    root,
    project,
    exportsByConcept: collectExports(project),
    generator,
    config: { ...configSchema.parse({}), ...config },
    now: Date.now,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/generation.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { generationLoop } from '../src/generation.js';
import { FakeGenerator } from './fake-generator.js';

function options(fake: FakeGenerator, check: (code: string) => Promise<string[]>) {
  let clock = 1000;
  return {
    generator: fake,
    model: 'claude-opus-5',
    system: 'sys',
    firstMessage: 'first',
    maxAttempts: 3,
    artifact: 'impl' as const,
    now: () => (clock += 10),
    check,
  };
}

describe('generationLoop', () => {
  it('returns the first code that passes its checks, with a record', async () => {
    const fake = new FakeGenerator((request) => (request.messages.length === 1 ? 'bad' : 'good'));
    const outcome = await generationLoop(options(fake, async (code) => (code === 'good' ? [] : ['it is bad'])));
    expect(outcome.source).toBe('good');
    expect(outcome.problems).toEqual([]);
    expect(outcome.record).toEqual({
      artifact: 'impl',
      at: new Date(1010).toISOString(),
      model: 'claude-opus-5',
      attempts: 2,
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.0035,
      durationMs: 10,
      outcome: 'passed',
    });
    expect(fake.requests[1]?.messages[1]).toContain('- it is bad');
  });

  it('gives up after maxAttempts and keeps the last problems', async () => {
    const fake = new FakeGenerator(() => null);
    const outcome = await generationLoop(options(fake, async () => []));
    expect(outcome.source).toBeNull();
    expect(outcome.record.outcome).toBe('failed');
    expect(outcome.record.attempts).toBe(3);
    expect(outcome.problems).toEqual(['you did not call write_module; call write_module with the complete file']);
  });
});
```

`packages/cli/test/testgen.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { exampleTags, generateTests, tagProblems } from '../src/testgen.js';
import { FakeGenerator } from './fake-generator.js';
import { CANNED_TESTS, createPipelineProject, pipelineContext, pipelineResponder } from './pipeline-fixture.js';

describe('exampleTags / tagProblems', () => {
  it('reads tags from it() and test() calls', () => {
    expect(exampleTags("it('[ex 2] b', f);\ntest(\"[ex 1] a\", f);\nit.skip(`[ex 3] c`, f);")).toEqual([1, 2, 3]);
  });
  it('requires exactly one test per example', () => {
    expect(tagProblems([1, 2], 2)).toEqual([]);
    expect(tagProblems([1, 3], 2)).toEqual([
      'write exactly one test per example, tagged [ex 1] through [ex 2]; found [ex 1], [ex 3]',
    ]);
    expect(tagProblems([], 1)).toEqual(['write exactly one test per example, tagged [ex 1] through [ex 1]; found no tags']);
  });
});

async function handTests(overrides: Parameters<typeof pipelineResponder>[0]) {
  const root = await createPipelineProject();
  const fake = new FakeGenerator(pipelineResponder(overrides));
  const ctx = await pipelineContext(root, fake);
  const hand = ctx.project.concepts.get('hand');
  if (hand === undefined) throw new Error('fixture');
  return { fake, outcome: await generateTests(ctx, hand) };
}

describe('generateTests', () => {
  it('accepts tests that match the examples and type-check against interfaces', async () => {
    const { fake, outcome } = await handTests({});
    expect(outcome.source).toBe(CANNED_TESTS.hand);
    expect(outcome.record).toMatchObject({ artifact: 'tests', attempts: 1, outcome: 'passed', model: 'claude-opus-5' });
    expect(fake.requests[0]?.system).toMatch(/^You are the test writer/);
  });

  it('asks again when tags are wrong', async () => {
    const good = CANNED_TESTS.hand ?? '';
    const { fake, outcome } = await handTests({
      'tests:hand': (attempt) => (attempt === 1 ? good.replace('[ex 2]', '[ex 3]') : good),
    });
    expect(outcome.record.attempts).toBe(2);
    expect(fake.requests[1]?.messages[1]).toContain('tagged [ex 1] through [ex 2]; found [ex 1], [ex 3]');
  });

  it('reports type errors and disallowed imports as problems', async () => {
    const good = CANNED_TESTS.hand ?? '';
    const typeError = await handTests({ 'tests:hand': () => good.replace('hand.size()', 'hand.nope()') });
    expect(typeError.outcome.source).toBeNull();
    expect(typeError.outcome.problems.join('\n')).toMatch(/line \d+: Property 'nope' does not exist/);
    const badImport = await handTests({ 'tests:hand': () => `import { x } from './secret.js';\n${good}` });
    expect(badImport.outcome.problems[0]).toMatch(/^line 1: '.\/secret.js' is not a dependency/);
  });

  it('fails after the configured attempts', async () => {
    const { outcome } = await handTests({ 'tests:hand': () => null });
    expect(outcome.source).toBeNull();
    expect(outcome.record).toMatchObject({ attempts: 3, outcome: 'failed' });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run generation testgen`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`packages/cli/src/generation.ts`:
```ts
import { feedbackMessage } from './context.js';
import type { Generator, Usage } from './llm.js';
import type { Generation } from './manifest.js';
import { costUsd } from './pricing.js';

export interface GenerationOutcome {
  source: string | null;
  record: Generation;
  problems: string[];
}

export interface LoopOptions {
  generator: Generator;
  model: string;
  system: string;
  firstMessage: string;
  maxAttempts: number;
  artifact: 'tests' | 'impl';
  now: () => number;
  check: (code: string) => Promise<string[]>;
}

export function generationRecord(
  artifact: 'tests' | 'impl',
  started: number,
  finished: number,
  model: string,
  attempts: number,
  usage: Usage,
  outcome: 'passed' | 'failed',
): Generation {
  return {
    artifact,
    at: new Date(started).toISOString(),
    model,
    attempts,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: costUsd(model, usage.inputTokens, usage.outputTokens),
    durationMs: finished - started,
    outcome,
  };
}

// One session per artifact: send the request, check the code, feed problems
// back, and stop at the first passing attempt or after maxAttempts.
export async function generationLoop(options: LoopOptions): Promise<GenerationOutcome> {
  const started = options.now();
  const session = options.generator.start({ model: options.model, system: options.system });
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let model = options.model;
  let message = options.firstMessage;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const turn = await session.send(message);
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    model = turn.model;
    problems = turn.code === null ? [`${turn.note}; call write_module with the complete file`] : await options.check(turn.code);
    if (turn.code !== null && problems.length === 0) {
      return {
        source: turn.code,
        problems: [],
        record: generationRecord(options.artifact, started, options.now(), model, attempt, usage, 'passed'),
      };
    }
    message = feedbackMessage(problems);
  }
  return {
    source: null,
    problems,
    record: generationRecord(options.artifact, started, options.now(), model, options.maxAttempts, usage, 'failed'),
  };
}
```

`packages/cli/src/testgen.ts`:
```ts
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { testRequest } from './context.js';
import { generationLoop, type GenerationOutcome } from './generation.js';
import { TEST_PACKAGES, checkImports, testImportsFor, transitiveDependencies } from './imports.js';
import { emitInterfaces } from './interfaces.js';
import type { ExportsByConcept } from './keys.js';
import type { Generator } from './llm.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { typecheckFiles, withScratch } from './toolchain.js';
import { readPrompt } from './versions.js';

export interface GenerateContext {
  root: string;
  project: Project;
  exportsByConcept: ExportsByConcept;
  generator: Generator;
  config: Config;
  now: () => number;
}

const TAG = /\b(?:it|test)(?:\.\w+)?\(\s*(['"`])\[ex (\d+)\]/g;

export function exampleTags(source: string): number[] {
  return [...source.matchAll(TAG)].map((match) => Number(match[2])).sort((a, b) => a - b);
}

export function tagProblems(tags: readonly number[], count: number): string[] {
  if (tags.length === count && tags.every((tag, index) => tag === index + 1)) {
    return [];
  }
  const found = tags.length === 0 ? 'no tags' : tags.map((tag) => `[ex ${tag}]`).join(', ');
  return [`write exactly one test per example, tagged [ex 1] through [ex ${count}]; found ${found}`];
}

// Tests are checked against interfaces only: every interface is written at
// its generated-module path in scratch space, so './hand.js' resolves to the
// declarations, not an implementation.
async function typecheckAgainstInterfaces(ctx: GenerateContext, concept: Concept, source: string): Promise<string[]> {
  const realRoot = await realpath(ctx.root);
  const interfaces = emitInterfaces(ctx.project, ctx.exportsByConcept).files;
  return withScratch(ctx.root, async (dir) => {
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
    await Promise.all(
      interfaces.map(async (file) => {
        const full = path.join(dir, file.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.content);
      }),
    );
    const testFile = path.join(dir, `${concept.id.split('.').join('/')}.test.ts`);
    await mkdir(path.dirname(testFile), { recursive: true });
    await writeFile(testFile, source);
    const rel = path.relative(realRoot, testFile).split(path.sep).join('/');
    const issues = await typecheckFiles(ctx.root, [rel]);
    return issues
      .filter((issue) => issue.file === rel || issue.file === '')
      .map((issue) => (issue.line === null ? issue.message : `line ${issue.line}: ${issue.message}`));
  });
}

export async function checkTestSource(ctx: GenerateContext, concept: Concept, source: string): Promise<string[]> {
  const problems = [
    ...tagProblems(exampleTags(source), concept.examples.length),
    ...checkImports(source, testImportsFor(concept, ctx.project), TEST_PACKAGES),
  ];
  return problems.length > 0 ? problems : typecheckAgainstInterfaces(ctx, concept, source);
}

export async function generateTests(ctx: GenerateContext, concept: Concept): Promise<GenerationOutcome> {
  return generationLoop({
    generator: ctx.generator,
    model: ctx.config.models.tests,
    system: await readPrompt('tests'),
    firstMessage: testRequest(concept, ctx.project, ctx.exportsByConcept, transitiveDependencies(concept, ctx.project)),
    maxAttempts: ctx.config.testMaxAttempts,
    artifact: 'tests',
    now: ctx.now,
    check: (code) => checkTestSource(ctx, concept, code),
  });
}
```

- [ ] **Step 5: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run generation testgen` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/generation.ts packages/cli/src/testgen.ts packages/cli/test/pipeline-fixture.ts packages/cli/test/generation.test.ts packages/cli/test/testgen.test.ts
git commit -m "Add the generation loop and independent test generation"
```

---

### Task 11: Deterministic generated files

**Files:**
- Create: `packages/cli/src/emit.ts`
- Modify: `packages/cli/src/schema.ts` (add `isHandwritten`)
- Test: `packages/cli/test/emit.test.ts`; add a case to `packages/cli/test/schema.test.ts`

**Interfaces:**
- Consumes: `emitInterfaces` (Plan 1 + Task 3); layout constants and sources (Task 2); `readFileOrNull`, `writeFileAtomic`, `removeFile`, `listFilesUnder` (Task 5); `ExportsByConcept` (Task 4).
- Produces: `schema.ts`: `isHandwritten(fm: Frontmatter): boolean`. `emit.ts`: `expectedFiles(project: Project): Set<string>`; `emitDeterministicFiles(root, project, exportsByConcept): Promise<Diagnostic[]>` writes `.ccc/package.json`, `.ccc/.gitignore`, every interface under `.ccc/interfaces/`, every conformance file, and every handwritten re-export module. It writes only files whose content changed, and deletes files under gen/interfaces/conformance that belong to no current concept.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/schema.test.ts`:
```ts
import { isHandwritten } from '../src/schema.js';

describe('isHandwritten', () => {
  it('is true only for handwritten non-sync concepts', () => {
    const iface = 'export type A = string;';
    expect(isHandwritten(frontmatterSchema.parse({ kind: 'value', interface: iface }))).toBe(false);
    expect(
      isHandwritten(frontmatterSchema.parse({ kind: 'value', interface: iface, implementation: 'handwritten', source: 'h.ts' })),
    ).toBe(true);
    expect(isHandwritten(frontmatterSchema.parse({ kind: 'sync', when: 'a#b', then: ['c#d'] }))).toBe(false);
  });
});
```

`packages/cli/test/emit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emitDeterministicFiles, expectedFiles } from '../src/emit.js';
import { listFilesUnder, readFileOrNull, writeFileAtomic } from '../src/fsutil.js';
import { collectExports } from '../src/interfaces.js';
import { loadProject } from '../src/load.js';
import { concept, writeProject } from './helpers.js';

async function setup() {
  const root = await writeProject({
    'concepts/user.md': concept(
      'kind: value\nimplementation: handwritten\nsource: handwritten/user.ts\ninterface: export type UserId = string;',
    ),
    'concepts/card.md': concept('kind: value\ninterface: export interface Card { readonly rank: string }'),
    'handwritten/user.ts': 'export type UserId = string;\n',
  });
  const { project } = await loadProject(root);
  return { root, project, exportsByConcept: collectExports(project) };
}

describe('emitDeterministicFiles', () => {
  it('writes package.json, .gitignore, interfaces, conformance, and handwritten re-exports', async () => {
    const { root, project, exportsByConcept } = await setup();
    expect(await emitDeterministicFiles(root, project, exportsByConcept)).toEqual([]);
    expect(await readFileOrNull(root, '.ccc/package.json')).toBe('{\n  "type": "module"\n}\n');
    expect(await readFileOrNull(root, '.ccc/.gitignore')).toBe('.tmp/\n');
    expect(await readFileOrNull(root, '.ccc/interfaces/card.d.ts')).toContain('export interface Card');
    expect(await readFileOrNull(root, '.ccc/conformance/user.ts')).toContain("import * as impl from '../gen/user.js';");
    expect(await readFileOrNull(root, '.ccc/gen/user.ts')).toContain("export * from '../../handwritten/user.js';");
    expect(await readFileOrNull(root, '.ccc/gen/card.ts')).toBeNull();
  });

  it('removes files that belong to no concept and keeps expected ones', async () => {
    const { root, project, exportsByConcept } = await setup();
    await writeFileAtomic(root, '.ccc/gen/card.ts', '// generated earlier');
    await writeFileAtomic(root, '.ccc/gen/card.test.ts', '// generated earlier');
    await writeFileAtomic(root, '.ccc/gen/old.ts', '// concept deleted');
    await writeFileAtomic(root, '.ccc/interfaces/old.d.ts', '// concept deleted');
    await emitDeterministicFiles(root, project, exportsByConcept);
    expect(await listFilesUnder(root, '.ccc/gen')).toEqual(['.ccc/gen/card.test.ts', '.ccc/gen/card.ts', '.ccc/gen/user.ts']);
    expect(await readFileOrNull(root, '.ccc/interfaces/old.d.ts')).toBeNull();
  });

  it('lists the files each concept owns', async () => {
    const { project } = await setup();
    expect([...expectedFiles(project)].sort()).toEqual([
      '.ccc/.gitignore',
      '.ccc/conformance/card.ts',
      '.ccc/conformance/user.ts',
      '.ccc/gen/card.test.ts',
      '.ccc/gen/card.ts',
      '.ccc/gen/user.test.ts',
      '.ccc/gen/user.ts',
      '.ccc/interfaces/card.d.ts',
      '.ccc/interfaces/user.d.ts',
      '.ccc/package.json',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run emit schema`
Expected: FAIL. `emit.js` is not found and `isHandwritten` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/cli/src/schema.ts`:
```ts
export function isHandwritten(fm: Frontmatter): boolean {
  return fm.kind !== 'sync' && fm.implementation === 'handwritten';
}
```

`packages/cli/src/emit.ts`:
```ts
import type { Diagnostic } from './diagnostics.js';
import { listFilesUnder, readFileOrNull, removeFile, writeFileAtomic } from './fsutil.js';
import { emitInterfaces } from './interfaces.js';
import type { ExportsByConcept } from './keys.js';
import {
  CCC_GITIGNORE,
  CCC_PACKAGE_JSON,
  CONFORMANCE_DIR,
  GEN_DIR,
  INTERFACES_DIR,
  conformancePath,
  conformanceSource,
  handwrittenModuleSource,
  interfaceFile,
  modulePath,
  testPath,
} from './layout.js';
import type { Project } from './load.js';

export function expectedFiles(project: Project): Set<string> {
  const files = new Set(['.ccc/package.json', '.ccc/.gitignore']);
  for (const id of project.concepts.keys()) {
    files.add(modulePath(id));
    files.add(testPath(id));
    files.add(interfaceFile(id));
    files.add(conformancePath(id));
  }
  return files;
}

// Everything under .ccc that needs no LLM: rewritten on every build, written
// only when its content changed, and pruned when its concept is gone.
export async function emitDeterministicFiles(
  root: string,
  project: Project,
  exportsByConcept: ExportsByConcept,
): Promise<Diagnostic[]> {
  const { files, diagnostics } = emitInterfaces(project, exportsByConcept);
  const writes: [string, string][] = [
    ['.ccc/package.json', CCC_PACKAGE_JSON],
    ['.ccc/.gitignore', CCC_GITIGNORE],
    ...files.map((file): [string, string] => [`${INTERFACES_DIR}/${file.path}`, file.content]),
  ];
  for (const concept of project.concepts.values()) {
    writes.push([conformancePath(concept.id), conformanceSource(concept.id)]);
    const fm = concept.frontmatter;
    if (fm.kind !== 'sync' && fm.implementation === 'handwritten' && fm.source !== undefined) {
      writes.push([modulePath(concept.id), handwrittenModuleSource(concept.id, fm.source)]);
    }
  }
  await Promise.all(
    writes.map(async ([rel, content]) => {
      if ((await readFileOrNull(root, rel)) !== content) {
        await writeFileAtomic(root, rel, content);
      }
    }),
  );
  const expected = expectedFiles(project);
  const existing = (await Promise.all([GEN_DIR, INTERFACES_DIR, CONFORMANCE_DIR].map((dir) => listFilesUnder(root, dir)))).flat();
  await Promise.all(existing.filter((rel) => !expected.has(rel)).map((rel) => removeFile(root, rel)));
  return diagnostics;
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run emit schema` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/emit.ts packages/cli/src/schema.ts packages/cli/test/emit.test.ts packages/cli/test/schema.test.ts
git commit -m "Emit and prune deterministic generated files"
```

---

### Task 12: Implementation generation and module validation

**Files:**
- Create: `packages/cli/src/implgen.ts`
- Test: `packages/cli/test/implgen.test.ts`

**Interfaces:**
- Consumes: `generationLoop`, `GenerationOutcome` (Task 10); `GenerateContext` (Task 10); `implRequest` (Task 9); `checkImports`, `moduleImportsFor`, `PACKAGES_BY_KIND` (Task 6); `typecheckFiles`, `lintFiles`, `runTests`, `ToolIssue` (Task 7); `readFileOrNull`, `writeFileAtomic`, `removeFile` (Task 5); `modulePath`, `testPath`, `conformancePath`, `generatedHeader` (Task 2); `readPrompt` (Task 4); `emitDeterministicFiles` (Task 11, used by tests).
- Produces: `interface ImplOptions { key: string; commit: boolean }`; `checkModuleOnDisk(ctx: { root: string }, concept: Concept): Promise<string[]>` (type-checks module + conformance + test, lints the module or the handwritten source, runs the concept's tests); `generateImpl(ctx, concept, testSource, options: ImplOptions): Promise<GenerationOutcome>`. With `commit: false`, or on failure, the module file ends as it started, even if the loop throws. On success `source` is the full file including the header.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/implgen.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emitDeterministicFiles } from '../src/emit.js';
import { readFileOrNull, writeFileAtomic } from '../src/fsutil.js';
import { checkModuleOnDisk, generateImpl } from '../src/implgen.js';
import { generatedHeader, modulePath, testPath } from '../src/layout.js';
import { FakeGenerator } from './fake-generator.js';
import { CANNED_IMPL, CANNED_TESTS, createPipelineProject, pipelineContext, pipelineResponder, type Overrides } from './pipeline-fixture.js';

async function ready(overrides: Overrides = {}) {
  const root = await createPipelineProject();
  const fake = new FakeGenerator(pipelineResponder(overrides));
  const ctx = await pipelineContext(root, fake);
  await emitDeterministicFiles(root, ctx.project, ctx.exportsByConcept);
  for (const id of ['card', 'hand']) {
    await writeFileAtomic(root, testPath(id), CANNED_TESTS[id] ?? '');
  }
  await writeFileAtomic(root, modulePath('card'), `${generatedHeader('card', 'k'.repeat(12))}\n${CANNED_IMPL.card}`);
  const hand = ctx.project.concepts.get('hand');
  if (hand === undefined) throw new Error('fixture');
  return { root, fake, ctx, hand };
}

describe('generateImpl', () => {
  it('writes a passing module with a header', async () => {
    const { root, ctx, hand } = await ready();
    const outcome = await generateImpl(ctx, hand, CANNED_TESTS.hand ?? '', { key: 'abcdef0123456789', commit: true });
    expect(outcome.record).toMatchObject({ artifact: 'impl', attempts: 1, outcome: 'passed' });
    const written = await readFileOrNull(root, modulePath('hand'));
    expect(written).toBe(`// @generated by ccc from concept hand (key abcdef012345). Do not edit.\n${CANNED_IMPL.hand}`);
    expect(outcome.source).toBe(written);
  });

  it('feeds test failures back and accepts a later attempt', async () => {
    const good = CANNED_IMPL.hand ?? '';
    const { fake, ctx, hand } = await ready({
      'impl:hand': (attempt) => (attempt === 1 ? good.replace('throw new DuplicateCard', 'return; throw new DuplicateCard') : good),
    });
    const outcome = await generateImpl(ctx, hand, CANNED_TESTS.hand ?? '', { key: 'k'.repeat(16), commit: true });
    expect(outcome.record.attempts).toBe(2);
    expect(fake.requests[1]?.messages[1]).toContain('test failed: [ex 2] rejects a duplicate card');
  });

  it('rejects disallowed imports without writing them', async () => {
    const good = CANNED_IMPL.hand ?? '';
    const { fake, ctx, hand } = await ready({
      'impl:hand': (attempt) => (attempt === 1 ? `import fs from 'node:fs';\n${good}` : good),
    });
    await generateImpl(ctx, hand, CANNED_TESTS.hand ?? '', { key: 'k'.repeat(16), commit: true });
    expect(fake.requests[1]?.messages[1]).toContain("package 'node:fs' is not allowed here");
  });

  it('fails conformance when the module exports something extra', async () => {
    const good = CANNED_IMPL.hand ?? '';
    const { ctx, hand } = await ready({ 'impl:hand': () => `${good}\nexport const extra = 1;\n` });
    const outcome = await generateImpl(ctx, hand, CANNED_TESTS.hand ?? '', { key: 'k'.repeat(16), commit: true });
    expect(outcome.source).toBeNull();
    expect(outcome.problems.join('\n')).toContain('.ccc/conformance/hand.ts');
  });

  it('restores the previous module after exhausting attempts', async () => {
    const { root, ctx, hand } = await ready({ 'impl:hand': () => 'export const broken: number = "x";\n' });
    await writeFileAtomic(root, modulePath('hand'), '// previous good version\n');
    const outcome = await generateImpl(ctx, hand, CANNED_TESTS.hand ?? '', { key: 'k'.repeat(16), commit: true });
    expect(outcome.source).toBeNull();
    expect(outcome.record).toMatchObject({ attempts: 3, outcome: 'failed' });
    expect(await readFileOrNull(root, modulePath('hand'))).toBe('// previous good version\n');
  });

  it('leaves the file untouched when commit is false', async () => {
    const { root, ctx, hand } = await ready();
    const outcome = await generateImpl(ctx, hand, CANNED_TESTS.hand ?? '', { key: 'k'.repeat(16), commit: false });
    expect(outcome.source).toContain('export class Hand');
    expect(await readFileOrNull(root, modulePath('hand'))).toBeNull();
  });
});

describe('checkModuleOnDisk', () => {
  it('passes a good module and reports a failing one', async () => {
    const { root, ctx } = await ready();
    const card = ctx.project.concepts.get('card');
    if (card === undefined) throw new Error('fixture');
    expect(await checkModuleOnDisk(ctx, card)).toEqual([]);
    await writeFileAtomic(root, modulePath('card'), (CANNED_IMPL.card ?? '').replace('return { rank, suit };', 'return { rank: suit, suit: rank };'));
    expect((await checkModuleOnDisk(ctx, card)).join('\n')).toContain('test failed: [ex 1] builds a card');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run implgen`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/implgen.ts`:
```ts
import { implRequest } from './context.js';
import { readFileOrNull, removeFile, writeFileAtomic } from './fsutil.js';
import { generationLoop, type GenerationOutcome } from './generation.js';
import { PACKAGES_BY_KIND, checkImports, moduleImportsFor } from './imports.js';
import { conformancePath, generatedHeader, modulePath, testPath } from './layout.js';
import type { Concept } from './parse.js';
import type { GenerateContext } from './testgen.js';
import { lintFiles, runTests, typecheckFiles, type ToolIssue } from './toolchain.js';
import { readPrompt } from './versions.js';

export interface ImplOptions {
  key: string;
  commit: boolean;
}

function formatIssue(issue: ToolIssue): string {
  if (issue.file === '') {
    return issue.message;
  }
  return issue.line === null ? `${issue.file}: ${issue.message}` : `${issue.file}:${issue.line}: ${issue.message}`;
}

// The checks a module must pass where it sits in .ccc/gen: its own files
// type-check (including conformance to the interface), it lints clean, and
// its approved tests pass.
export async function checkModuleOnDisk(ctx: { root: string }, concept: Concept): Promise<string[]> {
  const module = modulePath(concept.id);
  const test = testPath(concept.id);
  const conformance = conformancePath(concept.id);
  const fm = concept.frontmatter;
  const lintTarget = fm.kind !== 'sync' && fm.implementation === 'handwritten' && fm.source !== undefined ? fm.source : module;
  const own = new Set([module, test, conformance, lintTarget]);
  const typeIssues = (await typecheckFiles(ctx.root, [module, conformance, test])).filter(
    (issue) => own.has(issue.file) || issue.file === '',
  );
  const lintIssues = await lintFiles(ctx.root, [lintTarget]);
  const run = await runTests(ctx.root, [test]);
  const problems = [
    ...typeIssues.map(formatIssue),
    ...lintIssues.map(formatIssue),
    ...run.errors.map(formatIssue),
    ...run.cases
      .filter((testCase) => testCase.status === 'failed')
      .map((testCase) => `test failed: ${testCase.name}: ${testCase.message.split('\n').slice(0, 6).join('\n')}`),
  ];
  if (problems.length === 0 && run.cases.length === 0) {
    problems.push(`no tests ran for ${test}`);
  }
  return problems;
}

async function restore(root: string, rel: string, original: string | null): Promise<void> {
  if (original === null) {
    await removeFile(root, rel);
  } else {
    await writeFileAtomic(root, rel, original);
  }
}

export async function generateImpl(
  ctx: GenerateContext,
  concept: Concept,
  testSource: string,
  options: ImplOptions,
): Promise<GenerationOutcome> {
  const target = modulePath(concept.id);
  const original = await readFileOrNull(ctx.root, target);
  const header = generatedHeader(concept.id, options.key);
  const withHeader = (code: string): string => `${header}\n${code.trimEnd()}\n`;
  let accepted = false;
  try {
    const outcome = await generationLoop({
      generator: ctx.generator,
      model: ctx.config.models.impl,
      system: await readPrompt(concept.frontmatter.kind === 'sync' ? 'sync' : 'impl'),
      firstMessage: implRequest(concept, ctx.project, ctx.exportsByConcept, testSource),
      maxAttempts: ctx.config.maxAttempts,
      artifact: 'impl',
      now: ctx.now,
      check: async (code) => {
        const importIssues = checkImports(code, moduleImportsFor(concept, ctx.project), PACKAGES_BY_KIND[concept.frontmatter.kind]);
        if (importIssues.length > 0) {
          return importIssues;
        }
        await writeFileAtomic(ctx.root, target, withHeader(code));
        return checkModuleOnDisk(ctx, concept);
      },
    });
    if (outcome.source === null) {
      return outcome;
    }
    accepted = options.commit;
    return { ...outcome, source: withHeader(outcome.source) };
  } finally {
    if (!accepted) {
      await restore(ctx.root, target, original);
    }
  }
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run implgen` (expected: PASS; about 1 minute), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/implgen.ts packages/cli/test/implgen.test.ts
git commit -m "Generate implementations through checks in place, restoring on failure"
```

---

### Task 13: Build orchestration

**Files:**
- Create: `packages/cli/src/pool.ts`, `packages/cli/src/build.ts`
- Test: `packages/cli/test/pool.test.ts`, `packages/cli/test/build.test.ts`

**Interfaces:**
- Consumes: `runCheck` (Plan 1); `loadConfig` (Task 1); `sha256` (Task 1); `emitDeterministicFiles` (Task 11); `isHandwritten` (Task 11); `generateTests`, `GenerateContext` (Task 10); `generateImpl`, `checkModuleOnDisk` (Task 12); `testKey`, `implKey` (Task 4); `loadVersions` (Task 4); `readManifest`, `writeManifest`, `entryFor`, `listCccFiles`, `hashFiles` (Task 5); `fileHash`, `readFileOrNull`, `writeFileAtomic` (Task 5); `runTests` (Task 7); `dependenciesOf` (Plan 1); `collectExports` (Plan 1).
- Produces:
  - `pool.ts`: `mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>`
  - `build.ts`: `interface BuildOptions { root: string; generator: Generator; only?: ConceptId; dryRun?: boolean; testsOnly?: boolean; now?: () => number; log?: (line: string) => void }`; `interface PlanItem { id: ConceptId; tests: boolean; impl: boolean }`; `interface BuildResult { ok: boolean; diagnostics: Diagnostic[]; plan: PlanItem[]; generated: { tests: ConceptId[]; impl: ConceptId[] }; failed: ConceptId[]; skipped: ConceptId[] }`; `topologicalLevels(project: Project): ConceptId[][]`; `dependencyClosure(project, id): Set<ConceptId>`; `runBuild(options: BuildOptions): Promise<BuildResult>`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/pool.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/pool.js';

describe('mapPool', () => {
  it('processes every item with at most `limit` in flight', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await mapPool([1, 2, 3, 4, 5], 2, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push(item);
      running -= 1;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    await mapPool([], 3, async () => {
      throw new Error('never');
    });
  });
});
```

`packages/cli/test/build.test.ts`:
```ts
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { dependencyClosure, runBuild, topologicalLevels } from '../src/build.js';
import { fileHash, readFileOrNull, writeFileAtomic } from '../src/fsutil.js';
import { modulePath } from '../src/layout.js';
import { loadProject } from '../src/load.js';
import { readManifest } from '../src/manifest.js';
import { FakeGenerator } from './fake-generator.js';
import { CANNED_IMPL, PIPELINE_FILES, createPipelineProject, pipelineResponder, type Overrides } from './pipeline-fixture.js';

async function copyProject(root: string): Promise<string> {
  const copy = await mkdtemp(path.join(tmpdir(), 'ccc-build-'));
  await cp(root, copy, { recursive: true });
  return copy;
}

async function build(root: string, overrides: Overrides = {}, extra: { only?: string; dryRun?: boolean; testsOnly?: boolean } = {}) {
  const fake = new FakeGenerator(pipelineResponder(overrides));
  const result = await runBuild({ root, generator: fake, ...extra });
  return { fake, result };
}

describe('topologicalLevels / dependencyClosure', () => {
  it('orders concepts by dependency depth', async () => {
    const root = await createPipelineProject();
    const { project } = await loadProject(root);
    expect(topologicalLevels(project)).toEqual([['card', 'counter'], ['hand'], ['count-adds']]);
    expect([...dependencyClosure(project, 'hand')].sort()).toEqual(['card', 'hand']);
  });
});

describe('runBuild', () => {
  let built = '';

  beforeAll(async () => {
    built = await createPipelineProject();
    const { result } = await build(built);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  }, 180_000);

  it('builds every concept from scratch', async () => {
    const { manifest } = await readManifest(built);
    expect(Object.keys(manifest.concepts).sort()).toEqual(['card', 'count-adds', 'counter', 'hand']);
    for (const entry of Object.values(manifest.concepts)) {
      expect(entry.testKey).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.implKey).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.approvedTestHash).toBeNull();
      expect(entry.history.map((g) => `${g.artifact}:${g.outcome}`)).toEqual(['tests:passed', 'impl:passed']);
    }
    expect(await readFileOrNull(built, modulePath('hand'))).toMatch(/^\/\/ @generated by ccc from concept hand \(key [0-9a-f]{12}\)/);
    expect(manifest.files[modulePath('hand')]).toBe(await fileHash(built, modulePath('hand')));
    expect(manifest.files['.ccc/conformance/count-adds.ts']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('makes no LLM calls when nothing changed', async () => {
    const root = await copyProject(built);
    const { fake, result } = await build(root);
    expect(result.ok).toBe(true);
    expect(fake.requests).toEqual([]);
    expect(result.generated).toEqual({ tests: [], impl: [] });
  });

  it('regenerates only the implementation when Rules change', async () => {
    const root = await copyProject(built);
    const hand = PIPELINE_FILES['concepts/hand.md'] ?? '';
    await writeFileAtomic(root, 'concepts/hand.md', hand.replace('never holds the same card twice', 'never holds a card twice'));
    const { result } = await build(root);
    expect(result.ok).toBe(true);
    expect(result.generated).toEqual({ tests: [], impl: ['hand'] });
  });

  it('regenerates dependents when a dependency interface changes', async () => {
    const root = await copyProject(built);
    const card = PIPELINE_FILES['concepts/card.md'] ?? '';
    await writeFileAtomic(root, 'concepts/card.md', card.replace('  export function card(', '  export type Rank = string;\n  export function card('));
    const { result } = await build(root);
    expect(result.ok).toBe(true);
    expect(result.generated.tests.sort()).toEqual(['card', 'hand']);
    expect(result.generated.impl.sort()).toEqual(['card', 'hand']);
  });

  it('regenerates a module edited or removed since the last build', async () => {
    const root = await copyProject(built);
    await writeFileAtomic(root, modulePath('counter'), '// hand edit\n');
    await rm(path.join(root, modulePath('card')));
    const { result } = await build(root);
    expect(result.ok).toBe(true);
    expect(result.generated.impl.sort()).toEqual(['card', 'counter']);
  });

  it('plans without writing on a dry run', async () => {
    const root = await createPipelineProject();
    const { fake, result } = await build(root, {}, { dryRun: true });
    expect(result.ok).toBe(true);
    expect(fake.requests).toEqual([]);
    expect(result.plan).toEqual([
      { id: 'card', tests: true, impl: true },
      { id: 'count-adds', tests: true, impl: true },
      { id: 'counter', tests: true, impl: true },
      { id: 'hand', tests: true, impl: true },
    ]);
    expect(await readFileOrNull(root, '.ccc/manifest.json')).toBeNull();
  });

  it('keeps going after a failure, skipping only dependents', async () => {
    const root = await createPipelineProject();
    const { result } = await build(root, { 'impl:hand': () => 'export const broken: number = "x";\n' });
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(['hand']);
    expect(result.skipped).toEqual(['count-adds']);
    expect(await readFileOrNull(root, modulePath('hand'))).toBeNull();
    expect(await readFileOrNull(root, modulePath('counter'))).toContain('export class Counter');
    expect(result.diagnostics.map((d) => d.message).join('\n')).toContain('implementation generation failed after 3 attempt(s)');
  }, 180_000);

  it('retries a failing attempt within one build', async () => {
    const root = await createPipelineProject();
    const good = CANNED_IMPL.counter ?? '';
    const { result } = await build(root, { 'impl:counter': (attempt) => (attempt === 1 ? good.replace('+= 1', '+= 2') : good) });
    expect(result.ok).toBe(true);
    const { manifest } = await readManifest(root);
    expect(manifest.concepts.counter?.history.at(-1)).toMatchObject({ artifact: 'impl', attempts: 2, outcome: 'passed' });
  }, 180_000);

  it('limits work to a concept and its dependencies, and can stop after tests', async () => {
    const root = await createPipelineProject();
    const { result } = await build(root, {}, { only: 'hand', testsOnly: true });
    expect(result.ok).toBe(true);
    expect(result.generated.tests.sort()).toEqual(['card', 'hand']);
    expect(result.generated.impl).toEqual([]);
    expect(await readFileOrNull(root, modulePath('hand'))).toBeNull();
  });

  it('rejects an unknown concept and concepts without examples', async () => {
    const root = await createPipelineProject();
    expect((await build(root, {}, { only: 'nope' })).result.diagnostics.map((d) => d.message)).toContain("unknown concept 'nope'");
    const counter = PIPELINE_FILES['concepts/counter.md'] ?? '';
    await writeFileAtomic(root, 'concepts/counter.md', counter.slice(0, counter.indexOf('## Examples')));
    const { result } = await build(root);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message)).toContain("ccc build requires at least one example in '## Examples'");
  });
});
```

The `copyProject` helper copies `built` into a fresh temp dir, so cases don't affect each other.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run pool build`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/cli/src/pool.ts`:
```ts
export async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        await fn(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}
```

`packages/cli/src/build.ts`:
```ts
import { runCheck } from './check.js';
import { loadConfig } from './config.js';
import { error, hasErrors, warning, type Diagnostic } from './diagnostics.js';
import { emitDeterministicFiles } from './emit.js';
import { fileHash, readFileOrNull, writeFileAtomic } from './fsutil.js';
import type { GenerationOutcome } from './generation.js';
import { dependenciesOf } from './graph.js';
import { sha256 } from './hash.js';
import type { ConceptId } from './ids.js';
import { checkModuleOnDisk, generateImpl } from './implgen.js';
import { collectExports } from './interfaces.js';
import { implKey, testKey, type ExportsByConcept } from './keys.js';
import { modulePath, testPath } from './layout.js';
import type { Generator } from './llm.js';
import type { Project } from './load.js';
import { entryFor, hashFiles, listCccFiles, readManifest, writeManifest, type Manifest } from './manifest.js';
import type { Concept } from './parse.js';
import { mapPool } from './pool.js';
import { isHandwritten } from './schema.js';
import { generateTests, type GenerateContext } from './testgen.js';
import { runTests } from './toolchain.js';
import { loadVersions, type Versions } from './versions.js';

export interface BuildOptions {
  root: string;
  generator: Generator;
  only?: ConceptId;
  dryRun?: boolean;
  testsOnly?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PlanItem {
  id: ConceptId;
  tests: boolean;
  impl: boolean;
}

export interface BuildResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  plan: PlanItem[];
  generated: { tests: ConceptId[]; impl: ConceptId[] };
  failed: ConceptId[];
  skipped: ConceptId[];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  const levels: ConceptId[][] = [];
  for (const [id, value] of [...level].sort(([a], [b]) => compareIds(a, b))) {
    (levels[value] ??= []).push(id);
  }
  return levels;
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

interface PlanState {
  item: PlanItem;
  testKey: string;
}

async function isModuleCurrent(
  root: string,
  manifest: Manifest,
  concept: Concept,
  key: string,
): Promise<boolean> {
  const entry = manifest.concepts[concept.id];
  const moduleHash = await fileHash(root, modulePath(concept.id));
  return entry?.implKey === key && moduleHash !== null && manifest.files[modulePath(concept.id)] === moduleHash;
}

async function planBuild(
  root: string,
  project: Project,
  exportsByConcept: ExportsByConcept,
  versions: Versions,
  manifest: Manifest,
  scope: ReadonlySet<ConceptId>,
): Promise<Map<ConceptId, PlanState>> {
  const states = new Map<ConceptId, PlanState>();
  for (const id of [...scope].sort(compareIds)) {
    const concept = project.concepts.get(id);
    if (concept === undefined) {
      continue;
    }
    const entry = manifest.concepts[id];
    const key = await testKey(concept, project, exportsByConcept, versions);
    const testHash = await fileHash(root, testPath(id));
    const tests = entry === undefined || entry.testKey !== key || testHash === null || testHash !== entry.testFileHash;
    let impl = false;
    if (!isHandwritten(concept.frontmatter)) {
      impl =
        tests ||
        testHash === null ||
        !(await isModuleCurrent(root, manifest, concept, await implKey(concept, project, exportsByConcept, versions, testHash)));
    }
    states.set(id, { item: { id, tests, impl }, testKey: key });
  }
  return states;
}

function bullets(problems: readonly string[]): string {
  return problems
    .slice(0, 10)
    .map((problem) => `  - ${problem.split('\n').join('\n    ')}`)
    .join('\n');
}

function generationFailure(concept: Concept, artifact: 'tests' | 'impl', outcome: GenerationOutcome): Diagnostic {
  const what = artifact === 'tests' ? 'test' : 'implementation';
  return error(
    concept.file,
    `${what} generation failed after ${outcome.record.attempts} attempt(s); last problems:\n${bullets(outcome.problems)}`,
  );
}

function firstLines(text: string): string {
  return text.split('\n').slice(0, 6).join('\n');
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const { root } = options;
  const log = options.log ?? ((): void => undefined);
  const now = options.now ?? Date.now;
  const result: BuildResult = { ok: false, diagnostics: [], plan: [], generated: { tests: [], impl: [] }, failed: [], skipped: [] };

  const check = await runCheck(root);
  result.diagnostics.push(...check.diagnostics);
  const project = check.project;
  for (const concept of project.concepts.values()) {
    if (concept.examples.length === 0) {
      result.diagnostics.push(error(concept.file, "ccc build requires at least one example in '## Examples'"));
    }
  }
  const configResult = await loadConfig(root);
  const manifestResult = await readManifest(root);
  result.diagnostics.push(...configResult.diagnostics, ...manifestResult.diagnostics);
  if (options.only !== undefined && !project.concepts.has(options.only)) {
    result.diagnostics.push(error('concepts/', `unknown concept '${options.only}'`));
  }
  if (hasErrors(result.diagnostics)) {
    return result;
  }

  const { config } = configResult;
  const { manifest } = manifestResult;
  const exportsByConcept = collectExports(project);
  const versions = await loadVersions(config);
  const scope = options.only === undefined ? new Set(project.concepts.keys()) : dependencyClosure(project, options.only);
  const states = await planBuild(root, project, exportsByConcept, versions, manifest, scope);
  result.plan = [...states.values()].map((state) => state.item);
  if (options.dryRun === true) {
    result.ok = true;
    return result;
  }

  result.diagnostics.push(...(await emitDeterministicFiles(root, project, exportsByConcept)));
  if (hasErrors(result.diagnostics)) {
    return result;
  }
  const ctx: GenerateContext = { root, project, exportsByConcept, generator: options.generator, config, now };
  const failed = new Set<ConceptId>();
  const skipped = new Set<ConceptId>();

  // Stage 3: tests, all concepts in parallel (tests depend only on interfaces).
  await mapPool(
    [...states.values()].filter((state) => state.item.tests),
    config.concurrency,
    async (state) => {
      const concept = project.concepts.get(state.item.id);
      if (concept === undefined) {
        return;
      }
      const entry = entryFor(manifest, concept.id);
      const outcome = await generateTests(ctx, concept);
      entry.history.push(outcome.record);
      if (outcome.source === null) {
        failed.add(concept.id);
        result.diagnostics.push(generationFailure(concept, 'tests', outcome));
        log(`tests  ${concept.id}  FAILED`);
        return;
      }
      await writeFileAtomic(root, testPath(concept.id), outcome.source);
      entry.testKey = state.testKey;
      entry.testFileHash = await sha256(outcome.source);
      entry.approvedTestHash = null;
      result.generated.tests.push(concept.id);
      log(`tests  ${concept.id}  generated in ${outcome.record.attempts} attempt(s), pending approval`);
    },
  );

  // Stage 4: implementations, level by level so dependencies exist first.
  if (options.testsOnly !== true) {
    for (const level of topologicalLevels(project)) {
      await mapPool(
        level.filter((id) => scope.has(id)),
        config.concurrency,
        async (id) => {
          const concept = project.concepts.get(id);
          if (concept === undefined || failed.has(id)) {
            return;
          }
          const blocker = dependenciesOf(concept, project).find((dep) => failed.has(dep) || skipped.has(dep));
          if (blocker !== undefined) {
            skipped.add(id);
            result.diagnostics.push(warning(concept.file, `skipped: dependency '${blocker}' did not build`));
            return;
          }
          const testSource = await readFileOrNull(root, testPath(id));
          if (testSource === null) {
            failed.add(id);
            result.diagnostics.push(error(concept.file, 'no tests exist for this concept; run ccc tests'));
            return;
          }
          if (isHandwritten(concept.frontmatter)) {
            const problems = await checkModuleOnDisk(ctx, concept);
            if (problems.length > 0) {
              failed.add(id);
              result.diagnostics.push(error(concept.file, `handwritten module fails its checks:\n${bullets(problems)}`));
            }
            return;
          }
          const key = await implKey(concept, project, exportsByConcept, versions, await sha256(testSource));
          if (await isModuleCurrent(root, manifest, concept, key)) {
            return;
          }
          const entry = entryFor(manifest, id);
          const outcome = await generateImpl(ctx, concept, testSource, { key, commit: true });
          entry.history.push(outcome.record);
          if (outcome.source === null) {
            failed.add(id);
            result.diagnostics.push(generationFailure(concept, 'impl', outcome));
            log(`impl   ${id}  FAILED`);
            return;
          }
          entry.implKey = key;
          result.generated.impl.push(id);
          log(`impl   ${id}  generated in ${outcome.record.attempts} attempt(s)`);
        },
      );
    }

    // Stage 6: the full suite, which exercises cross-concept behavior.
    const testFiles: string[] = [];
    for (const id of project.concepts.keys()) {
      if ((await fileHash(root, testPath(id))) !== null) {
        testFiles.push(testPath(id));
      }
    }
    const run = await runTests(root, testFiles);
    for (const issue of run.errors) {
      result.diagnostics.push(error(issue.file || 'concepts/', `test file failed to run: ${firstLines(issue.message)}`));
    }
    for (const testCase of run.cases.filter((c) => c.status === 'failed')) {
      result.diagnostics.push(error(testCase.file, `test failed: ${testCase.name}: ${firstLines(testCase.message)}`));
    }
  }

  manifest.files = await hashFiles(root, await listCccFiles(root));
  await writeManifest(root, manifest);
  result.failed = [...failed].sort(compareIds);
  result.skipped = [...skipped].sort(compareIds);
  result.generated.tests.sort(compareIds);
  result.generated.impl.sort(compareIds);
  result.ok = !hasErrors(result.diagnostics);
  return result;
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run pool build` (expected: PASS; allow several minutes), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/pool.ts packages/cli/src/build.ts packages/cli/test/pool.test.ts packages/cli/test/build.test.ts
git commit -m "Orchestrate builds: plan, tests, implementations, suite, manifest"
```

---

### Task 14: `ccc build` and `ccc tests` commands

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/cli-build.test.ts`

**Interfaces:**
- Consumes: `runBuild`, `BuildResult` (Task 13); `AnthropicGenerator` (Task 8); `Generator` (Task 8).
- Produces: `cli.ts`: `interface Io { cwd: string; stdout(text: string): void; stderr(text: string): void; confirm?(question: string): Promise<boolean> }`; `interface Services { generator(): Generator }`; `main(argv, io, services?: Services): Promise<number>` (services defaults to a lazily created `AnthropicGenerator`); `buildSummary(result: BuildResult): string`. Unexpected errors print `error: <message>` to stderr and return 2.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/cli-build.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildSummary, main, type Io } from '../src/cli.js';
import type { Generator } from '../src/llm.js';
import { FakeGenerator } from './fake-generator.js';
import { createPipelineProject, pipelineResponder } from './pipeline-fixture.js';

function capture(cwd: string) {
  let out = '';
  let err = '';
  const io: Io = {
    cwd,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return { io, out: () => out, err: () => err };
}

const fakeServices = (generator: Generator = new FakeGenerator(pipelineResponder())) => ({ generator: () => generator });

describe('buildSummary', () => {
  it('summarizes success and failure', () => {
    const base = { diagnostics: [], plan: [], failed: [], skipped: [] };
    expect(buildSummary({ ...base, ok: true, generated: { tests: ['a'], impl: ['a', 'b'] } })).toBe(
      '✓ build complete: 1 test file(s) and 2 implementation(s) generated',
    );
    expect(buildSummary({ ...base, ok: false, generated: { tests: [], impl: [] }, failed: ['a'], skipped: ['b', 'c'] })).toBe(
      'build failed: 1 failed, 2 skipped',
    );
  });
});

describe('ccc build / tests', () => {
  it('prints the plan on --dry-run', async () => {
    const root = await createPipelineProject();
    const cap = capture(root);
    expect(await main(['build', '--dry-run'], cap.io, fakeServices())).toBe(0);
    expect(cap.out()).toBe(
      [
        'tests+impl  card',
        'tests+impl  count-adds',
        'tests+impl  counter',
        'tests+impl  hand',
        '8 generation(s) planned',
        '',
      ].join('\n'),
    );
  });

  it('builds and logs progress', async () => {
    const root = await createPipelineProject();
    const cap = capture(root);
    expect(await main(['build'], cap.io, fakeServices())).toBe(0);
    expect(cap.out()).toContain('impl   hand  generated in 1 attempt(s)');
    expect(cap.out().trimEnd().split('\n').at(-1)).toBe('✓ build complete: 4 test file(s) and 4 implementation(s) generated');
  }, 180_000);

  it('generates only tests with ccc tests <concept>', async () => {
    const root = await createPipelineProject();
    const cap = capture(root);
    expect(await main(['tests', 'hand'], cap.io, fakeServices())).toBe(0);
    expect(cap.out()).toContain('tests  hand  generated in 1 attempt(s), pending approval');
    expect(cap.out()).not.toContain('impl ');
  });

  it('exits 1 for an unknown concept and 2 for unexpected errors', async () => {
    const root = await createPipelineProject();
    const unknown = capture(root);
    expect(await main(['build', 'nope'], unknown.io, fakeServices())).toBe(1);
    expect(unknown.out()).toContain("unknown concept 'nope'");
    const exploding: Generator = {
      start: () => ({
        send: async () => {
          throw new Error('network down');
        },
      }),
    };
    const boom = capture(root);
    expect(await main(['build'], boom.io, fakeServices(exploding))).toBe(2);
    expect(boom.err()).toBe('error: network down\n');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run cli-build`
Expected: FAIL, `buildSummary` is not exported.

- [ ] **Step 3: Implement**

Replace `packages/cli/src/cli.ts` with:
```ts
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { AnthropicGenerator } from './anthropic.js';
import { runBuild, type BuildResult } from './build.js';
import { runCheck } from './check.js';
import { formatDiagnostic, type Diagnostic } from './diagnostics.js';
import type { Generator } from './llm.js';
import { VERSION } from './version.js';

export interface Io {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  confirm?(question: string): Promise<boolean>;
}

export interface Services {
  generator(): Generator;
}

const defaultServices: Services = { generator: () => new AnthropicGenerator() };

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function summary(concepts: number, errors: number, warnings: number): string {
  const subject = plural(concepts, 'concept');
  if (errors === 0 && warnings === 0) {
    return `✓ ${subject}, no problems`;
  }
  return `${subject}: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`;
}

export function buildSummary(result: BuildResult): string {
  if (result.ok) {
    return `✓ build complete: ${result.generated.tests.length} test file(s) and ${result.generated.impl.length} implementation(s) generated`;
  }
  return `build failed: ${result.failed.length} failed, ${result.skipped.length} skipped`;
}

function printDiagnostics(io: Io, diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    io.stdout(`${formatDiagnostic(d)}\n`);
  }
}

async function checkCommand(root: string, io: Io): Promise<number> {
  const { project, diagnostics } = await runCheck(root);
  printDiagnostics(io, diagnostics);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  io.stdout(`${summary(project.concepts.size, errors, warnings)}\n`);
  return errors > 0 ? 1 : 0;
}

interface BuildCommandOptions {
  only: string | undefined;
  dryRun: boolean;
  testsOnly: boolean;
}

async function buildCommand(root: string, io: Io, services: Services, options: BuildCommandOptions): Promise<number> {
  const result = await runBuild({
    root,
    generator: services.generator(),
    ...(options.only === undefined ? {} : { only: options.only }),
    dryRun: options.dryRun,
    testsOnly: options.testsOnly,
    log: (line) => io.stdout(`${line}\n`),
  });
  printDiagnostics(io, result.diagnostics);
  if (options.dryRun && result.ok) {
    for (const item of result.plan) {
      const what = [item.tests ? 'tests' : '', item.impl ? 'impl' : ''].filter((part) => part !== '').join('+') || 'up to date';
      io.stdout(`${what.padEnd(12)}${item.id}\n`);
    }
    const calls = result.plan.filter((item) => item.tests).length + result.plan.filter((item) => item.impl).length;
    io.stdout(`${calls} generation(s) planned\n`);
    return 0;
  }
  io.stdout(`${buildSummary(result)}\n`);
  return result.ok ? 0 : 1;
}

export async function main(argv: readonly string[], io: Io, services: Services = defaultServices): Promise<number> {
  let exitCode = 0;
  const rootOf = (dir: string): string => path.resolve(io.cwd, dir);
  const program = new Command('ccc')
    .description('chris-chad-concepts: compile concept models into code')
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  program
    .command('check')
    .description('validate the concept model (no LLM calls)')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string }) => {
      exitCode = await checkCommand(rootOf(options.dir), io);
    });
  program
    .command('build [concept]')
    .description('generate tests and implementations for stale concepts')
    .option('-C, --dir <path>', 'project root', '.')
    .option('--dry-run', 'show what would be generated, without calling the LLM', false)
    .action(async (concept: string | undefined, options: { dir: string; dryRun: boolean }) => {
      exitCode = await buildCommand(rootOf(options.dir), io, services, { only: concept, dryRun: options.dryRun, testsOnly: false });
    });
  program
    .command('tests [concept]')
    .description('generate tests only')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (concept: string | undefined, options: { dir: string }) => {
      exitCode = await buildCommand(rootOf(options.dir), io, services, { only: concept, dryRun: false, testsOnly: true });
    });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  return exitCode;
}
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run cli` (expected: PASS, including Plan 1's `cli.test.ts`), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/cli.ts packages/cli/test/cli-build.test.ts
git commit -m "Add ccc build and ccc tests commands"
```

---

### Task 15: `ccc approve` and `ccc verify`

**Files:**
- Create: `packages/cli/src/approve.ts`, `packages/cli/src/verify.ts`
- Modify: `packages/cli/src/cli.ts` (commands), `packages/cli/src/bin.ts` (interactive confirm)
- Test: `packages/cli/test/verify.test.ts`, `packages/cli/test/cli-approve.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `writeManifest`, `listCccFiles`, `hashFiles`, `Manifest` (Task 5); `sha256` (Task 1); `readFileOrNull` (Task 5); `testPath` (Task 2); `runCheck` (Plan 1); `loadConfig` (Task 1); `loadVersions` (Task 4); `testKey`, `implKey` (Task 4); `isHandwritten` (Task 11); `runTests` (Task 7); `collectExports` (Plan 1); pipeline fixture (Task 10); `runBuild` (Task 13, in tests).
- Produces:
  - `approve.ts`: `interface PendingApproval { id: ConceptId; file: string; source: string; edited: boolean }`; `pendingApprovals(root, manifest, only?: ConceptId): Promise<PendingApproval[]>`; `approve(manifest, pending: readonly PendingApproval[]): void`
  - `verify.ts`: `runVerify(root: string): Promise<{ diagnostics: Diagnostic[] }>`
  - CLI: `ccc approve [concept] [--yes] [-C dir]`, `ccc verify [-C dir]`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/verify.test.ts`:
```ts
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { approve, pendingApprovals } from '../src/approve.js';
import { runBuild } from '../src/build.js';
import { readFileOrNull, writeFileAtomic } from '../src/fsutil.js';
import { modulePath, testPath } from '../src/layout.js';
import { readManifest, writeManifest } from '../src/manifest.js';
import { runVerify } from '../src/verify.js';
import { FakeGenerator } from './fake-generator.js';
import { PIPELINE_FILES, createPipelineProject, pipelineResponder } from './pipeline-fixture.js';

let built = '';

async function copy(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-verify-'));
  await cp(built, dir, { recursive: true });
  return dir;
}

async function approveEverything(root: string): Promise<void> {
  const { manifest } = await readManifest(root);
  approve(manifest, await pendingApprovals(root, manifest));
  await writeManifest(root, manifest);
}

async function messages(root: string): Promise<string[]> {
  return (await runVerify(root)).diagnostics.map((d) => `${d.file}: ${d.message}`);
}

beforeAll(async () => {
  built = await createPipelineProject();
  await runBuild({ root: built, generator: new FakeGenerator(pipelineResponder()) });
}, 180_000);

describe('approvals', () => {
  it('lists unapproved test files and approves them', async () => {
    const root = await copy();
    const { manifest } = await readManifest(root);
    const pending = await pendingApprovals(root, manifest);
    expect(pending.map((p) => `${p.id} ${p.file} ${p.edited}`)).toEqual([
      'card .ccc/gen/card.test.ts false',
      'count-adds .ccc/gen/count-adds.test.ts false',
      'counter .ccc/gen/counter.test.ts false',
      'hand .ccc/gen/hand.test.ts false',
    ]);
    approve(manifest, pending);
    expect(await pendingApprovals(root, manifest)).toEqual([]);
    expect((await pendingApprovals(root, manifest, 'hand')).length).toBe(0);
  });

  it('never approves a test file edited since generation', async () => {
    const root = await copy();
    await writeFileAtomic(root, testPath('hand'), '// edited\n');
    const { manifest } = await readManifest(root);
    const pending = await pendingApprovals(root, manifest, 'hand');
    expect(pending.map((p) => p.edited)).toEqual([true]);
    approve(manifest, pending);
    expect(manifest.concepts.hand?.approvedTestHash).toBeNull();
  });
});

describe('runVerify', () => {
  it('fails on unapproved tests, then passes once approved', async () => {
    const root = await copy();
    expect(await messages(root)).toEqual([
      '.ccc/gen/card.test.ts: tests are not approved; run ccc approve',
      '.ccc/gen/count-adds.test.ts: tests are not approved; run ccc approve',
      '.ccc/gen/counter.test.ts: tests are not approved; run ccc approve',
      '.ccc/gen/hand.test.ts: tests are not approved; run ccc approve',
    ]);
    await approveEverything(root);
    expect(await messages(root)).toEqual([]);
  });

  it('names modified, missing, and unrecorded files', async () => {
    const root = await copy();
    await approveEverything(root);
    await writeFileAtomic(root, modulePath('counter'), '// hand edit\n');
    await writeFileAtomic(root, '.ccc/gen/stray.ts', 'export {};\n');
    const { manifest } = await readManifest(root);
    manifest.files['.ccc/gen/ghost.ts'] = 'abc';
    await writeManifest(root, manifest);
    const found = await messages(root);
    expect(found).toContain('.ccc/gen/counter.ts: modified since ccc build generated it');
    expect(found).toContain('.ccc/gen/stray.ts: not recorded in the manifest (created outside ccc build?)');
    expect(found).toContain('.ccc/gen/ghost.ts: recorded in the manifest but missing');
  });

  it('reports concepts changed since the last build', async () => {
    const root = await copy();
    await approveEverything(root);
    const hand = PIPELINE_FILES['concepts/hand.md'] ?? '';
    await writeFileAtomic(root, 'concepts/hand.md', hand.replace('never holds the same card twice', 'never holds a card twice'));
    const card = PIPELINE_FILES['concepts/card.md'] ?? '';
    await writeFileAtomic(root, 'concepts/card.md', card.replace('A playing card.', 'A playing card!'));
    const counter = PIPELINE_FILES['concepts/counter.md'] ?? '';
    await writeFileAtomic(root, 'concepts/counter.md', counter.replace('- new Counter().value() → 0', '- a new counter reads 0'));
    const found = await messages(root);
    expect(found).toContain('concepts/hand.md: changed since the last build (implementation is stale); run ccc build');
    expect(found).toContain('concepts/card.md: changed since the last build (tests are stale); run ccc build');
    expect(found).toContain('concepts/counter.md: changed since the last build (tests are stale); run ccc build');
  });

  it('reports failing tests and unbuilt concepts', async () => {
    const root = await copy();
    await approveEverything(root);
    const { manifest } = await readManifest(root);
    delete manifest.concepts.counter;
    await writeManifest(root, manifest);
    expect(await messages(root)).toContain('concepts/counter.md: not built; run ccc build');
    const fresh = await copy();
    await approveEverything(fresh);
    const cardModule = (await readFileOrNull(fresh, modulePath('card'))) ?? '';
    await writeFileAtomic(fresh, modulePath('card'), cardModule.replace('return { rank, suit };', 'return { rank: suit, suit: rank };'));
    const found = await messages(fresh);
    expect(found).toContain('.ccc/gen/card.ts: modified since ccc build generated it');
    expect(found.some((line) => line.startsWith('.ccc/gen/card.test.ts: test failed: [ex 1]'))).toBe(true);
  });
});
```

`packages/cli/test/cli-approve.test.ts`:
```ts
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { main, type Io } from '../src/cli.js';
import { FakeGenerator } from './fake-generator.js';
import { createPipelineProject, pipelineResponder } from './pipeline-fixture.js';

let built = '';

beforeAll(async () => {
  built = await createPipelineProject();
  await runBuild({ root: built, generator: new FakeGenerator(pipelineResponder()) });
}, 180_000);

async function copy(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-approve-'));
  await cp(built, dir, { recursive: true });
  return dir;
}

function capture(cwd: string, answers?: boolean[]) {
  let out = '';
  const io: Io = {
    cwd,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      out += text;
    },
  };
  if (answers !== undefined) {
    io.confirm = async () => answers.shift() ?? false;
  }
  return { io, out: () => out };
}

const services = { generator: () => new FakeGenerator(pipelineResponder()) };

describe('ccc approve / verify', () => {
  it('requires --yes without an interactive terminal', async () => {
    const root = await copy();
    const cap = capture(root);
    expect(await main(['approve'], cap.io, services)).toBe(1);
    expect(cap.out()).toContain('=== .ccc/gen/card.test.ts (card) ===');
    expect(cap.out().trimEnd().split('\n').at(-1)).toBe('re-run with --yes to approve');
  });

  it('approves with --yes, after which verify passes', async () => {
    const root = await copy();
    const approveOut = capture(root);
    expect(await main(['approve', '--yes'], approveOut.io, services)).toBe(0);
    expect(approveOut.out().trimEnd().split('\n').at(-1)).toBe('approved 4 of 4');
    const verifyOut = capture(root);
    expect(await main(['verify'], verifyOut.io, services)).toBe(0);
    expect(verifyOut.out()).toBe('✓ verified: generated code is current, approved, and passing\n');
    const again = capture(root);
    expect(await main(['approve', '--yes'], again.io, services)).toBe(0);
    expect(again.out()).toBe('nothing to approve\n');
  });

  it('asks per file when interactive', async () => {
    const root = await copy();
    const cap = capture(root, [true, false, true, true]);
    expect(await main(['approve'], cap.io, services)).toBe(1);
    expect(cap.out().trimEnd().split('\n').at(-1)).toBe('approved 3 of 4');
  });

  it('verify exits 1 with diagnostics when something is wrong', async () => {
    const root = await copy();
    const cap = capture(root);
    expect(await main(['verify'], cap.io, services)).toBe(1);
    expect(cap.out()).toContain('.ccc/gen/hand.test.ts:1: error: tests are not approved; run ccc approve');
    expect(cap.out().trimEnd().split('\n').at(-1)).toBe('verify failed: 4 problem(s)');
  });
});
```

Approval errors carry `line: 1` so the CLI prints `file:1: error: ...`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run verify cli-approve`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/cli/src/approve.ts`:
```ts
import { readFileOrNull } from './fsutil.js';
import { sha256 } from './hash.js';
import type { ConceptId } from './ids.js';
import { testPath } from './layout.js';
import type { Manifest } from './manifest.js';

export interface PendingApproval {
  id: ConceptId;
  file: string;
  source: string;
  edited: boolean;
}

export async function pendingApprovals(root: string, manifest: Manifest, only?: ConceptId): Promise<PendingApproval[]> {
  const pending: PendingApproval[] = [];
  for (const [id, entry] of Object.entries(manifest.concepts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if ((only !== undefined && id !== only) || entry.testFileHash === null || entry.approvedTestHash === entry.testFileHash) {
      continue;
    }
    const file = testPath(id);
    const source = (await readFileOrNull(root, file)) ?? '';
    pending.push({ id, file, source, edited: (await sha256(source)) !== entry.testFileHash });
  }
  return pending;
}

// Approval pins the generated test file's hash; a file edited since
// generation is never approved (regenerate it instead).
export function approve(manifest: Manifest, pending: readonly PendingApproval[]): void {
  for (const item of pending) {
    const entry = manifest.concepts[item.id];
    if (entry !== undefined && !item.edited) {
      entry.approvedTestHash = entry.testFileHash;
    }
  }
}
```

`packages/cli/src/verify.ts`:
```ts
import { runCheck } from './check.js';
import { loadConfig } from './config.js';
import { error, hasErrors, sortDiagnostics, type Diagnostic } from './diagnostics.js';
import { collectExports } from './interfaces.js';
import { implKey, testKey } from './keys.js';
import { testPath } from './layout.js';
import { hashFiles, listCccFiles, readManifest } from './manifest.js';
import { isHandwritten } from './schema.js';
import { runTests } from './toolchain.js';
import { loadVersions } from './versions.js';

// The CI gate from spec §6. Never calls the LLM.
export async function runVerify(root: string): Promise<{ diagnostics: Diagnostic[] }> {
  const check = await runCheck(root);
  const diagnostics: Diagnostic[] = [...check.diagnostics];
  if (hasErrors(diagnostics)) {
    return { diagnostics: sortDiagnostics(diagnostics) };
  }
  const manifestResult = await readManifest(root);
  const configResult = await loadConfig(root);
  diagnostics.push(...manifestResult.diagnostics, ...configResult.diagnostics);
  if (hasErrors(diagnostics)) {
    return { diagnostics: sortDiagnostics(diagnostics) };
  }
  const { manifest } = manifestResult;
  const project = check.project;
  const exportsByConcept = collectExports(project);
  const versions = await loadVersions(configResult.config);

  const onDisk = await listCccFiles(root);
  const hashes = await hashFiles(root, onDisk);
  for (const file of onDisk) {
    const recorded = manifest.files[file];
    if (recorded === undefined) {
      diagnostics.push(error(file, 'not recorded in the manifest (created outside ccc build?)'));
    } else if (recorded !== hashes[file]) {
      diagnostics.push(error(file, 'modified since ccc build generated it'));
    }
  }
  for (const file of Object.keys(manifest.files)) {
    if (hashes[file] === undefined) {
      diagnostics.push(error(file, 'recorded in the manifest but missing'));
    }
  }

  for (const concept of project.concepts.values()) {
    const entry = manifest.concepts[concept.id];
    if (entry === undefined || entry.testFileHash === null) {
      diagnostics.push(error(concept.file, 'not built; run ccc build'));
      continue;
    }
    if ((await testKey(concept, project, exportsByConcept, versions)) !== entry.testKey) {
      diagnostics.push(error(concept.file, 'changed since the last build (tests are stale); run ccc build'));
    } else if (
      !isHandwritten(concept.frontmatter) &&
      (await implKey(concept, project, exportsByConcept, versions, entry.testFileHash)) !== entry.implKey
    ) {
      diagnostics.push(error(concept.file, 'changed since the last build (implementation is stale); run ccc build'));
    }
    if (entry.approvedTestHash !== entry.testFileHash) {
      diagnostics.push(error(testPath(concept.id), 'tests are not approved; run ccc approve', { line: 1 }));
    }
  }

  const testFiles = onDisk.filter((file) => file.endsWith('.test.ts'));
  const run = await runTests(root, testFiles);
  for (const issue of run.errors) {
    diagnostics.push(error(issue.file || 'concepts/', `test file failed to run: ${issue.message.split('\n')[0] ?? ''}`));
  }
  for (const testCase of run.cases.filter((c) => c.status === 'failed')) {
    diagnostics.push(error(testCase.file, `test failed: ${testCase.name}: ${testCase.message.split('\n')[0] ?? ''}`));
  }
  return { diagnostics: sortDiagnostics(diagnostics) };
}
```

The `runVerify` "unapproved" test lists messages without line numbers because it formats `file: message`; the CLI prints `formatDiagnostic`, which includes `:1`.

In `packages/cli/src/cli.ts`, add imports:
```ts
import { approve, pendingApprovals, type PendingApproval } from './approve.js';
import { hasErrors } from './diagnostics.js';
import { readManifest, writeManifest } from './manifest.js';
import { runVerify } from './verify.js';
```
(merge `hasErrors` into the existing `./diagnostics.js` import), add these functions above `main`:
```ts
async function approveCommand(root: string, io: Io, options: { only: string | undefined; yes: boolean }): Promise<number> {
  const { manifest, diagnostics } = await readManifest(root);
  printDiagnostics(io, diagnostics);
  if (hasErrors(diagnostics)) {
    return 1;
  }
  const pending = await pendingApprovals(root, manifest, options.only);
  if (pending.length === 0) {
    io.stdout('nothing to approve\n');
    return 0;
  }
  const chosen: PendingApproval[] = [];
  for (const item of pending) {
    io.stdout(`\n=== ${item.file} (${item.id}) ===\n${item.source}\n`);
    if (item.edited) {
      io.stdout('this file was edited after generation; regenerate it with ccc tests instead\n');
      continue;
    }
    if (options.yes || (io.confirm !== undefined && (await io.confirm(`approve tests for ${item.id}?`)))) {
      chosen.push(item);
    }
  }
  if (!options.yes && io.confirm === undefined) {
    io.stdout('re-run with --yes to approve\n');
    return 1;
  }
  approve(manifest, chosen);
  await writeManifest(root, manifest);
  io.stdout(`approved ${chosen.length} of ${pending.length}\n`);
  return chosen.length === pending.length ? 0 : 1;
}

async function verifyCommand(root: string, io: Io): Promise<number> {
  const { diagnostics } = await runVerify(root);
  printDiagnostics(io, diagnostics);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  io.stdout(errors === 0 ? '✓ verified: generated code is current, approved, and passing\n' : `verify failed: ${errors} problem(s)\n`);
  return errors === 0 ? 0 : 1;
}
```
and register the commands in `main` after `tests`:
```ts
  program
    .command('approve [concept]')
    .description('review and approve generated test files')
    .option('-C, --dir <path>', 'project root', '.')
    .option('-y, --yes', 'approve without asking', false)
    .action(async (concept: string | undefined, options: { dir: string; yes: boolean }) => {
      exitCode = await approveCommand(rootOf(options.dir), io, { only: concept, yes: options.yes });
    });
  program
    .command('verify')
    .description('CI gate: generated code is current, approved, and passing (no LLM calls)')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string }) => {
      exitCode = await verifyCommand(rootOf(options.dir), io);
    });
```

Replace `packages/cli/src/bin.ts` with:
```ts
#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main, type Io } from './cli.js';

const io: Io = {
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

if (process.stdin.isTTY) {
  io.confirm = async (question) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await readline.question(`${question} [y/N] `)).trim());
    } finally {
      readline.close();
    }
  };
}

process.exitCode = await main(process.argv.slice(2), io);
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run verify cli-approve` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/approve.ts packages/cli/src/verify.ts packages/cli/src/cli.ts packages/cli/src/bin.ts packages/cli/test/verify.test.ts packages/cli/test/cli-approve.test.ts
git commit -m "Add ccc approve and the ccc verify CI gate"
```

---

### Task 16: `ccc stats` and `ccc regen --compare`

**Files:**
- Create: `packages/cli/src/stats.ts`, `packages/cli/src/linediff.ts`, `packages/cli/src/regen.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/stats.test.ts`, `packages/cli/test/linediff.test.ts`, `packages/cli/test/regen.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `Generation`, `readManifest` (Task 5); `generateImpl` (Task 12); `runCheck`, `collectExports` (Plan 1); `loadConfig` (Task 1); `loadVersions`, `implKey` (Task 4); `sha256` (Task 1); `readFileOrNull` (Task 5); `modulePath`, `testPath` (Task 2); `isHandwritten` (Task 11); pipeline fixture and `runBuild` (tests).
- Produces:
  - `stats.ts`: `interface ArtifactStats { generations: number; firstAttemptPasses: number; passed: number; meanAttempts: number; costUsd: number; unpriced: number }`; `interface Stats { impl: ArtifactStats; tests: ArtifactStats; pendingApprovals: number; perConcept: { id: string; costUsd: number; generations: number }[] }`; `computeStats(manifest: Manifest): Stats`; `formatStats(stats: Stats): string`
  - `linediff.ts`: `lineDiff(before: string, after: string): { added: number; removed: number }`
  - `regen.ts`: `interface RegenResult { diagnostics: Diagnostic[]; passed: boolean; attempts: number; added: number; removed: number; costUsd: number | null }`; `runRegen(root: string, id: ConceptId, generator: Generator): Promise<RegenResult>`
  - CLI: `ccc stats [-C dir]`, `ccc regen --compare <concept> [-C dir]`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/linediff.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { lineDiff } from '../src/linediff.js';

describe('lineDiff', () => {
  it('counts added and removed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual({ added: 2, removed: 1 });
    expect(lineDiff('', 'a')).toEqual({ added: 1, removed: 1 });
  });
});
```

`packages/cli/test/stats.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { computeStats, formatStats } from '../src/stats.js';
import { emptyManifest, entryFor, type Generation } from '../src/manifest.js';

const gen = (artifact: 'tests' | 'impl', attempts: number, outcome: 'passed' | 'failed', costUsd: number | null): Generation => ({
  artifact,
  at: '2026-09-24T00:00:00.000Z',
  model: 'claude-opus-5',
  attempts,
  inputTokens: 1,
  outputTokens: 1,
  costUsd,
  durationMs: 1,
  outcome,
});

describe('stats', () => {
  it('summarizes generation history', () => {
    const manifest = emptyManifest();
    const hand = entryFor(manifest, 'hand');
    hand.history.push(gen('tests', 1, 'passed', 0.01), gen('impl', 2, 'passed', 0.03), gen('impl', 3, 'failed', 0.05));
    hand.testFileHash = 'x';
    const card = entryFor(manifest, 'card');
    card.history.push(gen('tests', 1, 'passed', null), gen('impl', 1, 'passed', 0.02));
    card.testFileHash = 'y';
    card.approvedTestHash = 'y';
    const stats = computeStats(manifest);
    expect(stats.impl).toEqual({ generations: 3, firstAttemptPasses: 1, passed: 2, meanAttempts: 2, costUsd: 0.1, unpriced: 0 });
    expect(stats.tests).toEqual({ generations: 2, firstAttemptPasses: 2, passed: 2, meanAttempts: 1, costUsd: 0.01, unpriced: 1 });
    expect(stats.pendingApprovals).toBe(1);
    expect(stats.perConcept).toEqual([
      { id: 'hand', costUsd: 0.09, generations: 3 },
      { id: 'card', costUsd: 0.02, generations: 2 },
    ]);
    expect(formatStats(stats)).toBe(
      [
        'implementations: 3 generation(s), 1 passed on the first attempt (33%), 2 passed, mean 2.00 attempts, $0.1000',
        'tests: 2 generation(s), 2 passed on the first attempt (100%), 2 passed, mean 1.00 attempts, $0.0100 (+1 unpriced)',
        'pending approvals: 1',
        'cost by concept:',
        '  hand  $0.0900 (3 generation(s))',
        '  card  $0.0200 (2 generation(s))',
      ].join('\n'),
    );
  });

  it('handles an empty manifest', () => {
    expect(formatStats(computeStats(emptyManifest()))).toBe(
      'implementations: no generations yet\ntests: no generations yet\npending approvals: 0',
    );
  });
});
```

`packages/cli/test/regen.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { main, type Io } from '../src/cli.js';
import { readFileOrNull } from '../src/fsutil.js';
import { modulePath } from '../src/layout.js';
import { runRegen } from '../src/regen.js';
import { FakeGenerator } from './fake-generator.js';
import { CANNED_IMPL, createPipelineProject, pipelineResponder } from './pipeline-fixture.js';

let root = '';

beforeAll(async () => {
  root = await createPipelineProject();
  await runBuild({ root, generator: new FakeGenerator(pipelineResponder()) });
}, 180_000);

describe('runRegen', () => {
  it('regenerates without writing and reports the diff against the committed module', async () => {
    const before = await readFileOrNull(root, modulePath('counter'));
    const manifestBefore = await readFileOrNull(root, '.ccc/manifest.json');
    const variant = (CANNED_IMPL.counter ?? '').replace('#count = 0;', '#count = 0;\n  readonly #label = "counter";');
    const result = await runRegen(root, 'counter', new FakeGenerator(pipelineResponder({ 'impl:counter': () => variant })));
    expect(result).toMatchObject({ diagnostics: [], passed: true, attempts: 1, added: 1, removed: 0 });
    expect(result.costUsd).toBeCloseTo(0.00175);
    expect(await readFileOrNull(root, modulePath('counter'))).toBe(before);
    expect(await readFileOrNull(root, '.ccc/manifest.json')).toBe(manifestBefore);
  });

  it('reports failure and rejects unknown concepts', async () => {
    const failing = await runRegen(root, 'counter', new FakeGenerator(pipelineResponder({ 'impl:counter': () => null })));
    expect(failing).toMatchObject({ passed: false, attempts: 3 });
    const unknown = await runRegen(root, 'nope', new FakeGenerator(pipelineResponder()));
    expect(unknown.diagnostics.map((d) => d.message)).toEqual(["unknown concept 'nope'"]);
  });
});

describe('ccc stats / regen', () => {
  function capture(): { io: Io; out: () => string } {
    let out = '';
    return {
      io: {
        cwd: root,
        stdout: (text) => {
          out += text;
        },
        stderr: (text) => {
          out += text;
        },
      },
      out: () => out,
    };
  }
  const services = { generator: () => new FakeGenerator(pipelineResponder()) };

  it('prints stats', async () => {
    const cap = capture();
    expect(await main(['stats'], cap.io, services)).toBe(0);
    expect(cap.out()).toContain('implementations: ');
    expect(cap.out()).toContain('pending approvals: 4');
  });

  it('prints a regen comparison', async () => {
    const cap = capture();
    expect(await main(['regen', '--compare', 'counter'], cap.io, services)).toBe(0);
    expect(cap.out()).toMatch(/^regen counter: passed the approved tests in 1 attempt\(s\); diff vs committed: \+0 -0 lines; cost \$0\.\d{4}\n$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run linediff stats regen`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/cli/src/linediff.ts`:
```ts
// Line-level diff size via longest common subsequence; generated modules are
// small enough for the O(n·m) table.
export function lineDiff(before: string, after: string): { added: number; removed: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  const cols = b.length + 1;
  const table = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const common = table[0] ?? 0;
  return { added: b.length - common, removed: a.length - common };
}
```

`packages/cli/src/stats.ts`:
```ts
import type { Generation, Manifest } from './manifest.js';

export interface ArtifactStats {
  generations: number;
  firstAttemptPasses: number;
  passed: number;
  meanAttempts: number;
  costUsd: number;
  unpriced: number;
}

export interface Stats {
  impl: ArtifactStats;
  tests: ArtifactStats;
  pendingApprovals: number;
  perConcept: { id: string; costUsd: number; generations: number }[];
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function summarize(generations: readonly Generation[]): ArtifactStats {
  const priced = generations.filter((g) => g.costUsd !== null);
  const attempts = generations.reduce((sum, g) => sum + g.attempts, 0);
  return {
    generations: generations.length,
    firstAttemptPasses: generations.filter((g) => g.outcome === 'passed' && g.attempts === 1).length,
    passed: generations.filter((g) => g.outcome === 'passed').length,
    meanAttempts: generations.length === 0 ? 0 : round(attempts / generations.length, 2),
    costUsd: round(
      priced.reduce((sum, g) => sum + (g.costUsd ?? 0), 0),
      6,
    ),
    unpriced: generations.length - priced.length,
  };
}

export function computeStats(manifest: Manifest): Stats {
  const entries = Object.entries(manifest.concepts);
  const all = entries.flatMap(([, entry]) => entry.history);
  return {
    impl: summarize(all.filter((g) => g.artifact === 'impl')),
    tests: summarize(all.filter((g) => g.artifact === 'tests')),
    pendingApprovals: entries.filter(([, e]) => e.testFileHash !== null && e.approvedTestHash !== e.testFileHash).length,
    perConcept: entries
      .map(([id, entry]) => ({
        id,
        costUsd: round(
          entry.history.reduce((sum, g) => sum + (g.costUsd ?? 0), 0),
          6,
        ),
        generations: entry.history.length,
      }))
      .filter((row) => row.generations > 0)
      .sort((a, b) => b.costUsd - a.costUsd || (a.id < b.id ? -1 : 1)),
  };
}

function line(label: string, stats: ArtifactStats): string {
  if (stats.generations === 0) {
    return `${label}: no generations yet`;
  }
  const rate = Math.round((stats.firstAttemptPasses / stats.generations) * 100);
  const unpriced = stats.unpriced > 0 ? ` (+${stats.unpriced} unpriced)` : '';
  return `${label}: ${stats.generations} generation(s), ${stats.firstAttemptPasses} passed on the first attempt (${rate}%), ${stats.passed} passed, mean ${stats.meanAttempts.toFixed(2)} attempts, $${stats.costUsd.toFixed(4)}${unpriced}`;
}

export function formatStats(stats: Stats): string {
  const lines = [line('implementations', stats.impl), line('tests', stats.tests), `pending approvals: ${stats.pendingApprovals}`];
  if (stats.perConcept.length > 0) {
    const width = Math.max(...stats.perConcept.map((row) => row.id.length));
    lines.push(
      'cost by concept:',
      ...stats.perConcept.map((row) => `  ${row.id.padEnd(width)}  $${row.costUsd.toFixed(4)} (${row.generations} generation(s))`),
    );
  }
  return lines.join('\n');
}
```

`packages/cli/src/regen.ts`:
```ts
import { runCheck } from './check.js';
import { loadConfig } from './config.js';
import { error, hasErrors, type Diagnostic } from './diagnostics.js';
import { readFileOrNull } from './fsutil.js';
import { sha256 } from './hash.js';
import type { ConceptId } from './ids.js';
import { generateImpl } from './implgen.js';
import { collectExports } from './interfaces.js';
import { implKey } from './keys.js';
import { modulePath, testPath } from './layout.js';
import { lineDiff } from './linediff.js';
import type { Generator } from './llm.js';
import { isHandwritten } from './schema.js';
import { loadVersions } from './versions.js';

export interface RegenResult {
  diagnostics: Diagnostic[];
  passed: boolean;
  attempts: number;
  added: number;
  removed: number;
  costUsd: number | null;
}

// Spec §3.5: regenerate one implementation ignoring the cache, check it
// against the approved tests, and measure how far it drifts. Writes nothing.
export async function runRegen(root: string, id: ConceptId, generator: Generator): Promise<RegenResult> {
  const result: RegenResult = { diagnostics: [], passed: false, attempts: 0, added: 0, removed: 0, costUsd: null };
  const check = await runCheck(root);
  result.diagnostics.push(...check.diagnostics.filter((d) => d.severity === 'error'));
  const concept = check.project.concepts.get(id);
  if (concept === undefined) {
    result.diagnostics.push(error('concepts/', `unknown concept '${id}'`));
    return result;
  }
  if (isHandwritten(concept.frontmatter)) {
    result.diagnostics.push(error(concept.file, 'handwritten concepts are not generated'));
  }
  const testSource = await readFileOrNull(root, testPath(id));
  if (testSource === null) {
    result.diagnostics.push(error(concept.file, 'no tests exist for this concept; run ccc build first'));
  }
  const configResult = await loadConfig(root);
  result.diagnostics.push(...configResult.diagnostics);
  if (hasErrors(result.diagnostics) || testSource === null) {
    return result;
  }
  const exportsByConcept = collectExports(check.project);
  const versions = await loadVersions(configResult.config);
  const key = await implKey(concept, check.project, exportsByConcept, versions, await sha256(testSource));
  const committed = (await readFileOrNull(root, modulePath(id))) ?? '';
  const outcome = await generateImpl(
    { root, project: check.project, exportsByConcept, generator, config: configResult.config, now: Date.now },
    concept,
    testSource,
    { key, commit: false },
  );
  result.attempts = outcome.record.attempts;
  result.costUsd = outcome.record.costUsd;
  result.passed = outcome.source !== null;
  if (outcome.source !== null) {
    Object.assign(result, lineDiff(committed, outcome.source));
  }
  return result;
}
```

In `packages/cli/src/cli.ts`, add imports:
```ts
import { runRegen } from './regen.js';
import { computeStats, formatStats } from './stats.js';
```
add above `main`:
```ts
async function statsCommand(root: string, io: Io): Promise<number> {
  const { manifest, diagnostics } = await readManifest(root);
  printDiagnostics(io, diagnostics);
  if (hasErrors(diagnostics)) {
    return 1;
  }
  io.stdout(`${formatStats(computeStats(manifest))}\n`);
  return 0;
}

async function regenCommand(root: string, io: Io, services: Services, id: string): Promise<number> {
  const result = await runRegen(root, id, services.generator());
  printDiagnostics(io, result.diagnostics);
  if (hasErrors(result.diagnostics)) {
    return 1;
  }
  const cost = result.costUsd === null ? 'unknown' : `$${result.costUsd.toFixed(4)}`;
  io.stdout(
    result.passed
      ? `regen ${id}: passed the approved tests in ${result.attempts} attempt(s); diff vs committed: +${result.added} -${result.removed} lines; cost ${cost}\n`
      : `regen ${id}: FAILED after ${result.attempts} attempt(s); cost ${cost}\n`,
  );
  return result.passed ? 0 : 1;
}
```
and register after `verify`:
```ts
  program
    .command('stats')
    .description('generation pass rates and cost from the manifest')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string }) => {
      exitCode = await statsCommand(rootOf(options.dir), io);
    });
  program
    .command('regen')
    .description('regenerate one implementation ignoring the cache and compare it (writes nothing)')
    .requiredOption('--compare <concept>', 'concept to regenerate')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string; compare: string }) => {
      exitCode = await regenCommand(rootOf(options.dir), io, services, options.compare);
    });
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `pnpm --filter @ccc/cli exec vitest run linediff stats regen` (expected: PASS), then `pnpm verify` (expected: all green).
```bash
git add packages/cli/src/linediff.ts packages/cli/src/stats.ts packages/cli/src/regen.ts packages/cli/src/cli.ts packages/cli/test/linediff.test.ts packages/cli/test/stats.test.ts packages/cli/test/regen.test.ts
git commit -m "Add ccc stats and ccc regen --compare"
```

---

### Task 17: Documentation, live test, and spec amendments

**Files:**
- Create: `docs/building.md`, `packages/cli/vitest.live.config.ts`, `packages/cli/test-live/live.test.ts`
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-24-ccc-design.md`, `packages/cli/package.json`, `packages/cli/tsconfig.json`

**Interfaces:**
- Consumes: the behavior of Tasks 1–16.
- Produces: user documentation for the build workflow, and a spec that matches the implementation.

- [ ] **Step 1: Write `docs/building.md`**

````markdown
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
| `.ccc/conformance/<id>.ts` | Compile-time proof the module matches its interface, with no extra exports | no |
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
````

- [ ] **Step 2: Update `README.md`, `CLAUDE.md`, and the spec**

In `README.md`, replace the status line with:
```markdown
Status: research prototype. `check`, `build`, `tests`, `approve`, `verify`, `stats`, and `regen --compare` work; runtime wiring and adapters come next.
```
and add under the doc links:
```markdown
- Building and CI: [docs/building.md](docs/building.md)
```

In `CLAUDE.md`, add under Conventions:
```markdown
- Tests never call the Claude API; use `test/fake-generator.ts` and `test/pipeline-fixture.ts`
- Build-pipeline tests run the real tsc/oxlint/Vitest toolchain and take minutes
```

In the spec `docs/superpowers/specs/2026-09-24-ccc-design.md`, apply these amendments:
1. §3.1 layout: add `.ccc/conformance/` ("conformance checks, deterministic, committed"), `.ccc/package.json` and `.ccc/.gitignore`, and note that scratch work happens in `.ccc/.tmp/` (ignored).
2. §3.1 config: the example model becomes `claude-opus-5` for both, and add `testMaxAttempts`. `defineConfig` arrives with `@ccc/runtime` in Plan 3; a plain object export works meanwhile.
3. §3.3: drop `implFileHash` from entries; file hashes live in a top-level `files` map covering every generated file.
4. §4.3: import rules are enforced by ccc's own import scanner (not oxlint); oxlint enforces `no-explicit-any`. Tests may import the module under test and all transitive dependencies.
5. §4.2: note the Claude request settings (adaptive thinking, `fallbacks: "default"`, strict `write_module`, `tool_choice: auto`).

- [ ] **Step 3: Add the opt-in live test (spec §7.4)**

`packages/cli/vitest.live.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test-live/**/*.test.ts'],
    testTimeout: 600_000,
  },
});
```

`packages/cli/test-live/live.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AnthropicGenerator } from '../src/anthropic.js';
import { runBuild } from '../src/build.js';
import { readFileOrNull } from '../src/fsutil.js';
import { writeProject } from '../test/helpers.js';
import { PIPELINE_FILES } from '../test/pipeline-fixture.js';

// Spends real money: builds the card concept with Claude. Run only with
// `pnpm --filter @ccc/cli test:live`, credentials supplied by the SDK
// (ANTHROPIC_API_KEY, e.g. via `op run`, or an `ant auth login` profile).
describe('live build', () => {
  it('builds a real concept with Claude', async () => {
    const root = await writeProject({
      'package.json': PIPELINE_FILES['package.json'] ?? '',
      'concepts/card.md': PIPELINE_FILES['concepts/card.md'] ?? '',
    });
    const result = await runBuild({ root, generator: new AnthropicGenerator(), log: (line) => console.log(line) });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(await readFileOrNull(root, '.ccc/gen/card.ts')).toContain('export function card');
  });
});
```

In `packages/cli/package.json` add the script `"test:live": "vitest run --config vitest.live.config.ts"`, and add `"test-live"` and `"vitest.live.config.ts"` to the `include` array of `packages/cli/tsconfig.json`. Do not run it as part of this plan; it needs credentials and costs money.

- [ ] **Step 4: Gates and commit**

Run: `pnpm verify` (expected: all green; the live test is not part of `pnpm test`).
```bash
git add docs/building.md README.md CLAUDE.md docs/superpowers/specs/2026-09-24-ccc-design.md packages/cli/vitest.live.config.ts packages/cli/test-live packages/cli/package.json packages/cli/tsconfig.json
git commit -m "Document the build workflow, add the opt-in live test, align the spec"
```
