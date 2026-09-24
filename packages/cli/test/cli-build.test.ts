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
