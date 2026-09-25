import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/check.js';

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/card-game');

describe('examples/card-game', () => {
  it('checks clean', async () => {
    const { project, diagnostics } = await runCheck(EXAMPLE);
    expect(diagnostics).toEqual([]);
    expect(project.concepts.size).toBeGreaterThanOrEqual(9);
  });
});
