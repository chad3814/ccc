import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { writeFileAtomic } from '../src/fsutil.js';
import { adapterResponder, createAdapterProject } from './adapter-fixture.js';
import { FakeGenerator } from './fake-generator.js';
import { artifactOf, conceptOf } from './pipeline-fixture.js';

const OTHER_STORE = [
  '---',
  'kind: store',
  'persists: tally',
  'interface: |',
  "  import type { Database } from '@ccc/runtime';",
  '  export class OtherStore {',
  '    constructor(db: Database);',
  '  }',
  '---',
  '## Intent',
  'Unrelated to the endpoint.',
  '',
  '## Schema',
  '```sql',
  'create table other (id text primary key);',
  '```',
  '',
  '## Examples',
  '- new OtherStore(db) → constructs',
  '',
].join('\n');

const OTHER_TEST = [
  "import { pgliteDatabase } from '@ccc/runtime/pglite';",
  "import { OtherStore } from './other-store.js';",
  '',
  "it('[ex 1] constructs', () => {",
  '  expect(new OtherStore(pgliteDatabase())).toBeInstanceOf(OtherStore);',
  '});',
  '',
].join('\n');

describe('endpoints and the composition root', () => {
  it('skips endpoints when any adapter the app composes fails', async () => {
    const root = await createAdapterProject();
    await writeFileAtomic(root, 'concepts/other-store.md', OTHER_STORE);
    const canned = adapterResponder();
    const fake = new FakeGenerator((request) => {
      if (conceptOf(request) === 'other-store') {
        return artifactOf(request) === 'tests' ? OTHER_TEST : null;
      }
      return canned(request);
    });
    const result = await runBuild({ root, generator: fake });
    expect(result.failed).toEqual(['other-store']);
    expect(result.skipped).toEqual(['peek-api', 'tally-api']);
    expect(fake.requests.filter((r) => conceptOf(r) === 'tally-api' && artifactOf(r) === 'impl')).toEqual([]);
    expect(result.diagnostics.map((d) => d.message)).toContain("skipped: dependency 'other-store' did not build");
  }, 300_000);

  it('builds everything the app composes for ccc build <endpoint>', async () => {
    const root = await createAdapterProject();
    const result = await runBuild({ root, generator: new FakeGenerator(adapterResponder()), only: 'tally-api' });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.generated.impl).toEqual(['audit-adds', 'tally', 'tally-api', 'tally-audit', 'tally-store']);
  }, 300_000);
});
