import { beforeAll, describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { main, type Io } from '../src/cli.js';
import { readFileOrNull } from '../src/fsutil.js';
import { modulePath } from '../src/layout.js';
import { runRegen } from '../src/regen.js';
import { openPgDatabase } from '../src/dbreset.js';
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
    expect(failing).toMatchObject({ passed: false, attempts: 6 });
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
  const services = { generator: () => new FakeGenerator(pipelineResponder()), openDatabase: openPgDatabase };

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
