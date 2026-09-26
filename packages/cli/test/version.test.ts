import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches the version in package.json, which is what gets published', async () => {
    const pkg = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')));
    expect(VERSION).toBe(pkg.version);
  });
});
