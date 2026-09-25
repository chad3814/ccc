import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runtimeDir, runtimeTypePaths, runtimeVersion } from '../src/runtimepkg.js';

describe('runtime package', () => {
  it('locates the runtime and its version', async () => {
    expect(await runtimeVersion()).toBe('0.1.0');
    await access(runtimeDir());
  });

  it('maps runtime imports to built declarations', async () => {
    const paths = runtimeTypePaths();
    expect(Object.keys(paths)).toEqual(['@ccc/runtime', '@ccc/runtime/pglite']);
    await access(paths['@ccc/runtime']?.[0] ?? '');
  });
});
