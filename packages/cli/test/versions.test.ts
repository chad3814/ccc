import { describe, expect, it } from 'vitest';
import { runtimeVersion } from '../src/runtimepkg.js';
import { loadVersions, readPrompt } from '../src/versions.js';

describe('versions', () => {
  it('reads the shipped prompts', async () => {
    expect(await readPrompt('impl')).toContain('write_module');
    expect(await readPrompt('tests')).toContain('[ex 2]');
    expect(await readPrompt('tests')).toContain('Never assume what seeded or random setup produces');
    expect(await readPrompt('sync')).toContain('SyncTargets');
  });

  it('records only the runtime version, which cached output depends on', async () => {
    expect(await loadVersions()).toEqual({ runtime: await runtimeVersion() });
  });
});
