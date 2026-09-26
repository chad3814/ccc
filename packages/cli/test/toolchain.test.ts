import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintFiles, runTests, typecheckFiles, vitestSettings, withScratch } from '../src/toolchain.js';
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

describe('vitestSettings', () => {
  it('gives generated tests and hooks a minute, since PGlite starts slowly under load', () => {
    const settings = vitestSettings('/tmp/cache');
    expect(settings.cacheDir).toBe('/tmp/cache');
    expect(settings.test).toMatchObject({ testTimeout: 60_000, hookTimeout: 60_000 });
  });
});
