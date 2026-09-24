# ccc Plan 1: Foundation and `ccc check` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pnpm workspace with a `ccc` CLI whose `ccc check` command loads a concept project, validates it against every rule in spec §2.8, and reports file-located diagnostics, with no LLM calls.

**Architecture:** Small single-purpose modules in `packages/cli/src`: path/ID logic (`ids`), zod schema (`schema`), file parsing (`parse`), project loading (`load`), graph rules (`graph`, `cycles`), interface emission and type-checking (`interfaces`, `typecheck`), sync rules (`syncs`), then an orchestrator (`check`) and a commander CLI (`cli`, `bin`). Every rule returns `Diagnostic[]`; nothing throws for user errors.

**Tech Stack:** Node 24, pnpm 12 (via corepack), TypeScript 7 (`tsc`), `@typescript/typescript6` (AST reading only), zod 4, yaml 2, commander 15, Vitest 5, oxlint 1.

**Spec:** `docs/superpowers/specs/2026-09-24-ccc-design.md` (sections 2, 7.2, 7.5 are implemented here).

**Plan series:** This is Plan 1 of 4. Plan 2: build pipeline (keys, manifest, generators, test generation/approval, repair loop, `build`/`verify`/`stats`/`regen`). Plan 3: `@ccc/runtime`, adapters, wiring, composition root, `db reset`. Plan 4: the card-game example as the acceptance test. Each gets its own plan after the previous one lands.

**Where to work:** Before Task 1, create a worktree with the `add-worktree` skill for branch `plan-1-foundation` (this repo uses the bare-repo + `worktrees/` layout). All paths below are relative to that worktree root.

## Global Constraints

- Node `>=24`; package manager `pnpm@12.6.0` via corepack. Never use npm to install (npm links TS 6's `tsc` over TS 7's).
- TypeScript strict; never write the `any` or `unknown` types (validate external data with zod instead).
- 2-space indentation; always end statements with semicolons.
- Async APIs only (`node:fs/promises`, promisified `execFile`); no `*Sync` calls.
- ESM everywhere (`"type": "module"`); relative imports use the `.js` extension; type-only imports use `import type` (`verbatimModuleSyntax`).
- Lint with oxlint (not ESLint; typescript-eslint doesn't support TS 7).
- Concept IDs derive from paths; path segments are lowercase kebab-case.
- Every task ends green on: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- Commits are signed via 1Password SSH agent; expect an approval prompt. Never push.

## Review Focus

1. Markdown code fences containing `## ...` lines (e.g., a Decisions section quoting Markdown). They must not start a new section. Tested in Task 4.
2. Concept files saved with CRLF line endings or a UTF-8 BOM (Windows editors, some macOS tools). They must parse identically to LF files. Tested in Task 4.
3. Stray files under `concepts/` (`.DS_Store`, `notes.txt`). Dotfiles are silently ignored; other non-`.md` files produce a warning, not a crash. Tested in Task 5.
4. A directory with no parent concept file (`concepts/game/hand.md` without `concepts/game.md`). This must be a clear error naming the missing file. Tested in Task 5.
5. A sync placed inside an aggregate's directory (`concepts/game/deal.md` with `when: game.players#join`). It must not create a false dependency cycle through the aggregate's implicit children. Tested in Task 6.

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.oxlintrc.json`, `tsconfig.base.json`, `CLAUDE.md`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/tsconfig.build.json`, `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/version.ts`
- Test: `packages/cli/test/version.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VERSION: string` from `packages/cli/src/version.ts`; root scripts `build`, `typecheck`, `lint`, `test`, `verify`.

- [ ] **Step 1: Create root config files**

`package.json`:
```json
{
  "name": "ccc",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.6.0",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "pnpm -r run build",
    "typecheck": "pnpm -r run typecheck",
    "lint": "oxlint -c .oxlintrc.json packages",
    "test": "pnpm -r run test",
    "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "oxlint": "^1.85.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
.DS_Store
```

`.oxlintrc.json`:
```json
{
  "plugins": ["typescript"],
  "categories": {
    "correctness": "error"
  },
  "rules": {
    "typescript/no-explicit-any": "error"
  },
  "ignorePatterns": ["**/dist/**", "**/node_modules/**"]
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["node"],
    "declaration": true,
    "sourceMap": true
  }
}
```

`CLAUDE.md`:
```markdown
# ccc (chris-chad-concepts)

Compiles concept models (Markdown + YAML frontmatter under `concepts/`) into TypeScript.
Design: `docs/superpowers/specs/2026-09-24-ccc-design.md`. Schema reference: `docs/schema.md`.

## Commands
- `pnpm install`: install (pnpm only, never npm; enable with `corepack enable pnpm`)
- `pnpm verify`: lint + typecheck + test + build; must pass before any commit
- `pnpm --filter @ccc/cli exec vitest run <pattern>`: run a subset of CLI tests

## Conventions
- TypeScript strict; never write `any` or `unknown` (validate with zod)
- 2-space indent, semicolons always, ESM, `.js` extensions on relative imports, `import type` for types
- Async APIs only; no `*Sync`
- Lint is oxlint (typescript-eslint doesn't support TS 7)
- User-facing problems are returned as `Diagnostic[]`, never thrown
- Tests live in `packages/*/test/`
```

- [ ] **Step 2: Create the CLI package config**

`packages/cli/package.json`:
```json
{
  "name": "@ccc/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "ccc": "./dist/bin.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@typescript/typescript6": "^6.0.2",
    "commander": "^15.0.0",
    "typescript": "^7.0.2",
    "yaml": "^2.9.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "vitest": "^5.0.1"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/cli/tsconfig.build.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": false
  },
  "include": ["src"]
}
```

`packages/cli/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 3: Write the failing smoke test**

`packages/cli/test/version.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 4: Install and run the test to verify it fails**

Run:
```bash
corepack enable pnpm
pnpm install
pnpm --filter @ccc/cli test
```
Expected: install succeeds; the test FAILS because it cannot resolve `../src/version.js`.

- [ ] **Step 5: Implement**

`packages/cli/src/version.ts`:
```ts
export const VERSION = '0.1.0';
```

- [ ] **Step 6: Run every gate**

Run: `pnpm verify`
Expected: oxlint reports 0 errors; both `tsc` runs pass; 1 test passes; `packages/cli/dist/version.js` exists. Also run `pnpm --filter @ccc/cli exec tsc --version` and expect `Version 7.x`.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .gitignore .oxlintrc.json tsconfig.base.json CLAUDE.md packages/cli
git commit -m "Scaffold pnpm workspace and @ccc/cli package"
```

---

### Task 2: Concept IDs and visibility

**Files:**
- Create: `packages/cli/src/ids.ts`
- Test: `packages/cli/test/ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ConceptId = string`
  - `ID_PATTERN: RegExp`, `ACTION_PATTERN: RegExp`
  - `isValidSegment(segment: string): boolean`
  - `pathToId(relPath: string): ConceptId`: `'game/hand.md'` → `'game.hand'`; throws for non-`.md` (programmer error)
  - `idToPath(id: ConceptId): string`: `'game.hand'` → `'game/hand.md'`
  - `parentOf(id: ConceptId): ConceptId | null`
  - `ancestorsOf(id: ConceptId): ConceptId[]` (nearest first)
  - `isVisible(from: ConceptId, target: ConceptId): boolean`
  - `parseActionRef(ref: string): { conceptId: ConceptId; member: string }`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  ACTION_PATTERN,
  ID_PATTERN,
  ancestorsOf,
  idToPath,
  isValidSegment,
  isVisible,
  parentOf,
  parseActionRef,
  pathToId,
} from '../src/ids.js';

describe('isValidSegment', () => {
  it.each(['game', 'game-store', 'v2', 'a1-b2'])('accepts %s', (s) => {
    expect(isValidSegment(s)).toBe(true);
  });
  it.each(['Game', 'game_store', '1game', 'game-', '-game', '', 'game.store'])('rejects %j', (s) => {
    expect(isValidSegment(s)).toBe(false);
  });
});

describe('pathToId / idToPath', () => {
  it('maps nested paths to dotted ids', () => {
    expect(pathToId('game/player/hand.md')).toBe('game.player.hand');
    expect(pathToId('card.md')).toBe('card');
  });
  it('round-trips', () => {
    expect(idToPath('game.player.hand')).toBe('game/player/hand.md');
  });
  it('throws for non-markdown paths', () => {
    expect(() => pathToId('card.txt')).toThrow('not a concept file');
  });
});

describe('parentOf / ancestorsOf', () => {
  it('finds the parent', () => {
    expect(parentOf('game.player.hand')).toBe('game.player');
    expect(parentOf('card')).toBeNull();
  });
  it('lists ancestors nearest first', () => {
    expect(ancestorsOf('game.player.hand')).toEqual(['game.player', 'game']);
    expect(ancestorsOf('card')).toEqual([]);
  });
});

describe('isVisible', () => {
  it.each([
    ['game.player', 'game.player.hand', true, 'own child'],
    ['game.player.hand', 'game.player.score', true, 'sibling'],
    ['game.player.hand', 'card', true, 'top-level concept'],
    ['game.player.hand', 'game.deck', true, 'sibling of an ancestor'],
    ['game.deal-on-full-table', 'game', true, 'ancestor'],
    ['game', 'game.player.hand', false, 'grandchild is private'],
    ['game-api', 'game.player', false, 'nested inside another concept'],
    ['card', 'card', false, 'self'],
  ])('%s → %s is %s (%s)', (from, target, expected) => {
    expect(isVisible(from, target)).toBe(expected);
  });
});

describe('patterns and action refs', () => {
  it('matches ids and actions', () => {
    expect(ID_PATTERN.test('game.player.hand')).toBe(true);
    expect(ID_PATTERN.test('game..hand')).toBe(false);
    expect(ACTION_PATTERN.test('game.players#join')).toBe(true);
    expect(ACTION_PATTERN.test('game.players.join')).toBe(false);
  });
  it('splits an action ref', () => {
    expect(parseActionRef('game.players#join')).toEqual({ conceptId: 'game.players', member: 'join' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run ids`
Expected: FAIL, cannot resolve `../src/ids.js`.

- [ ] **Step 3: Implement**

`packages/cli/src/ids.ts`:
```ts
export type ConceptId = string;

const SEGMENT_SOURCE = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const ID_SOURCE = `${SEGMENT_SOURCE}(?:\\.${SEGMENT_SOURCE})*`;
const SEGMENT = new RegExp(`^${SEGMENT_SOURCE}$`);

export const ID_PATTERN = new RegExp(`^${ID_SOURCE}$`);
export const ACTION_PATTERN = new RegExp(`^${ID_SOURCE}#[A-Za-z_$][A-Za-z0-9_$]*$`);

export function isValidSegment(segment: string): boolean {
  return SEGMENT.test(segment);
}

export function pathToId(relPath: string): ConceptId {
  if (!relPath.endsWith('.md')) {
    throw new Error(`not a concept file: ${relPath}`);
  }
  return relPath.slice(0, -'.md'.length).split('/').join('.');
}

export function idToPath(id: ConceptId): string {
  return `${id.split('.').join('/')}.md`;
}

export function parentOf(id: ConceptId): ConceptId | null {
  const index = id.lastIndexOf('.');
  return index === -1 ? null : id.slice(0, index);
}

export function ancestorsOf(id: ConceptId): ConceptId[] {
  const ancestors: ConceptId[] = [];
  let current = parentOf(id);
  while (current !== null) {
    ancestors.push(current);
    current = parentOf(current);
  }
  return ancestors;
}

// Lexical visibility (spec §2.4): ancestors, own children, siblings, and
// siblings of ancestors. Equivalently: the target is an ancestor, or the
// target's parent is `from`, one of `from`'s ancestors, or the root.
export function isVisible(from: ConceptId, target: ConceptId): boolean {
  if (from === target) {
    return false;
  }
  const ancestors = ancestorsOf(from);
  if (ancestors.includes(target)) {
    return true;
  }
  const targetParent = parentOf(target);
  return targetParent === null || targetParent === from || ancestors.includes(targetParent);
}

export function parseActionRef(ref: string): { conceptId: ConceptId; member: string } {
  const index = ref.indexOf('#');
  return { conceptId: ref.slice(0, index), member: ref.slice(index + 1) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run ids`
Expected: PASS (all cases).

- [ ] **Step 5: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/ids.ts packages/cli/test/ids.test.ts
git commit -m "Add concept id, path, and lexical visibility rules"
```

---

### Task 3: Diagnostics and frontmatter schema

**Files:**
- Create: `packages/cli/src/diagnostics.ts`, `packages/cli/src/schema.ts`
- Test: `packages/cli/test/diagnostics.test.ts`, `packages/cli/test/schema.test.ts`

**Interfaces:**
- Consumes: `ID_PATTERN`, `ACTION_PATTERN` from `ids.ts`.
- Produces:
  - `diagnostics.ts`: `type Severity = 'error' | 'warning'`; `interface Diagnostic { severity: Severity; file: string; line?: number; message: string; hint?: string }`; `error(file: string, message: string, opts?: { line?: number; hint?: string }): Diagnostic`; `warning(...)` (same signature); `hasErrors(ds: readonly Diagnostic[]): boolean`; `sortDiagnostics(ds: readonly Diagnostic[]): Diagnostic[]`; `formatDiagnostic(d: Diagnostic): string`
  - `schema.ts`: `KINDS`, `DOMAIN_KINDS`, `ADAPTER_KINDS` (readonly tuples); `type Kind`; `frontmatterSchema` (zod); `type Frontmatter`; `isDomainKind(kind: Kind): boolean`; `isAdapterKind(kind: Kind): boolean`; `interface SectionRule { required: readonly string[]; recommended: readonly string[]; allowed: readonly string[] }`; `sectionRule(kind: Kind): SectionRule`; `usesOf(fm: Frontmatter): readonly string[]`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/diagnostics.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { error, formatDiagnostic, hasErrors, sortDiagnostics, warning } from '../src/diagnostics.js';

describe('diagnostics', () => {
  it('formats with line and hint', () => {
    const d = error('concepts/card.md', 'bad thing', { line: 3, hint: 'fix it' });
    expect(formatDiagnostic(d)).toBe('concepts/card.md:3: error: bad thing\n  hint: fix it');
  });
  it('formats without line or hint', () => {
    expect(formatDiagnostic(warning('concepts/card.md', 'meh'))).toBe('concepts/card.md: warning: meh');
  });
  it('detects errors', () => {
    expect(hasErrors([warning('a', 'x')])).toBe(false);
    expect(hasErrors([warning('a', 'x'), error('a', 'y')])).toBe(true);
  });
  it('sorts by file, then line, then message', () => {
    const sorted = sortDiagnostics([
      error('b.md', 'z', { line: 1 }),
      error('a.md', 'y', { line: 9 }),
      error('a.md', 'x', { line: 2 }),
      error('a.md', 'w'),
    ]);
    expect(sorted.map((d) => `${d.file}:${d.line ?? 0}:${d.message}`)).toEqual([
      'a.md:0:w',
      'a.md:2:x',
      'a.md:9:y',
      'b.md:1:z',
    ]);
  });
});
```

`packages/cli/test/schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { frontmatterSchema, isAdapterKind, isDomainKind, sectionRule, usesOf } from '../src/schema.js';

const iface = 'export interface Card { readonly rank: string; }';

describe('frontmatterSchema', () => {
  it('accepts a minimal value concept and fills defaults', () => {
    const result = frontmatterSchema.parse({ kind: 'value', interface: iface });
    expect(result).toEqual({ kind: 'value', interface: iface, uses: [], implementation: 'generated' });
  });
  it('accepts every kind with its required fields', () => {
    const ok = [
      { kind: 'entity', interface: iface },
      { kind: 'aggregate', interface: iface },
      { kind: 'collection', interface: iface, of: 'card' },
      { kind: 'store', interface: iface, persists: 'game' },
      { kind: 'endpoint', interface: iface, uses: ['game', 'game-store'] },
      { kind: 'auth', interface: iface },
      { kind: 'sync', when: 'game.players#join', then: ['game#deal'] },
    ];
    for (const input of ok) {
      expect(frontmatterSchema.safeParse(input).success).toBe(true);
    }
  });
  it('rejects unknown keys such as id', () => {
    expect(frontmatterSchema.safeParse({ kind: 'value', interface: iface, id: 'card' }).success).toBe(false);
  });
  it('requires kind-specific fields', () => {
    expect(frontmatterSchema.safeParse({ kind: 'collection', interface: iface }).success).toBe(false);
    expect(frontmatterSchema.safeParse({ kind: 'store', interface: iface }).success).toBe(false);
    expect(frontmatterSchema.safeParse({ kind: 'sync', when: 'game#deal', then: [] }).success).toBe(false);
  });
  it('requires interface except for syncs', () => {
    expect(frontmatterSchema.safeParse({ kind: 'value' }).success).toBe(false);
  });
  it('validates id and action formats', () => {
    expect(frontmatterSchema.safeParse({ kind: 'value', interface: iface, uses: ['Card'] }).success).toBe(false);
    expect(frontmatterSchema.safeParse({ kind: 'sync', when: 'game.deal', then: ['game#deal'] }).success).toBe(false);
  });
  it('ties handwritten to source', () => {
    const missing = frontmatterSchema.safeParse({ kind: 'value', interface: iface, implementation: 'handwritten' });
    expect(missing.success).toBe(false);
    const stray = frontmatterSchema.safeParse({ kind: 'value', interface: iface, source: 'handwritten/card.ts' });
    expect(stray.success).toBe(false);
    const ok = frontmatterSchema.safeParse({
      kind: 'value',
      interface: iface,
      implementation: 'handwritten',
      source: 'handwritten/card.ts',
    });
    expect(ok.success).toBe(true);
  });
});

describe('kind groups and section rules', () => {
  it('classifies kinds', () => {
    expect(isDomainKind('aggregate')).toBe(true);
    expect(isAdapterKind('aggregate')).toBe(false);
    expect(isAdapterKind('store')).toBe(true);
    expect(isDomainKind('sync')).toBe(false);
    expect(isAdapterKind('sync')).toBe(false);
  });
  it('requires Schema only for stores', () => {
    expect(sectionRule('store').required).toEqual(['Intent', 'Schema']);
    expect(sectionRule('value').required).toEqual(['Intent']);
    expect(sectionRule('value').allowed).not.toContain('Schema');
    expect(sectionRule('sync').recommended).toEqual(['Examples']);
  });
  it('reads uses for any kind', () => {
    expect(usesOf(frontmatterSchema.parse({ kind: 'sync', when: 'a#b', then: ['c#d'] }))).toEqual([]);
    expect(usesOf(frontmatterSchema.parse({ kind: 'value', interface: iface, uses: ['card'] }))).toEqual(['card']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run diagnostics schema`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement diagnostics**

`packages/cli/src/diagnostics.ts`:
```ts
export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  file: string;
  line?: number;
  message: string;
  hint?: string;
}

interface DiagnosticOptions {
  line?: number;
  hint?: string;
}

function make(severity: Severity, file: string, message: string, opts: DiagnosticOptions): Diagnostic {
  const d: Diagnostic = { severity, file, message };
  if (opts.line !== undefined) {
    d.line = opts.line;
  }
  if (opts.hint !== undefined) {
    d.hint = opts.hint;
  }
  return d;
}

export function error(file: string, message: string, opts: DiagnosticOptions = {}): Diagnostic {
  return make('error', file, message, opts);
}

export function warning(file: string, message: string, opts: DiagnosticOptions = {}): Diagnostic {
  return make('warning', file, message, opts);
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.message.localeCompare(b.message),
  );
}

export function formatDiagnostic(d: Diagnostic): string {
  const location = d.line === undefined ? d.file : `${d.file}:${d.line}`;
  const head = `${location}: ${d.severity}: ${d.message}`;
  return d.hint === undefined ? head : `${head}\n  hint: ${d.hint}`;
}
```

- [ ] **Step 4: Implement the schema**

`packages/cli/src/schema.ts`:
```ts
import { z } from 'zod';
import { ACTION_PATTERN, ID_PATTERN } from './ids.js';

export const DOMAIN_KINDS = ['value', 'entity', 'collection', 'aggregate'] as const;
export const ADAPTER_KINDS = ['store', 'endpoint', 'auth'] as const;
export const KINDS = [...DOMAIN_KINDS, ...ADAPTER_KINDS, 'sync'] as const;
export type Kind = (typeof KINDS)[number];

const conceptRef = z.string().regex(ID_PATTERN, 'must be a concept id like game.player.hand');
const actionRef = z.string().regex(ACTION_PATTERN, 'must be an action like game.players#join');

const common = {
  interface: z.string().trim().min(1, 'interface must declare at least one export'),
  uses: z.array(conceptRef).default([]),
  implementation: z.enum(['generated', 'handwritten']).default('generated'),
  source: z.string().min(1).optional(),
};

export const frontmatterSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('value'), ...common }),
    z.strictObject({ kind: z.literal('entity'), ...common }),
    z.strictObject({ kind: z.literal('collection'), of: conceptRef, ...common }),
    z.strictObject({ kind: z.literal('aggregate'), ...common }),
    z.strictObject({ kind: z.literal('store'), persists: conceptRef, ...common }),
    z.strictObject({ kind: z.literal('endpoint'), ...common }),
    z.strictObject({ kind: z.literal('auth'), ...common }),
    z.strictObject({ kind: z.literal('sync'), when: actionRef, then: z.array(actionRef).min(1) }),
  ])
  .superRefine((fm, ctx) => {
    if (fm.kind === 'sync') {
      return;
    }
    if (fm.implementation === 'handwritten' && fm.source === undefined) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'required when implementation is handwritten' });
    }
    if (fm.implementation === 'generated' && fm.source !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'only allowed when implementation is handwritten' });
    }
  });

export type Frontmatter = z.output<typeof frontmatterSchema>;

export function isDomainKind(kind: Kind): boolean {
  return (DOMAIN_KINDS as readonly string[]).includes(kind);
}

export function isAdapterKind(kind: Kind): boolean {
  return (ADAPTER_KINDS as readonly string[]).includes(kind);
}

export interface SectionRule {
  required: readonly string[];
  recommended: readonly string[];
  allowed: readonly string[];
}

const BASE_SECTIONS = ['Intent', 'Rules', 'Examples', 'Decisions'] as const;

export function sectionRule(kind: Kind): SectionRule {
  if (kind === 'store') {
    return { required: ['Intent', 'Schema'], recommended: ['Examples'], allowed: [...BASE_SECTIONS, 'Schema'] };
  }
  return { required: ['Intent'], recommended: ['Examples'], allowed: BASE_SECTIONS };
}

export function usesOf(fm: Frontmatter): readonly string[] {
  return fm.kind === 'sync' ? [] : fm.uses;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run diagnostics schema`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/diagnostics.ts packages/cli/src/schema.ts packages/cli/test/diagnostics.test.ts packages/cli/test/schema.test.ts
git commit -m "Add diagnostics and zod frontmatter schema with section rules"
```

---

### Task 4: Concept file parser

**Files:**
- Create: `packages/cli/src/parse.ts`
- Test: `packages/cli/test/parse.test.ts`

**Interfaces:**
- Consumes: `error`, `warning`, `Diagnostic` from `diagnostics.ts`; `frontmatterSchema`, `sectionRule`, `KINDS`, `Frontmatter`, `Kind` from `schema.ts`; `ConceptId` from `ids.ts`.
- Produces:
  - `interface Section { heading: string; line: number; lines: readonly string[]; body: string }` (`line` is the heading's 1-based file line; `lines` are the raw lines after the heading; `body` is them joined and trimmed)
  - `interface Concept { id: ConceptId; file: string; frontmatter: Frontmatter; sections: ReadonlyMap<string, Section>; examples: readonly string[] }`
  - `interface ParseResult { concept: Concept | null; diagnostics: Diagnostic[] }` (`concept` is null only when the frontmatter is unusable)
  - `parseConcept(id: ConceptId, file: string, text: string): ParseResult`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/parse.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseConcept } from '../src/parse.js';

const FILE = 'concepts/game/player/hand.md';

const VALID = `---
kind: collection
of: card
uses: [card]
interface: |
  export class Hand {
    add(card: Card): void;
  }
---
## Intent
The cards a player holds.

## Rules
- Never contains the same card twice.

## Examples
- given an empty hand, add(A♠) → size is 1
- given hand [A♠], add(A♠)
  → throws DuplicateCard

## Decisions
- Unordered.
`;

function messages(text: string): string[] {
  return parseConcept('game.player.hand', FILE, text).diagnostics.map((d) => `${d.severity}: ${d.message}`);
}

describe('parseConcept', () => {
  it('parses a valid concept', () => {
    const { concept, diagnostics } = parseConcept('game.player.hand', FILE, VALID);
    expect(diagnostics).toEqual([]);
    expect(concept?.frontmatter.kind).toBe('collection');
    expect([...(concept?.sections.keys() ?? [])]).toEqual(['Intent', 'Rules', 'Examples', 'Decisions']);
    expect(concept?.sections.get('Intent')?.body).toBe('The cards a player holds.');
    expect(concept?.sections.get('Intent')?.line).toBe(10);
    expect(concept?.examples).toEqual([
      'given an empty hand, add(A♠) → size is 1',
      'given hand [A♠], add(A♠) → throws DuplicateCard',
    ]);
  });

  it('parses CRLF line endings and a BOM identically', () => {
    const crlf = `﻿${VALID.replace(/\n/g, '\r\n')}`;
    const a = parseConcept('game.player.hand', FILE, VALID);
    const b = parseConcept('game.player.hand', FILE, crlf);
    expect(b.diagnostics).toEqual([]);
    expect(b.concept?.examples).toEqual(a.concept?.examples);
    expect(b.concept?.frontmatter).toEqual(a.concept?.frontmatter);
  });

  it('ignores ## lines inside code fences', () => {
    const text = VALID.replace(
      '## Decisions\n- Unordered.\n',
      '## Decisions\n- Unordered.\n\n```md\n## Rules\nnot a heading\n```\n',
    );
    const { concept, diagnostics } = parseConcept('game.player.hand', FILE, text);
    expect(diagnostics).toEqual([]);
    expect(concept?.sections.get('Decisions')?.body).toContain('## Rules');
  });

  it('reports missing, unterminated, empty, and malformed frontmatter', () => {
    expect(messages('## Intent\nx\n')).toEqual(["error: missing frontmatter: file must start with a '---' line"]);
    expect(messages('---\nkind: value\n')).toEqual(["error: unterminated frontmatter: no closing '---' line"]);
    expect(messages('---\n---\n## Intent\nx\n')).toEqual(['error: frontmatter must be a YAML mapping of fields']);
    const bad = parseConcept('card', 'concepts/card.md', '---\nkind: [value\n---\n');
    expect(bad.concept).toBeNull();
    expect(bad.diagnostics[0]?.severity).toBe('error');
    expect(bad.diagnostics[0]?.message).toMatch(/^frontmatter: /);
    expect(bad.diagnostics[0]?.line).toBeGreaterThanOrEqual(2);
  });

  it('explains an unknown kind', () => {
    expect(messages('---\nkind: widget\ninterface: x\n---\n## Intent\nx\n')).toEqual([
      'error: frontmatter kind: must be one of value, entity, collection, aggregate, store, endpoint, auth, sync',
    ]);
  });

  it('reports schema violations with the field path', () => {
    expect(messages('---\nkind: collection\ninterface: x\n---\n## Intent\nx\n## Examples\n- a\n')).toContainEqual(
      expect.stringMatching(/^error: frontmatter of: /),
    );
  });

  it('reports unknown, duplicate, missing, and stray-text sections', () => {
    const text = `---
kind: value
interface: export type A = string;
---
stray text
## Example
- oops
## Rules
- a
## Rules
- b
`;
    const { diagnostics } = parseConcept('card', 'concepts/card.md', text);
    const found = diagnostics.map((d) => `${d.severity}:${d.line ?? 0}: ${d.message}`);
    expect(found).toEqual([
      'error:5: text before the first ## section is not part of any section',
      "error:10: duplicate section '## Rules'",
      "error:6: unknown section '## Example'",
      "error:1: missing required section '## Intent'",
      "warning:1: missing '## Examples' section; ccc build requires it",
    ]);
    expect(diagnostics.find((d) => d.message.startsWith('unknown section'))?.hint).toBe(
      "allowed sections for kind 'value': Intent, Rules, Examples, Decisions",
    );
  });

  it('requires Examples to be a bulleted list', () => {
    const text = VALID.replace('- given an empty hand, add(A♠) → size is 1', 'given an empty hand');
    const d = parseConcept('game.player.hand', FILE, text).diagnostics;
    expect(d.map((x) => x.message)).toEqual(['Examples must be a bulleted list (one "- " bullet per example)']);
    expect(d[0]?.line).toBe(17);
  });

  it('warns on an empty Examples section and errors on an empty required section', () => {
    const text = '---\nkind: value\ninterface: export type A = string;\n---\n## Intent\n\n## Examples\n';
    expect(messages(text)).toEqual([
      "error: section '## Intent' is empty",
      "warning: '## Examples' has no examples; ccc build requires at least one",
    ]);
  });

  it('reports an unclosed code fence', () => {
    const text = '---\nkind: value\ninterface: export type A = string;\n---\n## Intent\nx\n```ts\nconst a = 1;\n## Examples\n';
    expect(messages(text)).toContain('error: unclosed code fence ```');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run parse`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/parse.ts`:
```ts
import { parseDocument } from 'yaml';
import { error, warning, type Diagnostic } from './diagnostics.js';
import type { ConceptId } from './ids.js';
import { KINDS, frontmatterSchema, sectionRule, type Frontmatter } from './schema.js';

export interface Section {
  heading: string;
  line: number;
  lines: readonly string[];
  body: string;
}

export interface Concept {
  id: ConceptId;
  file: string;
  frontmatter: Frontmatter;
  sections: ReadonlyMap<string, Section>;
  examples: readonly string[];
}

export interface ParseResult {
  concept: Concept | null;
  diagnostics: Diagnostic[];
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^## (.+?)\s*$/;
const BULLET = /^[-*] (.*)$/;
const CONTINUATION = /^\s{2,}\S/;

export function parseConcept(id: ConceptId, file: string, text: string): ParseResult {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') {
    return { concept: null, diagnostics: [error(file, "missing frontmatter: file must start with a '---' line", { line: 1 })] };
  }
  const close = lines.indexOf('---', 1);
  if (close === -1) {
    return { concept: null, diagnostics: [error(file, "unterminated frontmatter: no closing '---' line", { line: 1 })] };
  }
  const fm = parseFrontmatter(file, lines.slice(1, close).join('\n'));
  if (!fm.ok) {
    return { concept: null, diagnostics: fm.diagnostics };
  }
  const diagnostics: Diagnostic[] = [];
  const sections = splitSections(file, lines, close + 1, diagnostics);
  checkSections(file, fm.value, sections, diagnostics);
  const examplesSection = sections.get('Examples');
  const examples = examplesSection === undefined ? [] : parseExamples(file, examplesSection, diagnostics);
  if (examplesSection !== undefined && examples.length === 0 && examplesSection.body === '') {
    diagnostics.push(warning(file, "'## Examples' has no examples; ccc build requires at least one", { line: examplesSection.line }));
  }
  return { concept: { id, file, frontmatter: fm.value, sections, examples }, diagnostics };
}

type FrontmatterResult = { ok: true; value: Frontmatter } | { ok: false; diagnostics: Diagnostic[] };

function parseFrontmatter(file: string, source: string): FrontmatterResult {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      diagnostics: doc.errors.map((e) =>
        error(file, `frontmatter: ${e.message.split('\n')[0] ?? e.message}`, { line: (e.linePos?.[0].line ?? 0) + 1 }),
      ),
    };
  }
  const data = doc.toJS();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, diagnostics: [error(file, 'frontmatter must be a YAML mapping of fields', { line: 1 })] };
  }
  if (!(KINDS as readonly string[]).includes(data.kind)) {
    return { ok: false, diagnostics: [error(file, `frontmatter kind: must be one of ${KINDS.join(', ')}`, { line: 1 })] };
  }
  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => {
        const where = issue.path.length > 0 ? ` ${issue.path.map(String).join('.')}` : '';
        return error(file, `frontmatter${where}: ${issue.message}`, { line: 1 });
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

interface OpenSection {
  heading: string;
  line: number;
  lines: string[];
}

function splitSections(file: string, lines: readonly string[], start: number, diagnostics: Diagnostic[]): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: OpenSection | null = null;
  let fence: string | null = null;
  let reportedStray = false;
  const flush = (): void => {
    if (current !== null && !sections.has(current.heading)) {
      sections.set(current.heading, {
        heading: current.heading,
        line: current.line,
        lines: current.lines,
        body: current.lines.join('\n').trim(),
      });
    }
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? '';
      if (fence === null) {
        fence = marker;
      } else if (marker === fence) {
        fence = null;
      }
    }
    const heading = fence === null && fenceMatch === null ? HEADING.exec(line) : null;
    if (heading !== null) {
      flush();
      const name = heading[1] ?? '';
      if (sections.has(name)) {
        diagnostics.push(error(file, `duplicate section '## ${name}'`, { line: lineNo }));
      }
      current = { heading: name, line: lineNo, lines: [] };
      continue;
    }
    if (current !== null) {
      current.lines.push(line);
    } else if (line.trim() !== '' && !reportedStray) {
      reportedStray = true;
      diagnostics.push(
        error(file, 'text before the first ## section is not part of any section', {
          line: lineNo,
          hint: 'move it under ## Intent or delete it',
        }),
      );
    }
  }
  flush();
  if (fence !== null) {
    diagnostics.push(error(file, `unclosed code fence ${fence}`));
  }
  return sections;
}

function checkSections(file: string, fm: Frontmatter, sections: ReadonlyMap<string, Section>, diagnostics: Diagnostic[]): void {
  const rule = sectionRule(fm.kind);
  for (const section of sections.values()) {
    if (!rule.allowed.includes(section.heading)) {
      diagnostics.push(
        error(file, `unknown section '## ${section.heading}'`, {
          line: section.line,
          hint: `allowed sections for kind '${fm.kind}': ${rule.allowed.join(', ')}`,
        }),
      );
    }
  }
  for (const name of rule.required) {
    const section = sections.get(name);
    if (section === undefined) {
      diagnostics.push(error(file, `missing required section '## ${name}'`, { line: 1 }));
    } else if (section.body === '') {
      diagnostics.push(error(file, `section '## ${name}' is empty`, { line: section.line }));
    }
  }
  for (const name of rule.recommended) {
    if (!sections.has(name)) {
      diagnostics.push(warning(file, `missing '## ${name}' section; ccc build requires it`, { line: 1 }));
    }
  }
}

function parseExamples(file: string, section: Section, diagnostics: Diagnostic[]): string[] {
  const examples: string[] = [];
  section.lines.forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      examples.push((bullet[1] ?? '').trim());
      return;
    }
    if (CONTINUATION.test(line) && examples.length > 0) {
      const last = examples.pop();
      examples.push(`${last} ${line.trim()}`);
      return;
    }
    diagnostics.push(
      error(file, 'Examples must be a bulleted list (one "- " bullet per example)', { line: section.line + 1 + index }),
    );
  });
  return examples;
}
```

Note on the `data.kind` check: `doc.toJS()` is typed by the `yaml` package, and the code checks `kind` before zod runs so an unknown kind gets a clear message listing the valid kinds. Don't annotate `data`; zod validates it on the next line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run parse`
Expected: PASS. If the diagnostic order in the "unknown, duplicate, missing" test differs, the implementation diverged from the step order above (split → section checks → examples). Fix the code, not the test.

- [ ] **Step 5: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/parse.ts packages/cli/test/parse.test.ts
git commit -m "Parse concept files: frontmatter, sections, examples"
```

---

### Task 5: Project loader

**Files:**
- Create: `packages/cli/src/load.ts`
- Create: `packages/cli/test/helpers.ts`
- Test: `packages/cli/test/load.test.ts`

**Interfaces:**
- Consumes: `parseConcept`, `Concept` (Task 4); `isValidSegment`, `pathToId`, `idToPath`, `parentOf`, `ConceptId` (Task 2); `error`, `warning`, `Diagnostic` (Task 3).
- Produces:
  - `interface Project { root: string; concepts: ReadonlyMap<ConceptId, Concept> }`
  - `interface LoadResult { project: Project; diagnostics: Diagnostic[] }`
  - `loadProject(root: string): Promise<LoadResult>`
  - Test helpers (in `test/helpers.ts`): `writeProject(files: Record<string, string>): Promise<string>` (writes to a new temp dir, returns its path); `projectFrom(files: Record<string, string>): Project` (parses in memory, keys are paths under `concepts/`, throws if any parse *error* occurs); `concept(frontmatter: string, body?: string): string` (builds file text)

- [ ] **Step 1: Write the helpers**

`packages/cli/test/helpers.ts`:
```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasErrors, formatDiagnostic } from '../src/diagnostics.js';
import { pathToId } from '../src/ids.js';
import type { Project } from '../src/load.js';
import { parseConcept, type Concept } from '../src/parse.js';

export const DEFAULT_BODY = '## Intent\nTest concept.\n\n## Examples\n- example one\n';

export function concept(frontmatter: string, body: string = DEFAULT_BODY): string {
  return `---\n${frontmatter.trim()}\n---\n${body}`;
}

export async function writeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ccc-test-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  return root;
}

export function projectFrom(files: Record<string, string>): Project {
  const concepts = new Map<string, Concept>();
  for (const [rel, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const id = pathToId(rel);
    const result = parseConcept(id, `concepts/${rel}`, text);
    if (result.concept === null || hasErrors(result.diagnostics)) {
      throw new Error(`fixture ${rel} failed to parse:\n${result.diagnostics.map(formatDiagnostic).join('\n')}`);
    }
    concepts.set(id, result.concept);
  }
  return { root: '/virtual', concepts };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/load.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadProject } from '../src/load.js';
import { concept, writeProject } from './helpers.js';

const VALUE = concept('kind: value\ninterface: export type A = string;');

describe('loadProject', () => {
  it('loads nested concepts with path-derived ids', async () => {
    const root = await writeProject({
      'concepts/card.md': VALUE,
      'concepts/game.md': concept('kind: aggregate\ninterface: export class Game {}'),
      'concepts/game/deck.md': VALUE,
    });
    const { project, diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([]);
    expect([...project.concepts.keys()]).toEqual(['card', 'game', 'game.deck']);
    expect(project.concepts.get('game.deck')?.file).toBe('concepts/game/deck.md');
  });

  it('ignores dotfiles silently and warns about other non-markdown files', async () => {
    const root = await writeProject({
      'concepts/card.md': VALUE,
      'concepts/.DS_Store': 'binary',
      'concepts/notes.txt': 'scratch',
    });
    const { project, diagnostics } = await loadProject(root);
    expect([...project.concepts.keys()]).toEqual(['card']);
    expect(diagnostics.map((d) => `${d.severity} ${d.file}: ${d.message}`)).toEqual([
      'warning concepts/notes.txt: ignored: not a .md concept file',
    ]);
  });

  it('rejects names that are not kebab-case', async () => {
    const root = await writeProject({ 'concepts/Game_Store.md': VALUE });
    const { project, diagnostics } = await loadProject(root);
    expect(project.concepts.size).toBe(0);
    expect(diagnostics[0]?.message).toBe("invalid name 'Game_Store': use lowercase kebab-case (e.g. game-store)");
  });

  it('reports a directory with no parent concept file', async () => {
    const root = await writeProject({ 'concepts/game/hand.md': VALUE });
    const { diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        file: 'concepts/game/hand.md',
        message: 'no parent concept: expected concepts/game.md',
        hint: 'files in concepts/game/ are contained by concept game; create its concept file',
      },
    ]);
  });

  it('does not report a missing parent when the parent file exists but fails to parse', async () => {
    const root = await writeProject({ 'concepts/game.md': 'no frontmatter', 'concepts/game/hand.md': VALUE });
    const { project, diagnostics } = await loadProject(root);
    expect([...project.concepts.keys()]).toEqual(['game.hand']);
    expect(diagnostics.map((d) => d.file)).toEqual(['concepts/game.md']);
  });

  it('reports a missing concepts directory', async () => {
    const root = await writeProject({ 'README.md': '# hi' });
    const { diagnostics } = await loadProject(root);
    expect(diagnostics[0]?.message).toMatch(/^no concepts\/ directory in /);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run load`
Expected: FAIL, `../src/load.js` not found.

- [ ] **Step 4: Implement**

`packages/cli/src/load.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { error, warning, type Diagnostic } from './diagnostics.js';
import { idToPath, isValidSegment, parentOf, pathToId, type ConceptId } from './ids.js';
import { parseConcept, type Concept } from './parse.js';

export interface Project {
  root: string;
  concepts: ReadonlyMap<ConceptId, Concept>;
}

export interface LoadResult {
  project: Project;
  diagnostics: Diagnostic[];
}

interface Candidate {
  id: ConceptId;
  file: string;
  full: string;
}

async function listFiles(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
  } catch {
    return null;
  }
}

export async function loadProject(root: string): Promise<LoadResult> {
  const conceptsDir = path.join(root, 'concepts');
  const files = await listFiles(conceptsDir);
  if (files === null) {
    return { project: { root, concepts: new Map() }, diagnostics: [error('concepts/', `no concepts/ directory in ${root}`)] };
  }
  const diagnostics: Diagnostic[] = [];
  const candidates: Candidate[] = [];
  const knownIds = new Set<ConceptId>();
  for (const rel of files) {
    const segments = rel.split('/');
    if (segments.some((segment) => segment.startsWith('.'))) {
      continue;
    }
    const file = `concepts/${rel}`;
    if (!rel.endsWith('.md')) {
      diagnostics.push(warning(file, 'ignored: not a .md concept file'));
      continue;
    }
    const names = [...segments.slice(0, -1), (segments.at(-1) ?? '').slice(0, -'.md'.length)];
    const bad = names.find((name) => !isValidSegment(name));
    if (bad !== undefined) {
      diagnostics.push(error(file, `invalid name '${bad}': use lowercase kebab-case (e.g. game-store)`));
      continue;
    }
    const id = pathToId(rel);
    knownIds.add(id);
    candidates.push({ id, file, full: path.join(conceptsDir, rel) });
  }
  const texts = await Promise.all(candidates.map((candidate) => readFile(candidate.full, 'utf8')));
  const concepts = new Map<ConceptId, Concept>();
  candidates.forEach((candidate, index) => {
    const result = parseConcept(candidate.id, candidate.file, texts[index] ?? '');
    diagnostics.push(...result.diagnostics);
    if (result.concept !== null) {
      concepts.set(candidate.id, result.concept);
    }
  });
  for (const candidate of candidates) {
    const parent = parentOf(candidate.id);
    if (parent !== null && !knownIds.has(parent)) {
      const parentFile = idToPath(parent);
      diagnostics.push(
        error(candidate.file, `no parent concept: expected concepts/${parentFile}`, {
          hint: `files in concepts/${parentFile.slice(0, -'.md'.length)}/ are contained by concept ${parent}; create its concept file`,
        }),
      );
    }
  }
  return { project: { root, concepts }, diagnostics };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run load`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/load.ts packages/cli/test/load.test.ts packages/cli/test/helpers.ts
git commit -m "Load concept projects from disk with name and parent checks"
```

---

### Task 6: Reference graph and dependency cycles

**Files:**
- Create: `packages/cli/src/cycles.ts`, `packages/cli/src/graph.ts`
- Test: `packages/cli/test/cycles.test.ts`, `packages/cli/test/graph.test.ts`

**Interfaces:**
- Consumes: `Project` (Task 5); `Concept` (Task 4); `isVisible`, `parentOf`, `parseActionRef`, `ConceptId` (Task 2); `isDomainKind`, `isAdapterKind` (Task 3); `error`, `Diagnostic` (Task 3). Test helpers `projectFrom`, `concept` (Task 5).
- Produces:
  - `cycles.ts`: `findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][]` (each cycle is a path that starts and ends on the same node, e.g. `['a', 'b', 'a']`; deterministic order)
  - `graph.ts`: `type ReferenceField = 'uses' | 'of' | 'persists' | 'child' | 'when' | 'then'`; `interface Reference { from: ConceptId; to: ConceptId; field: ReferenceField }`; `childrenOf(project: Project, id: ConceptId): Concept[]`; `referencesOf(concept: Concept, project: Project): Reference[]`; `dependenciesOf(concept: Concept, project: Project): ConceptId[]` (unique, sorted, only targets that exist); `checkReferences(project: Project): Diagnostic[]`; `checkDependencyCycles(project: Project): Diagnostic[]`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/cycles.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { findCycles } from '../src/cycles.js';

describe('findCycles', () => {
  it('returns nothing for a DAG', () => {
    expect(findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', []]]))).toEqual([]);
  });
  it('finds a self-loop', () => {
    expect(findCycles(new Map([['a', ['a']]]))).toEqual([['a', 'a']]);
  });
  it('finds a longer cycle as a closed path', () => {
    expect(findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual([['a', 'b', 'c', 'a']]);
  });
  it('handles edges to nodes that are not keys', () => {
    expect(findCycles(new Map([['a', ['missing']]]))).toEqual([]);
  });
});
```

`packages/cli/test/graph.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { checkDependencyCycles, checkReferences, dependenciesOf, referencesOf } from '../src/graph.js';
import { concept, projectFrom } from './helpers.js';

const value = (extra = ''): string => concept(`kind: value\ninterface: export type A = string;\n${extra}`);
const aggregate = (extra = ''): string => concept(`kind: aggregate\ninterface: export class Game {}\n${extra}`);
const store = (persists: string): string =>
  concept(
    `kind: store\npersists: ${persists}\ninterface: export class GameStore {}`,
    '## Intent\nx\n\n## Schema\n```sql\ncreate table games (id text);\n```\n\n## Examples\n- a\n',
  );
const sync = (when: string, then: string): string => concept(`kind: sync\nwhen: ${when}\nthen: [${then}]`);

function messages(files: Record<string, string>): string[] {
  const project = projectFrom(files);
  return [...checkReferences(project), ...checkDependencyCycles(project)].map((d) => `${d.file}: ${d.message}`);
}

describe('referencesOf / dependenciesOf', () => {
  it('collects uses, of, persists, and aggregate children (excluding syncs)', () => {
    const project = projectFrom({
      'card.md': value(),
      'game.md': aggregate('uses: [card]'),
      'game/deck.md': concept('kind: collection\nof: card\nuses: [card]\ninterface: export class Deck {}'),
      'game/deal.md': sync('game.deck#draw', 'game#deal'),
      'game-store.md': store('game'),
    });
    const game = project.concepts.get('game');
    const deck = project.concepts.get('game.deck');
    const gameStore = project.concepts.get('game-store');
    if (!game || !deck || !gameStore) throw new Error('fixture');
    expect(referencesOf(game, project).map((r) => `${r.field}:${r.to}`)).toEqual(['uses:card', 'child:game.deck']);
    expect(dependenciesOf(deck, project)).toEqual(['card']);
    expect(dependenciesOf(gameStore, project)).toEqual(['game']);
  });
});

describe('checkReferences', () => {
  it('accepts a valid graph', () => {
    expect(
      messages({ 'card.md': value(), 'game.md': aggregate('uses: [card]'), 'game/deck.md': value('uses: [card]') }),
    ).toEqual([]);
  });
  it('reports unknown concepts and self references', () => {
    expect(messages({ 'card.md': value('uses: [card, nope]') })).toEqual([
      'concepts/card.md: uses refers to itself',
      "concepts/card.md: unknown concept 'nope' in uses",
    ]);
  });
  it('reports references to private concepts with a hint', () => {
    const project = projectFrom({
      'game.md': aggregate(),
      'game/player.md': value(),
      'game/player/hand.md': value(),
      'lobby.md': value('uses: [game.player.hand]'),
    });
    const [d] = checkReferences(project);
    expect(d?.message).toBe("'game.player.hand' is not visible from 'lobby'");
    expect(d?.hint).toBe('game.player.hand is private to game.player; reference game.player instead, or move game.player.hand up a level');
  });
  it('forbids domain concepts depending on adapters', () => {
    expect(messages({ 'game.md': aggregate('uses: [game-store]'), 'game-store.md': store('game') })).toContain(
      "concepts/game.md: domain concept 'game' (aggregate) cannot depend on adapter 'game-store' (store)",
    );
  });
  it('forbids referencing syncs and persisting non-aggregates', () => {
    const found = messages({
      'card.md': value('uses: [deal]'),
      'deal.md': sync('card#a', 'card#b'),
      'card-store.md': store('card'),
    });
    expect(found).toContain("concepts/card.md: 'deal' is a sync; syncs cannot be referenced");
    expect(found).toContain("concepts/card-store.md: persists must reference an aggregate; 'card' is a value");
  });
});

describe('checkDependencyCycles', () => {
  it('reports a cycle once, on the first concept in it', () => {
    expect(messages({ 'a.md': value('uses: [b]'), 'b.md': value('uses: [a]') })).toEqual([
      'concepts/a.md: dependency cycle: a → b → a',
    ]);
  });
  it('does not treat a sync inside an aggregate as a dependency', () => {
    expect(
      messages({
        'game.md': aggregate(),
        'game/players.md': concept('kind: collection\nof: game.player\ninterface: |\n  export class Players {\n    join(): void;\n  }'),
        'game/player.md': value(),
        'game/deal-on-full-table.md': sync('game.players#join', 'game#deal'),
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run cycles graph`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement cycle detection**

`packages/cli/src/cycles.ts`:
```ts
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export function findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const node of [...edges.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      visit(node);
    }
  }
  return cycles;
}
```

- [ ] **Step 4: Implement graph rules**

`packages/cli/src/graph.ts`:
```ts
import { findCycles } from './cycles.js';
import { error, type Diagnostic } from './diagnostics.js';
import { isVisible, parentOf, parseActionRef, type ConceptId } from './ids.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { isAdapterKind, isDomainKind } from './schema.js';

export type ReferenceField = 'uses' | 'of' | 'persists' | 'child' | 'when' | 'then';

export interface Reference {
  from: ConceptId;
  to: ConceptId;
  field: ReferenceField;
}

export function childrenOf(project: Project, id: ConceptId): Concept[] {
  return [...project.concepts.values()].filter((candidate) => parentOf(candidate.id) === id);
}

export function referencesOf(concept: Concept, project: Project): Reference[] {
  const fm = concept.frontmatter;
  const refs: Reference[] = [];
  const add = (to: ConceptId, field: ReferenceField): void => {
    refs.push({ from: concept.id, to, field });
  };
  if (fm.kind === 'sync') {
    add(parseActionRef(fm.when).conceptId, 'when');
    for (const target of fm.then) {
      add(parseActionRef(target).conceptId, 'then');
    }
    return refs;
  }
  for (const used of fm.uses) {
    add(used, 'uses');
  }
  if (fm.kind === 'collection') {
    add(fm.of, 'of');
  }
  if (fm.kind === 'store') {
    add(fm.persists, 'persists');
  }
  if (fm.kind === 'aggregate') {
    for (const child of childrenOf(project, concept.id)) {
      if (child.frontmatter.kind !== 'sync') {
        add(child.id, 'child');
      }
    }
  }
  return refs;
}

export function dependenciesOf(concept: Concept, project: Project): ConceptId[] {
  const ids = referencesOf(concept, project)
    .map((ref) => ref.to)
    .filter((to) => to !== concept.id && project.concepts.has(to));
  return [...new Set(ids)].sort();
}

export function checkReferences(project: Project): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const concept of project.concepts.values()) {
    for (const ref of referencesOf(concept, project)) {
      const target = project.concepts.get(ref.to);
      const fromKind = concept.frontmatter.kind;
      if (ref.to === ref.from) {
        diagnostics.push(error(concept.file, `${ref.field} refers to itself`, { line: 1 }));
      } else if (target === undefined) {
        diagnostics.push(error(concept.file, `unknown concept '${ref.to}' in ${ref.field}`, { line: 1 }));
      } else if (ref.field !== 'child' && !isVisible(ref.from, ref.to)) {
        const owner = parentOf(ref.to) ?? ref.to;
        diagnostics.push(
          error(concept.file, `'${ref.to}' is not visible from '${ref.from}'`, {
            line: 1,
            hint: `${ref.to} is private to ${owner}; reference ${owner} instead, or move ${ref.to} up a level`,
          }),
        );
      } else if (target.frontmatter.kind === 'sync') {
        diagnostics.push(error(concept.file, `'${ref.to}' is a sync; syncs cannot be referenced`, { line: 1 }));
      } else if (isDomainKind(fromKind) && isAdapterKind(target.frontmatter.kind)) {
        diagnostics.push(
          error(
            concept.file,
            `domain concept '${ref.from}' (${fromKind}) cannot depend on adapter '${ref.to}' (${target.frontmatter.kind})`,
            { line: 1, hint: 'connect them with a sync, or move the dependency into an adapter' },
          ),
        );
      } else if (ref.field === 'persists' && target.frontmatter.kind !== 'aggregate') {
        diagnostics.push(
          error(concept.file, `persists must reference an aggregate; '${ref.to}' is a ${target.frontmatter.kind}`, {
            line: 1,
          }),
        );
      }
    }
  }
  return diagnostics;
}

export function checkDependencyCycles(project: Project): Diagnostic[] {
  const edges = new Map<string, readonly string[]>();
  for (const concept of project.concepts.values()) {
    edges.set(concept.id, dependenciesOf(concept, project));
  }
  return findCycles(edges).map((cycle) => {
    const first = project.concepts.get(cycle[0] ?? '');
    return error(first?.file ?? 'concepts/', `dependency cycle: ${cycle.join(' → ')}`, { line: 1 });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run cycles graph`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/cycles.ts packages/cli/src/graph.ts packages/cli/test/cycles.test.ts packages/cli/test/graph.test.ts
git commit -m "Check references, visibility, kind rules, and dependency cycles"
```

---

### Task 7: Interface exports and `.d.ts` emission

**Files:**
- Create: `packages/cli/src/interfaces.ts`
- Test: `packages/cli/test/interfaces.test.ts`

**Interfaces:**
- Consumes: `Project` (Task 5); `dependenciesOf` (Task 6); `ConceptId` (Task 2); `error`, `Diagnostic` (Task 3).
- Produces:
  - `interface ExportInfo { names: readonly string[]; functions: readonly string[]; classMethods: ReadonlyMap<string, readonly string[]> }`
  - `exportsOf(source: string): ExportInfo`
  - `collectExports(project: Project): Map<ConceptId, ExportInfo>` (every non-sync concept)
  - `interfacePath(id: ConceptId): string`: `'game.player.hand'` → `'game/player/hand.d.ts'`
  - `relativeImport(from: ConceptId, to: ConceptId): string`: e.g. `'../../card.js'`
  - `interface EmittedInterface { id: ConceptId; conceptFile: string; path: string; content: string; headerLines: number }`
  - `interface EmitResult { files: EmittedInterface[]; diagnostics: Diagnostic[] }`
  - `emitInterfaces(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): EmitResult`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/interfaces.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { collectExports, emitInterfaces, exportsOf, interfacePath, relativeImport } from '../src/interfaces.js';
import { concept, projectFrom } from './helpers.js';

describe('exportsOf', () => {
  it('lists exported names, functions, and class methods', () => {
    const info = exportsOf(`
export class Hand {
  constructor(cards?: readonly string[]);
  add(card: string): void;
  size(): number;
  readonly label: string;
}
export class DuplicateCard extends Error {}
export function deal(): void;
export function deal(count: number): void;
export interface Card { rank: string }
export type Suit = 'S' | 'H';
export enum Color { Red, Black }
export const MAX: number;
class Hidden {}
function hidden(): void;
`);
    expect(info.names).toEqual(['Hand', 'DuplicateCard', 'deal', 'Card', 'Suit', 'Color', 'MAX']);
    expect(info.functions).toEqual(['deal']);
    expect(info.classMethods.get('Hand')).toEqual(['add', 'size']);
    expect(info.classMethods.get('DuplicateCard')).toEqual([]);
  });
});

describe('paths', () => {
  it('maps ids to d.ts paths and relative imports', () => {
    expect(interfacePath('game.player.hand')).toBe('game/player/hand.d.ts');
    expect(relativeImport('game.player.hand', 'card')).toBe('../../card.js');
    expect(relativeImport('game', 'game.player')).toBe('./game/player.js');
    expect(relativeImport('game.deck', 'game.player')).toBe('./player.js');
  });
});

const CARD = concept('kind: value\ninterface: |\n  export interface Card { readonly rank: string }\n  export function card(rank: string): Card;');

describe('emitInterfaces', () => {
  it('emits a header, imports from dependencies, then the interface', () => {
    const project = projectFrom({
      'card.md': CARD,
      'game.md': concept('kind: aggregate\ninterface: export class Game {}'),
      'game/hand.md': concept(
        'kind: collection\nof: card\ninterface: |\n  export class Hand {\n    add(card: Card): void;\n  }',
      ),
    });
    const { files, diagnostics } = emitInterfaces(project, collectExports(project));
    expect(diagnostics).toEqual([]);
    const hand = files.find((f) => f.id === 'game.hand');
    expect(hand?.path).toBe('game/hand.d.ts');
    expect(hand?.conceptFile).toBe('concepts/game/hand.md');
    expect(hand?.headerLines).toBe(2);
    expect(hand?.content).toBe(
      [
        '// @generated by ccc from concept game.hand. Do not edit.',
        "import { Card, card } from '../card.js';",
        'export class Hand {',
        '  add(card: Card): void;',
        '}',
        '',
      ].join('\n'),
    );
    const game = files.find((f) => f.id === 'game');
    expect(game?.content).toContain("import { Hand } from './game/hand.js';");
  });

  it('skips syncs and dependencies with no exports', () => {
    const project = projectFrom({
      'card.md': CARD,
      'deal.md': concept('kind: sync\nwhen: card#card\nthen: [card#card]'),
    });
    const { files } = emitInterfaces(project, collectExports(project));
    expect(files.map((f) => f.id)).toEqual(['card']);
  });

  it('reports export name collisions', () => {
    const project = projectFrom({
      'a.md': concept('kind: value\ninterface: export type Id = string;'),
      'b.md': concept('kind: value\ninterface: export type Id = number;'),
      'c.md': concept('kind: value\nuses: [a, b]\ninterface: export type C = Id;'),
      'd.md': concept('kind: value\nuses: [a]\ninterface: export type Id = boolean;'),
    });
    const { diagnostics } = emitInterfaces(project, collectExports(project));
    expect(diagnostics.map((d) => `${d.file}: ${d.message}`)).toEqual([
      "concepts/c.md: 'Id' is exported by both dependencies a and b",
      "concepts/d.md: 'Id' is exported by both d and its dependency a",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run interfaces`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/interfaces.ts`:
```ts
import path from 'node:path';
import ts from '@typescript/typescript6';
import { error, type Diagnostic } from './diagnostics.js';
import { dependenciesOf } from './graph.js';
import type { ConceptId } from './ids.js';
import type { Project } from './load.js';

export interface ExportInfo {
  names: readonly string[];
  functions: readonly string[];
  classMethods: ReadonlyMap<string, readonly string[]>;
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

// Reads declarations with the TS 6 API (TS 7 has no stable API yet; spec §7.5).
export function exportsOf(source: string): ExportInfo {
  const file = ts.createSourceFile('interface.d.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const functions: string[] = [];
  const classMethods = new Map<string, readonly string[]>();
  for (const statement of file.statements) {
    if (!isExported(statement)) {
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      const methods = statement.members
        .filter(ts.isMethodDeclaration)
        .map((method) => method.name)
        .filter(ts.isIdentifier)
        .map((name) => name.text);
      names.push(statement.name.text);
      classMethods.set(statement.name.text, [...new Set(methods)]);
    } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      names.push(statement.name.text);
      functions.push(statement.name.text);
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    }
  }
  return { names: [...new Set(names)], functions: [...new Set(functions)], classMethods };
}

export function collectExports(project: Project): Map<ConceptId, ExportInfo> {
  const result = new Map<ConceptId, ExportInfo>();
  for (const concept of project.concepts.values()) {
    if (concept.frontmatter.kind !== 'sync') {
      result.set(concept.id, exportsOf(concept.frontmatter.interface));
    }
  }
  return result;
}

export function interfacePath(id: ConceptId): string {
  return `${id.split('.').join('/')}.d.ts`;
}

export function relativeImport(from: ConceptId, to: ConceptId): string {
  const rel = path.posix
    .relative(path.posix.dirname(interfacePath(from)), interfacePath(to))
    .replace(/\.d\.ts$/, '.js');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export interface EmittedInterface {
  id: ConceptId;
  conceptFile: string;
  path: string;
  content: string;
  headerLines: number;
}

export interface EmitResult {
  files: EmittedInterface[];
  diagnostics: Diagnostic[];
}

export function emitInterfaces(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): EmitResult {
  const files: EmittedInterface[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const concept of project.concepts.values()) {
    const fm = concept.frontmatter;
    const own = exportsByConcept.get(concept.id);
    if (fm.kind === 'sync' || own === undefined) {
      continue;
    }
    const ownNames = new Set(own.names);
    const importedFrom = new Map<string, ConceptId>();
    const importLines: string[] = [];
    for (const dep of dependenciesOf(concept, project)) {
      const depInfo = exportsByConcept.get(dep);
      if (depInfo === undefined || depInfo.names.length === 0) {
        continue;
      }
      const names: string[] = [];
      for (const name of depInfo.names) {
        const previous = importedFrom.get(name);
        if (ownNames.has(name)) {
          diagnostics.push(error(concept.file, `'${name}' is exported by both ${concept.id} and its dependency ${dep}`, { line: 1 }));
        } else if (previous !== undefined) {
          diagnostics.push(error(concept.file, `'${name}' is exported by both dependencies ${previous} and ${dep}`, { line: 1 }));
        } else {
          importedFrom.set(name, dep);
          names.push(name);
        }
      }
      if (names.length > 0) {
        importLines.push(`import { ${names.join(', ')} } from '${relativeImport(concept.id, dep)}';`);
      }
    }
    const header = [`// @generated by ccc from concept ${concept.id}. Do not edit.`, ...importLines];
    files.push({
      id: concept.id,
      conceptFile: concept.file,
      path: interfacePath(concept.id),
      content: [...header, fm.interface.trimEnd(), ''].join('\n'),
      headerLines: header.length,
    });
  }
  return { files, diagnostics };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run interfaces`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/interfaces.ts packages/cli/test/interfaces.test.ts
git commit -m "Read interface exports and emit per-concept .d.ts files"
```

---

### Task 8: Type-check interfaces with TypeScript 7

**Files:**
- Create: `packages/cli/src/typecheck.ts`
- Test: `packages/cli/test/typecheck.test.ts`

**Interfaces:**
- Consumes: `EmittedInterface`, `emitInterfaces`, `collectExports` (Task 7); `error`, `Diagnostic` (Task 3). Test helpers (Task 5).
- Produces:
  - `tscPath(): string` (absolute path to TypeScript 7's `bin/tsc`)
  - `parseTscOutput(stdout: string, files: readonly EmittedInterface[]): Diagnostic[]`
  - `typecheckInterfaces(files: readonly EmittedInterface[]): Promise<Diagnostic[]>`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/typecheck.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { collectExports, emitInterfaces } from '../src/interfaces.js';
import { parseTscOutput, typecheckInterfaces } from '../src/typecheck.js';
import { concept, projectFrom } from './helpers.js';

function emit(files: Record<string, string>) {
  const project = projectFrom(files);
  return emitInterfaces(project, collectExports(project)).files;
}

describe('parseTscOutput', () => {
  const files = emit({
    'card.md': concept('kind: value\ninterface: export type Card = string;'),
    'hand.md': concept('kind: value\nuses: [card]\ninterface: |\n  export class Hand {\n    add(card: Card): Nope;\n  }'),
  });

  it('maps tsc lines to concept files and interface lines', () => {
    const out = "hand.d.ts(4,20): error TS2304: Cannot find name 'Nope'.\n";
    expect(parseTscOutput(out, files)).toEqual([
      {
        severity: 'error',
        file: 'concepts/hand.md',
        line: 1,
        message: "interface line 2: Cannot find name 'Nope'. (TS2304)",
      },
    ]);
  });

  it('keeps unrecognized output as a general error', () => {
    expect(parseTscOutput('error TS5023: Unknown compiler option.\n', files)).toEqual([
      { severity: 'error', file: 'concepts/', message: 'tsc: error TS5023: Unknown compiler option.' },
    ]);
  });
});

describe('typecheckInterfaces (runs TypeScript 7)', () => {
  it('passes valid interfaces, including web types like Request', async () => {
    const files = emit({
      'user.md': concept("kind: value\ninterface: |\n  export type UserId = string & { readonly __brand: 'UserId' };"),
      'auth.md': concept(
        'kind: auth\nuses: [user]\ninterface: |\n  export interface Identity { readonly userId: UserId }\n  export function authenticate(request: Request): Promise<Identity | null>;',
      ),
    });
    expect(await typecheckInterfaces(files)).toEqual([]);
  });

  it('reports a type error on the right concept', async () => {
    const files = emit({
      'card.md': concept('kind: value\ninterface: export type Card = string;'),
      'hand.md': concept('kind: value\nuses: [card]\ninterface: |\n  export class Hand {\n    add(card: Card): Nope;\n  }'),
    });
    const diagnostics = await typecheckInterfaces(files);
    expect(diagnostics.map((d) => `${d.file}: ${d.message}`)).toEqual([
      "concepts/hand.md: interface line 2: Cannot find name 'Nope'. (TS2304)",
    ]);
  });

  it('returns nothing for an empty project', async () => {
    expect(await typecheckInterfaces([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run typecheck`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/typecheck.ts`:
```ts
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { error, type Diagnostic } from './diagnostics.js';
import type { EmittedInterface } from './interfaces.js';

const execFileAsync = promisify(execFile);
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    module: 'nodenext',
    moduleResolution: 'nodenext',
    target: 'es2024',
    lib: ['es2024', 'dom'],
    types: [],
  },
  include: ['**/*.d.ts'],
};

export function tscPath(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

export function parseTscOutput(stdout: string, files: readonly EmittedInterface[]): Diagnostic[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const diagnostics: Diagnostic[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    const match = TSC_LINE.exec(line);
    const file = match === null ? undefined : byPath.get((match[1] ?? '').split(path.sep).join('/'));
    if (match === null || file === undefined) {
      diagnostics.push(error('concepts/', `tsc: ${line}`));
      continue;
    }
    const interfaceLine = Number(match[2]) - file.headerLines;
    const where = interfaceLine >= 1 ? `interface line ${interfaceLine}` : 'generated imports';
    diagnostics.push(error(file.conceptFile, `${where}: ${match[5]} (${match[4]})`, { line: 1 }));
  }
  return diagnostics;
}

async function runTsc(dir: string): Promise<string> {
  try {
    await execFileAsync(process.execPath, [tscPath(), '-p', dir, '--pretty', 'false'], { cwd: dir });
    return '';
  } catch (err) {
    if (err instanceof Error && 'stdout' in err && typeof err.stdout === 'string' && err.stdout !== '') {
      return err.stdout;
    }
    throw err;
  }
}

export async function typecheckInterfaces(files: readonly EmittedInterface[]): Promise<Diagnostic[]> {
  if (files.length === 0) {
    return [];
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-interfaces-'));
  try {
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
    await writeFile(path.join(dir, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
    await Promise.all(
      files.map(async (file) => {
        const full = path.join(dir, file.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.content);
      }),
    );
    return parseTscOutput(await runTsc(dir), files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

The `'dom'` lib gives interfaces the web-standard types (`Request`, `Response`, `crypto`) that the WinterTC-style adapters in Plan 3 need.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run typecheck`
Expected: PASS (the TS 7 tests take about a second each).

- [ ] **Step 5: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/typecheck.ts packages/cli/test/typecheck.test.ts
git commit -m "Type-check emitted interfaces with TypeScript 7 and map errors to concepts"
```

---

### Task 9: Sync action resolution and sync cycles

**Files:**
- Create: `packages/cli/src/syncs.ts`
- Test: `packages/cli/test/syncs.test.ts`

**Interfaces:**
- Consumes: `Project` (Task 5); `ExportInfo`, `collectExports` (Task 7); `findCycles` (Task 6); `parseActionRef`, `ConceptId` (Task 2); `error`, `Diagnostic` (Task 3).
- Produces:
  - `primaryClassName(id: ConceptId): string`: `'game.players'` → `'Players'`, `'game-store'` → `'GameStore'`
  - `checkSyncActions(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): Diagnostic[]`
  - `checkSyncCycles(project: Project): Diagnostic[]`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/syncs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { collectExports } from '../src/interfaces.js';
import { checkSyncActions, checkSyncCycles, primaryClassName } from '../src/syncs.js';
import { concept, projectFrom } from './helpers.js';

const GAME = concept('kind: aggregate\ninterface: |\n  export class Game {\n    deal(): void;\n    finish(): void;\n  }\n  export function newGame(): Game;');
const PLAYERS = concept('kind: entity\ninterface: |\n  export class Players {\n    join(): void;\n  }');
const sync = (when: string, then: string): string => concept(`kind: sync\nwhen: ${when}\nthen: [${then}]`);

function actionMessages(files: Record<string, string>): string[] {
  const project = projectFrom(files);
  return checkSyncActions(project, collectExports(project)).map((d) => `${d.file}: ${d.message}`);
}

describe('primaryClassName', () => {
  it('PascalCases the last id segment', () => {
    expect(primaryClassName('game.players')).toBe('Players');
    expect(primaryClassName('game-store')).toBe('GameStore');
    expect(primaryClassName('game')).toBe('Game');
  });
});

describe('checkSyncActions', () => {
  it('accepts methods on the primary class and exported functions', () => {
    expect(
      actionMessages({
        'game.md': GAME,
        'game/players.md': PLAYERS,
        'game/deal-on-full-table.md': sync('game.players#join', 'game#deal, game#newGame'),
      }),
    ).toEqual([]);
  });
  it('reports missing actions with the class it looked for', () => {
    const project = projectFrom({ 'game.md': GAME, 'game/players.md': PLAYERS, 'game/deal.md': sync('game.players#leave', 'game#deal') });
    const [d] = checkSyncActions(project, collectExports(project));
    expect(d?.file).toBe('concepts/game/deal.md');
    expect(d?.message).toBe("game.players#leave: 'game.players' has no exported function 'leave' and no method 'leave' on class Players");
    expect(d?.hint).toBe('actions are exported functions, or methods of the class named after the concept (Players)');
  });
  it('skips unknown concepts (reported by the reference check)', () => {
    expect(actionMessages({ 'game.md': GAME, 'deal.md': sync('nope#x', 'game#deal') })).toEqual([]);
  });
});

describe('checkSyncCycles', () => {
  it('accepts acyclic syncs', () => {
    const project = projectFrom({ 'game.md': GAME, 'deal.md': sync('game#deal', 'game#finish') });
    expect(checkSyncCycles(project)).toEqual([]);
  });
  it('reports direct and transitive cycles', () => {
    const selfLoop = projectFrom({ 'game.md': GAME, 'again.md': sync('game#deal', 'game#deal') });
    expect(checkSyncCycles(selfLoop).map((d) => `${d.file}: ${d.message}`)).toEqual([
      'concepts/again.md: sync cycle: game#deal → game#deal',
    ]);
    const transitive = projectFrom({
      'game.md': GAME,
      'a.md': sync('game#deal', 'game#finish'),
      'b.md': sync('game#finish', 'game#deal'),
    });
    const [d] = checkSyncCycles(transitive);
    expect(d?.message).toBe('sync cycle: game#deal → game#finish → game#deal');
    expect(d?.file).toBe('concepts/a.md');
    expect(d?.hint).toBe('a sync must not directly or transitively re-trigger its own when action');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run syncs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/syncs.ts`:
```ts
import { findCycles } from './cycles.js';
import { error, type Diagnostic } from './diagnostics.js';
import { parseActionRef, type ConceptId } from './ids.js';
import type { ExportInfo } from './interfaces.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';

export function primaryClassName(id: ConceptId): string {
  const last = id.split('.').at(-1) ?? id;
  return last
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function syncs(project: Project): Concept[] {
  return [...project.concepts.values()].filter((concept) => concept.frontmatter.kind === 'sync');
}

function actionsOf(concept: Concept): string[] {
  const fm = concept.frontmatter;
  return fm.kind === 'sync' ? [fm.when, ...fm.then] : [];
}

export function checkSyncActions(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const sync of syncs(project)) {
    for (const ref of actionsOf(sync)) {
      const { conceptId, member } = parseActionRef(ref);
      const info = exportsByConcept.get(conceptId);
      if (info === undefined) {
        continue;
      }
      const className = primaryClassName(conceptId);
      if (info.functions.includes(member) || (info.classMethods.get(className) ?? []).includes(member)) {
        continue;
      }
      diagnostics.push(
        error(
          sync.file,
          `${ref}: '${conceptId}' has no exported function '${member}' and no method '${member}' on class ${className}`,
          { line: 1, hint: `actions are exported functions, or methods of the class named after the concept (${className})` },
        ),
      );
    }
  }
  return diagnostics;
}

export function checkSyncCycles(project: Project): Diagnostic[] {
  const edges = new Map<string, string[]>();
  const firstSyncByWhen = new Map<string, Concept>();
  for (const sync of syncs(project)) {
    const fm = sync.frontmatter;
    if (fm.kind !== 'sync') {
      continue;
    }
    edges.set(fm.when, [...(edges.get(fm.when) ?? []), ...fm.then]);
    if (!firstSyncByWhen.has(fm.when)) {
      firstSyncByWhen.set(fm.when, sync);
    }
  }
  return findCycles(edges).map((cycle) => {
    const owner = firstSyncByWhen.get(cycle[0] ?? '');
    return error(owner?.file ?? 'concepts/', `sync cycle: ${cycle.join(' → ')}`, {
      line: 1,
      hint: 'a sync must not directly or transitively re-trigger its own when action',
    });
  });
}
```

`project.concepts` is inserted in sorted path order (Task 5 sorts files; `projectFrom` sorts keys), so "first sync" is deterministic.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run syncs`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

Run: `pnpm verify` (expected: all green)
```bash
git add packages/cli/src/syncs.ts packages/cli/test/syncs.test.ts
git commit -m "Resolve sync actions against interfaces and detect sync cycles"
```

---

### Task 10: `ccc check` command and CLI

**Files:**
- Create: `packages/cli/src/check.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/bin.ts`
- Create fixture: `packages/cli/test/fixtures/card-game/concepts/` (files listed in Step 1)
- Create fixture: `packages/cli/test/fixtures/card-game/handwritten/user.ts`
- Test: `packages/cli/test/check.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `loadProject`, `Project` (Task 5); `checkReferences`, `checkDependencyCycles` (Task 6); `collectExports`, `emitInterfaces` (Task 7); `typecheckInterfaces` (Task 8); `checkSyncActions`, `checkSyncCycles` (Task 9); `error`, `hasErrors`, `sortDiagnostics`, `formatDiagnostic`, `Diagnostic` (Task 3); `VERSION` (Task 1).
- Produces:
  - `check.ts`: `interface CheckResult { project: Project; diagnostics: Diagnostic[] }`; `runCheck(root: string): Promise<CheckResult>`
  - `cli.ts`: `interface Io { cwd: string; stdout(text: string): void; stderr(text: string): void }`; `main(argv: readonly string[], io: Io): Promise<number>`; `summary(concepts: number, errors: number, warnings: number): string`
  - `bin.ts`: executable entry (`ccc`)

- [ ] **Step 1: Create the fixture project**

This is a small valid card-game model that exercises every kind, containment, a handwritten concept, and a sync. Plan 4 grows it into the full example.

`packages/cli/test/fixtures/card-game/concepts/user.md`:
```markdown
---
kind: value
implementation: handwritten
source: handwritten/user.ts
interface: |
  export type UserId = string & { readonly __brand: 'UserId' };
  export function userId(raw: string): UserId;
---
## Intent
Identifies a person across games, independent of how they authenticate.

## Examples
- userId("u1") → "u1" typed as UserId
- userId("") → throws Error "empty user id"
```

`packages/cli/test/fixtures/card-game/handwritten/user.ts`:
```ts
export type UserId = string & { readonly __brand: 'UserId' };

export function userId(raw: string): UserId {
  if (raw === '') {
    throw new Error('empty user id');
  }
  return raw as UserId;
}
```

`packages/cli/test/fixtures/card-game/concepts/card.md`:
```markdown
---
kind: value
interface: |
  export type Suit = '♠' | '♥' | '♦' | '♣';
  export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
  export interface Card {
    readonly rank: Rank;
    readonly suit: Suit;
  }
  export function card(rank: Rank, suit: Suit): Card;
  export function sameCard(a: Card, b: Card): boolean;
---
## Intent
A playing card from a standard 52-card deck.

## Examples
- card("A", "♠") → { rank: "A", suit: "♠" }
- sameCard(card("A", "♠"), card("A", "♠")) → true
- sameCard(card("A", "♠"), card("K", "♠")) → false
```

`packages/cli/test/fixtures/card-game/concepts/game.md`:
```markdown
---
kind: aggregate
uses: [card, user]
interface: |
  export class RoundInProgress extends Error {}
  export class Game {
    constructor(id: string, seats: number);
    readonly id: string;
    readonly players: Players;
    deal(): void;
    play(user: UserId, played: Card): void;
    isRoundInProgress(): boolean;
  }
---
## Intent
One table of a card game: its seats, deck, and the round being played.

## Rules
- Every card is in exactly one place: the deck or one player's hand.
- Dealing is only allowed when no round is in progress.

## Examples
- given a new 4-seat game, deal() → each seated player holds 13 cards, deck is empty
- given a round in progress, deal() → throws RoundInProgress
- given a dealt game, play(user, a card in their hand) → the card leaves their hand

## Decisions
- Seats are fixed at creation; changing table size mid-game isn't a real-world need.
```

`packages/cli/test/fixtures/card-game/concepts/game/deck.md`:
```markdown
---
kind: collection
of: card
interface: |
  export class EmptyDeck extends Error {}
  export class Deck {
    static standard(): Deck;
    shuffle(random: () => number): void;
    draw(): Card;
    size(): number;
  }
---
## Intent
The undealt cards of a game.

## Rules
- A deck never contains the same card twice.

## Examples
- Deck.standard().size() → 52
- given an empty deck, draw() → throws EmptyDeck
```

`packages/cli/test/fixtures/card-game/concepts/game/player.md`:
```markdown
---
kind: entity
uses: [user, game.player.hand]
interface: |
  export class Player {
    constructor(user: UserId);
    readonly user: UserId;
    readonly hand: Hand;
  }
---
## Intent
A user seated at one game, with their hand for that game.

## Examples
- new Player(userId("u1")).hand.size() → 0
```

`packages/cli/test/fixtures/card-game/concepts/game/player/hand.md`:
```markdown
---
kind: collection
of: card
interface: |
  export class DuplicateCard extends Error {}
  export class CardNotInHand extends Error {}
  export class Hand {
    constructor(cards?: readonly Card[]);
    add(card: Card): void;
    remove(card: Card): Card;
    has(card: Card): boolean;
    size(): number;
  }
---
## Intent
The cards a player currently holds.

## Rules
- A hand never contains the same card twice.

## Examples
- given an empty hand, add(A♠) → size is 1
- given hand [A♠], add(A♠) → throws DuplicateCard
- given hand [A♠], remove(K♥) → throws CardNotInHand
```

`packages/cli/test/fixtures/card-game/concepts/game/players.md`:
```markdown
---
kind: collection
of: game.player
uses: [user]
interface: |
  export class TableFull extends Error {}
  export class Players {
    constructor(seats: number);
    join(user: UserId): Player;
    seatsLeft(): number;
    all(): readonly Player[];
  }
---
## Intent
Who is seated at a game, in seat order.

## Examples
- given 1 seat left, join(u) → seatsLeft() is 0
- given 0 seats left, join(u) → throws TableFull
```

`packages/cli/test/fixtures/card-game/concepts/game/deal-on-full-table.md`:
```markdown
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

`packages/cli/test/fixtures/card-game/concepts/auth.md`:
```markdown
---
kind: auth
uses: [user]
interface: |
  export interface Identity {
    readonly userId: UserId;
  }
  export function authenticate(request: Request): Promise<Identity | null>;
---
## Intent
Resolves an incoming request to the user making it.

## Examples
- request with a valid session cookie → Identity for that user
- request with no session cookie → null
```

`packages/cli/test/fixtures/card-game/concepts/game-store.md`:
````markdown
---
kind: store
persists: game
interface: |
  export class GameStore {
    load(id: string): Promise<Game | null>;
    save(game: Game): Promise<void>;
  }
---
## Intent
Saves and loads games.

## Schema
```sql
create table games (
  id text primary key,
  state jsonb not null
);
```

## Examples
- save(game) then load(game.id) → an equal game
- load("missing") → null
````

`packages/cli/test/fixtures/card-game/concepts/game-api.md`:
```markdown
---
kind: endpoint
uses: [game, game-store, auth]
interface: |
  export function handle(request: Request): Promise<Response>;
---
## Intent
HTTP access to games for authenticated players.

## Examples
- POST /games/:id/join without a session → 401
- POST /games/:id/play with a card not in hand → 409
```

That's 11 concepts. `game-store` gets `Game` through `persists: game`. The aggregate `game` automatically imports only its **direct** children (`game.deck`, `game.player`, `game.players`); `Hand` stays private to `game.player`, and `Game`'s interface never mentions it.

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/check.test.ts`:
```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/check.js';
import { concept, writeProject } from './helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'card-game');

describe('runCheck', () => {
  it('passes the card-game fixture with no diagnostics', async () => {
    const { project, diagnostics } = await runCheck(FIXTURE);
    expect(diagnostics).toEqual([]);
    expect(project.concepts.size).toBe(11);
  });

  it('reports a missing handwritten source', async () => {
    const root = await writeProject({
      'concepts/user.md': concept(
        'kind: value\nimplementation: handwritten\nsource: handwritten/user.ts\ninterface: export type UserId = string;',
      ),
    });
    const { diagnostics } = await runCheck(root);
    expect(diagnostics.map((d) => `${d.file}: ${d.message}`)).toEqual([
      'concepts/user.md: handwritten source not found: handwritten/user.ts',
    ]);
  });

  it('skips type-checking when structural errors exist', async () => {
    const root = await writeProject({
      'concepts/card.md': concept('kind: value\nuses: [nope]\ninterface: export type Card = Nope;'),
    });
    const { diagnostics } = await runCheck(root);
    expect(diagnostics.map((d) => d.message)).toEqual(["unknown concept 'nope' in uses"]);
  });

  it('type-checks when the structure is valid', async () => {
    const root = await writeProject({ 'concepts/card.md': concept('kind: value\ninterface: export type Card = Nope;') });
    const { diagnostics } = await runCheck(root);
    expect(diagnostics.map((d) => d.message)).toEqual(["interface line 1: Cannot find name 'Nope'. (TS2304)"]);
  });

  it('returns sorted diagnostics from every stage', async () => {
    const root = await writeProject({
      'concepts/b.md': concept('kind: value\nuses: [a]\ninterface: export type B = string;'),
      'concepts/a.md': concept('kind: value\nuses: [b]\ninterface: export type A = string;'),
      'concepts/notes.txt': 'x',
    });
    const { diagnostics } = await runCheck(root);
    expect(diagnostics.map((d) => `${d.severity} ${d.file}: ${d.message}`)).toEqual([
      'error concepts/a.md: dependency cycle: a → b → a',
      'warning concepts/notes.txt: ignored: not a .md concept file',
    ]);
  });
});
```

`packages/cli/test/cli.test.ts`:
```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main, summary, type Io } from '../src/cli.js';
import { concept, writeProject } from './helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'card-game');

function captureIo(cwd: string): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      cwd,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
  };
}

describe('summary', () => {
  it('pluralizes and reports a clean project', () => {
    expect(summary(1, 0, 0)).toBe('✓ 1 concept, no problems');
    expect(summary(10, 2, 1)).toBe('10 concepts: 2 errors, 1 warning');
    expect(summary(3, 0, 2)).toBe('3 concepts: 0 errors, 2 warnings');
  });
});

describe('main', () => {
  it('ccc check succeeds on the fixture', async () => {
    const cap = captureIo(FIXTURE);
    expect(await main(['check'], cap.io)).toBe(0);
    expect(cap.out()).toBe('✓ 11 concepts, no problems\n');
  });

  it('ccc check -C resolves relative to cwd and fails on errors', async () => {
    const root = await writeProject({ 'concepts/card.md': concept('kind: value\nuses: [nope]\ninterface: export type A = string;') });
    const cap = captureIo(path.dirname(root));
    expect(await main(['check', '-C', path.basename(root)], cap.io)).toBe(1);
    expect(cap.out()).toBe(
      "concepts/card.md:1: error: unknown concept 'nope' in uses\n1 concept: 1 error, 0 warnings\n",
    );
  });

  it('prints the version and help without throwing', async () => {
    const version = captureIo(FIXTURE);
    expect(await main(['--version'], version.io)).toBe(0);
    expect(version.out()).toBe('0.1.0\n');
    const help = captureIo(FIXTURE);
    expect(await main(['--help'], help.io)).toBe(0);
    expect(help.out()).toContain('check');
  });

  it('returns a non-zero code for an unknown command', async () => {
    const cap = captureIo(FIXTURE);
    expect(await main(['nope'], cap.io)).not.toBe(0);
    expect(cap.err()).toContain("unknown command 'nope'");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ccc/cli exec vitest run check cli`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `runCheck`**

`packages/cli/src/check.ts`:
```ts
import { access } from 'node:fs/promises';
import path from 'node:path';
import { error, hasErrors, sortDiagnostics, type Diagnostic } from './diagnostics.js';
import { checkDependencyCycles, checkReferences } from './graph.js';
import { collectExports, emitInterfaces } from './interfaces.js';
import { loadProject, type Project } from './load.js';
import { checkSyncActions, checkSyncCycles } from './syncs.js';
import { typecheckInterfaces } from './typecheck.js';

export interface CheckResult {
  project: Project;
  diagnostics: Diagnostic[];
}

async function checkHandwrittenSources(project: Project): Promise<Diagnostic[]> {
  const results = await Promise.all(
    [...project.concepts.values()].map(async (concept): Promise<Diagnostic | null> => {
      const fm = concept.frontmatter;
      if (fm.kind === 'sync' || fm.implementation !== 'handwritten' || fm.source === undefined) {
        return null;
      }
      try {
        await access(path.join(project.root, fm.source));
        return null;
      } catch {
        return error(concept.file, `handwritten source not found: ${fm.source}`, { line: 1 });
      }
    }),
  );
  return results.filter((d): d is Diagnostic => d !== null);
}

// Runs every rule in spec §2.8. Type-checking runs last and only on a
// structurally valid project, so its errors aren't noise from broken references.
export async function runCheck(root: string): Promise<CheckResult> {
  const { project, diagnostics } = await loadProject(root);
  diagnostics.push(...checkReferences(project), ...checkDependencyCycles(project));
  diagnostics.push(...(await checkHandwrittenSources(project)));
  const exportsByConcept = collectExports(project);
  diagnostics.push(...checkSyncActions(project, exportsByConcept), ...checkSyncCycles(project));
  const emitted = emitInterfaces(project, exportsByConcept);
  diagnostics.push(...emitted.diagnostics);
  if (!hasErrors(diagnostics)) {
    diagnostics.push(...(await typecheckInterfaces(emitted.files)));
  }
  return { project, diagnostics: sortDiagnostics(diagnostics) };
}
```

- [ ] **Step 5: Implement the CLI**

`packages/cli/src/cli.ts`:
```ts
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { runCheck } from './check.js';
import { formatDiagnostic } from './diagnostics.js';
import { VERSION } from './version.js';

export interface Io {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

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

async function checkCommand(root: string, io: Io): Promise<number> {
  const { project, diagnostics } = await runCheck(root);
  for (const d of diagnostics) {
    io.stdout(`${formatDiagnostic(d)}\n`);
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  io.stdout(`${summary(project.concepts.size, errors, warnings)}\n`);
  return errors > 0 ? 1 : 0;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = 0;
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
      exitCode = await checkCommand(path.resolve(io.cwd, options.dir), io);
    });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    throw err;
  }
  return exitCode;
}
```

`packages/cli/src/bin.ts`:
```ts
#!/usr/bin/env node
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @ccc/cli exec vitest run check cli`
Expected: PASS. If the fixture reports diagnostics, read them. Each one names the concept file and rule, so fix the fixture Markdown (it's hand-written test data) until `runCheck` is clean. Don't loosen a rule.

- [ ] **Step 7: Run the built binary end to end**

Run:
```bash
pnpm verify
node packages/cli/dist/bin.js check -C packages/cli/test/fixtures/card-game
echo "exit=$?"
```
Expected: `✓ 11 concepts, no problems` and `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/check.ts packages/cli/src/cli.ts packages/cli/src/bin.ts packages/cli/test/check.test.ts packages/cli/test/cli.test.ts packages/cli/test/fixtures
git commit -m "Add ccc check command with card-game fixture"
```

---

### Task 11: Schema reference documentation

**Files:**
- Create: `docs/schema.md`, `README.md`

**Interfaces:**
- Consumes: the behavior implemented in Tasks 2–10 (the docs must match the code; every rule in the "Checks" list corresponds to a diagnostic message tested above).
- Produces: `docs/schema.md` (referenced by `CLAUDE.md` from Task 1), `README.md`.

- [ ] **Step 1: Write `docs/schema.md`**

````markdown
# Concept schema reference

A ccc project is a directory with a `concepts/` folder. Every `.md` file under it is one concept. Concepts are the source of truth: you edit them, and ccc generates the code.

## Files, IDs, and containment

- The ID comes from the path: `concepts/game/player/hand.md` is `game.player.hand`. Never write an `id` field.
- Names are lowercase kebab-case (`game-store`, not `GameStore` or `game_store`).
- A directory is the inside of the concept with the same name: `concepts/game/` holds the children of `concepts/game.md`. Every directory needs that parent file.
- Dotfiles are ignored. Other non-`.md` files produce a warning.

## File layout

```markdown
---
kind: collection          # required
of: card                  # kind-specific fields
uses: [user]              # dependencies (see Visibility)
interface: |              # TypeScript declarations this concept exports
  export class Hand {
    add(card: Card): void;
  }
---
## Intent
What this concept is for. (required)

## Rules
- Invariants, in prose.

## Examples
- One behavior per bullet. These become tests.
- Longer examples can continue
  on indented lines.

## Decisions
- Why things are the way they are.
```

## Kinds

| Kind | Use for | Extra fields |
|---|---|---|
| `value` | Data with no identity (a Card) | — |
| `entity` | Something with identity and a lifecycle (a Player) | — |
| `collection` | A structure of other concepts (a Hand of Cards) | `of: <id>` |
| `aggregate` | A root that owns its children and enforces rules across them (a Game) | — |
| `store` | Persists one aggregate | `persists: <id>`; requires a `## Schema` section with the table SQL |
| `endpoint` | HTTP routes | — |
| `auth` | Turns a request into an identity | — |
| `sync` | When an action happens on one concept, invoke actions on others | `when`, `then`; no `interface` |

The first four are **domain** kinds. `store`, `endpoint`, and `auth` are **adapter** kinds. Domain concepts can never depend on adapters; connect them with a sync instead.

## Fields

| Field | Meaning |
|---|---|
| `kind` | One of the kinds above |
| `interface` | TypeScript declarations (classes, functions, types, error classes). Write methods without bodies. Types from dependencies are imported automatically. |
| `uses` | Concepts whose interfaces this one depends on. An aggregate automatically uses its direct children (except syncs). |
| `implementation` | `generated` (default) or `handwritten` |
| `source` | For `handwritten` only: path to the module, relative to the project root |

## Sections

- `## Intent` (required), `## Rules`, `## Examples`, `## Decisions`. Stores also require `## Schema`.
- Any other `##` heading is an error; that catches typos like `## Example`.
- `## ...` lines inside code fences are ignored.
- `ccc check` warns when `## Examples` is missing or empty; `ccc build` will require it.

## Visibility

A concept can reference: its ancestors, its own children, its siblings, and its ancestors' siblings (which includes every top-level concept). Anything nested deeper is private to its parent.

`game.player.hand` is visible to `game.player` and its other children, but not to `game` or `game-api`.

Put an invariant on the lowest concept that can see everything it mentions. Put a sync in the lowest directory that contains everything it connects.

## Syncs

```markdown
---
kind: sync
when: game.players#join
then: [game#deal]
---
## Intent
Start the round automatically once the table fills.

## Examples
- given 3 of 4 seats taken, join(user) → deal() called once
```

An action is written `<concept-id>#<member>`. It resolves to an exported function named `<member>`, or else a method named `<member>` on the concept's primary class: the class named after the ID's last segment in PascalCase (`game.players` → `Players`, `game-store` → `GameStore`).

Syncs can't form cycles: a sync must not directly or transitively re-trigger its own `when` action.

## `ccc check`

```bash
ccc check            # in the project root
ccc check -C path    # or point at it
```

It makes no LLM calls. Exit code 1 if there are errors. It checks:

1. Every file parses; frontmatter matches its kind; required sections exist; no unknown sections.
2. Names are kebab-case; every directory has its parent concept file.
3. Every referenced concept exists and is visible, and isn't referenced by itself.
4. Domain concepts don't depend on adapters; nothing references a sync; `persists` targets an aggregate.
5. No dependency cycles.
6. Handwritten `source` files exist.
7. Sync actions exist, and syncs have no cycles.
8. No exported name collides with a dependency's export.
9. All interfaces type-check together with TypeScript 7 (only when 1–8 pass). Web types such as `Request` and `Response` are available.
````

- [ ] **Step 2: Write `README.md`**

```markdown
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
```

- [ ] **Step 3: Check the docs against the code**

For each numbered item under "`ccc check`" in `docs/schema.md`, find the test that asserts its diagnostic (Tasks 4–10). If a doc statement has no matching behavior, correct the doc. Then run `pnpm verify` (expected: all green).

- [ ] **Step 4: Commit**

```bash
git add docs/schema.md README.md
git commit -m "Document the concept schema and ccc check"
```
