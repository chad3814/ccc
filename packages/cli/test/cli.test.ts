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
    expect(version.out()).toBe('0.2.0\n');
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
