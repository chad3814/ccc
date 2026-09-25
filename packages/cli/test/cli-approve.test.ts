import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { main, type Io } from '../src/cli.js';
import { openPgDatabase } from '../src/dbreset.js';
import { sha256 } from '../src/hash.js';
import { readManifest, writeManifest } from '../src/manifest.js';
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

function capture(cwd: string, answers?: string[]) {
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
    io.choose = async (_question, choices) => {
      const answer = answers.shift() ?? 'n';
      expect(choices).toContain(answer);
      return answer;
    };
  }
  return { io, out: () => out };
}

const services = { generator: () => new FakeGenerator(pipelineResponder()), openDatabase: openPgDatabase };

describe('ccc approve / verify', () => {
  it('requires --yes without an interactive terminal', async () => {
    const root = await copy();
    const cap = capture(root);
    expect(await main(['approve'], cap.io, services)).toBe(1);
    expect(cap.out()).toContain(
      [
        '=== card (.ccc/gen/card.test.ts): 2 tests, 2 new ===',
        '  [ex 1] new        card("A", "♠") → { rank: "A", suit: "♠" }',
        "                    expect(card('A', '♠')).toEqual({ rank: 'A', suit: '♠' });",
        '  [ex 2] new        sameCard(card("A", "♠"), card("A", "♠")) → true',
        "                    expect(sameCard(card('A', '♠'), card('A', '♠'))).toBe(true);",
      ].join('\n'),
    );
    expect(cap.out()).not.toContain("import { card, sameCard } from './card.js';");
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
    const cap = capture(root, ['y', 'n', 'y', 'y']);
    expect(await main(['approve'], cap.io, services)).toBe(1);
    expect(cap.out().trimEnd().split('\n').at(-1)).toBe('approved 3 of 4');
  });

  it('prints the whole file on request, then asks again', async () => {
    const root = await copy();
    const cap = capture(root, ['f', 'y', 'y', 'y', 'y']);
    expect(await main(['approve'], cap.io, services)).toBe(0);
    expect(cap.out()).toContain("=== .ccc/gen/card.test.ts ===\nimport { card, sameCard } from './card.js';");
  });

  it('prints whole files with --full', async () => {
    const root = await copy();
    const cap = capture(root);
    expect(await main(['approve', '--full'], cap.io, services)).toBe(1);
    expect(cap.out()).toContain("=== .ccc/gen/card.test.ts ===\nimport { card, sameCard } from './card.js';");
  });

  it('shows only changed tests after a regeneration', async () => {
    const root = await copy();
    expect(await main(['approve', '--yes'], capture(root).io, services)).toBe(0);
    const test = await readFile(path.join(root, '.ccc/gen/card.test.ts'), 'utf8');
    const regenerated = test.replace(').toBe(true);', ').toBe(true); // same claim\n    expect(sameCard(card("A", "♠"), card("K", "♠"))).toBe(false);');
    await writeFile(path.join(root, '.ccc/gen/card.test.ts'), regenerated);
    const { manifest } = await readManifest(root);
    const entry = manifest.concepts.card;
    if (entry === undefined) throw new Error('fixture');
    entry.testFileHash = await sha256(regenerated);
    await writeManifest(root, manifest);
    const cap = capture(root);
    expect(await main(['approve', 'card'], cap.io, services)).toBe(1);
    expect(cap.out()).toContain(
      [
        '=== card (.ccc/gen/card.test.ts): 2 tests, 1 changed, 1 unchanged ===',
        '  [ex 1] unchanged  card("A", "♠") → { rank: "A", suit: "♠" }',
        '  [ex 2] changed    sameCard(card("A", "♠"), card("A", "♠")) → true',
        "                    expect(sameCard(card('A', '♠'), card('A', '♠'))).toBe(true);",
        '                    expect(sameCard(card("A", "♠"), card("K", "♠"))).toBe(false);',
      ].join('\n'),
    );
  });

  it('flags shared code that changed outside the tests', async () => {
    const root = await copy();
    expect(await main(['approve', '--yes'], capture(root).io, services)).toBe(0);
    const test = await readFile(path.join(root, '.ccc/gen/card.test.ts'), 'utf8');
    const regenerated = test.replace("describe('card', () => {", "describe('card', () => {\n  beforeEach(() => reset());");
    await writeFile(path.join(root, '.ccc/gen/card.test.ts'), regenerated);
    const { manifest } = await readManifest(root);
    const entry = manifest.concepts.card;
    if (entry === undefined) throw new Error('fixture');
    entry.testFileHash = await sha256(regenerated);
    await writeManifest(root, manifest);
    const cap = capture(root);
    expect(await main(['approve', 'card'], cap.io, services)).toBe(1);
    expect(cap.out()).toContain('=== card (.ccc/gen/card.test.ts): 2 tests, 2 unchanged ===');
    expect(cap.out()).toContain('  shared code outside the tests changed; press f to see the whole file');
  });

  it('verify exits 1 with diagnostics when something is wrong', async () => {
    const root = await copy();
    const cap = capture(root);
    expect(await main(['verify'], cap.io, services)).toBe(1);
    expect(cap.out()).toContain('.ccc/gen/hand.test.ts:1: error: tests are not approved; run ccc approve');
    expect(cap.out().trimEnd().split('\n').at(-1)).toBe('verify failed: 4 problem(s)');
  });
});
