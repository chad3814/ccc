import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { main, type Io } from '../src/cli.js';
import { openPgDatabase } from '../src/dbreset.js';
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

const services = { generator: () => new FakeGenerator(pipelineResponder()), openDatabase: openPgDatabase };

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
