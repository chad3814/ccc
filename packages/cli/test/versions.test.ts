import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, configSchema } from '../src/config.js';
import { RUNTIME_VERSION, loadVersions, readPrompt } from '../src/versions.js';

describe('versions', () => {
  it('reads the shipped prompts', async () => {
    expect(await readPrompt('impl')).toContain('write_module');
    expect(await readPrompt('tests')).toContain('[ex 2]');
    expect(await readPrompt('sync')).toContain('SyncTargets');
  });

  it('hashes prompts and records models and the runtime version', async () => {
    const versions = await loadVersions(configSchema.parse({ models: { tests: 'claude-sonnet-5' } }));
    expect(versions.implPrompt).toMatch(/^[0-9a-f]{64}$/);
    expect(versions.testPrompt).not.toBe(versions.implPrompt);
    expect(versions.syncPrompt).not.toBe(versions.implPrompt);
    expect(versions.implModel).toBe(DEFAULT_MODEL);
    expect(versions.testModel).toBe('claude-sonnet-5');
    expect(versions.runtime).toBe(RUNTIME_VERSION);
  });
});
