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
import { concept, writeProject } from './helpers.js';

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

describe('handwritten sources', () => {
  it('are type-checked and linted by verify', async () => {
    const root = await writeProject({
      'package.json': '{"type":"module"}\n',
      'concepts/label.md': concept(
        'kind: value\nimplementation: handwritten\nsource: handwritten/label.ts\ninterface: |\n  export function label(name: string): string;',
        '## Intent\nLabels.\n\n## Examples\n- label("a") → "[a]"\n',
      ),
      'handwritten/label.ts': 'export function label(name: string): string {\n  return `[${name}]`;\n}\n',
    });
    const test = "import { label } from './label.js';\n\ndescribe('label', () => {\n  it('[ex 1] wraps the name', () => {\n    expect(label('a')).toBe('[a]');\n  });\n});\n";
    const result = await runBuild({ root, generator: new FakeGenerator(() => test) });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    await approveEverything(root);
    expect(await messages(root)).toEqual([]);

    await writeFileAtomic(root, 'handwritten/label.ts', 'export function label(name: any): string {\n  return `[${name}]`;\n}\n');
    expect((await messages(root)).some((line) => /^handwritten\/label\.ts: lint: .*no-explicit-any/.test(line))).toBe(true);

    await writeFileAtomic(root, 'handwritten/label.ts', 'export function label(name: string, extra: number): string {\n  return `[${name}${extra}]`;\n}\n');
    expect((await messages(root)).some((line) => line.startsWith('.ccc/conformance/label.ts: type error: '))).toBe(true);
  }, 180_000);
});
