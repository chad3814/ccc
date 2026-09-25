import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pgliteDatabase } from '@ccc/runtime/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { approve, pendingApprovals } from '../src/approve.js';
import { runBuild } from '../src/build.js';
import { readFileOrNull } from '../src/fsutil.js';
import { readManifest, writeManifest } from '../src/manifest.js';
import { runVerify } from '../src/verify.js';
import { adapterResponder, createAdapterProject } from './adapter-fixture.js';
import { FakeGenerator } from './fake-generator.js';

let root = '';

beforeAll(async () => {
  root = await createAdapterProject();
  const result = await runBuild({ root, generator: new FakeGenerator(adapterResponder()) });
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
}, 300_000);

describe('adapter pipeline', () => {
  it('generates schema, wiring, and a composition root', async () => {
    expect(await readFileOrNull(root, '.ccc/gen/schema.sql')).toContain('create table tally_audit');
    expect(await readFileOrNull(root, '.ccc/gen/wiring.ts')).toContain("afterAction(result, 'audit-adds'");
    expect(await readFileOrNull(root, '.ccc/gen/server.ts')).toContain('tallyAudit: new a0.TallyAudit(db),');
  });

  // peek-api runs first and reads each body, so these POSTs also prove every
  // endpoint receives its own clone of the request.
  it('serves requests with syncs firing inside the request scope', async () => {
    const server = await import(pathToFileURL(path.join(root, '.ccc/gen/server.ts')).href);
    const schema = await import(pathToFileURL(path.join(root, '.ccc/gen/schema.ts')).href);
    const db = pgliteDatabase();
    await db.exec(schema.schemaSql);
    const app = await server.createApp(db);
    const post = (amount: number) =>
      app(
        new Request('http://test/tallies/t/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amount }),
        }),
      );
    expect((await post(2)).status).toBe(200);
    const second = await post(3);
    expect(await second.json()).toEqual({ count: 5 });
    const audit = await app(new Request('http://test/tallies/t/audit'));
    expect(await audit.json()).toEqual([2, 3]);
    expect((await post(0)).status).toBe(400);
    expect((await app(new Request('http://test/elsewhere'))).status).toBe(404);
  });

  it('verifies once tests are approved', async () => {
    const { manifest } = await readManifest(root);
    await approve(manifest, await pendingApprovals(root, manifest));
    await writeManifest(root, manifest);
    expect((await runVerify(root)).diagnostics).toEqual([]);
  });
});
