import { describe, expect, it } from 'vitest';
import { readFileOrNull } from '../src/fsutil.js';
import { emptyManifest, entryFor, hashFiles, listCccFiles, readManifest, writeManifest } from '../src/manifest.js';
import { writeProject } from './helpers.js';

describe('manifest', () => {
  it('starts empty when missing', async () => {
    const root = await writeProject({});
    expect(await readManifest(root)).toEqual({ manifest: emptyManifest(), diagnostics: [] });
  });

  it('round-trips with sorted keys', async () => {
    const root = await writeProject({});
    const manifest = emptyManifest();
    const entry = entryFor(manifest, 'hand');
    entry.testKey = 'k';
    entry.history.push({
      artifact: 'tests',
      at: '2026-09-24T00:00:00.000Z',
      model: 'claude-opus-5',
      attempts: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.000175,
      durationMs: 12,
      outcome: 'passed',
    });
    manifest.files['.ccc/gen/hand.ts'] = 'abc';
    await writeManifest(root, manifest);
    const text = await readFileOrNull(root, '.ccc/manifest.json');
    expect(text?.endsWith('\n')).toBe(true);
    expect(text?.indexOf('"concepts"')).toBeLessThan(text?.indexOf('"files"') ?? 0);
    expect((await readManifest(root)).manifest).toEqual(manifest);
  });

  it('creates entries on demand and reuses them', () => {
    const manifest = emptyManifest();
    const entry = entryFor(manifest, 'card');
    expect(entry).toEqual({ testKey: null, testFileHash: null, approvedTestHash: null, implKey: null, history: [] });
    expect(entryFor(manifest, 'card')).toBe(entry);
  });

  it('reports invalid JSON and invalid shapes', async () => {
    const bad = await writeProject({ '.ccc/manifest.json': '{nope' });
    const badResult = await readManifest(bad);
    expect(badResult.diagnostics[0]?.message).toBe('invalid manifest: not valid JSON');
    expect(badResult.diagnostics[0]?.hint).toBe('restore it from git, or delete it to rebuild everything');
    const shape = await writeProject({ '.ccc/manifest.json': '{"version":2,"concepts":{},"files":{}}' });
    expect((await readManifest(shape)).diagnostics[0]?.message).toMatch(/^invalid manifest: /);
  });

  it('lists and hashes generated files, skipping scratch and the manifest', async () => {
    const root = await writeProject({
      '.ccc/gen/card.ts': 'a',
      '.ccc/interfaces/card.d.ts': 'b',
      '.ccc/conformance/card.ts': 'c',
      '.ccc/package.json': 'd',
      '.ccc/.tmp/run-1/x.ts': 'e',
      '.ccc/manifest.json': '{}',
    });
    const files = await listCccFiles(root);
    expect(files).toEqual(['.ccc/conformance/card.ts', '.ccc/gen/card.ts', '.ccc/interfaces/card.d.ts', '.ccc/package.json']);
    const hashes = await hashFiles(root, files);
    expect(Object.keys(hashes)).toEqual(files);
    expect(hashes['.ccc/gen/card.ts']).toMatch(/^[0-9a-f]{64}$/);
  });
});
