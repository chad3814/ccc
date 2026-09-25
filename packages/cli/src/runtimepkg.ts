import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';

export const RUNTIME_PACKAGE = '@ccc/runtime';

const requireFromHere = createRequire(import.meta.url);
const packageJson = z.object({ version: z.string() });

export function runtimeDir(): string {
  return path.dirname(requireFromHere.resolve(`${RUNTIME_PACKAGE}/package.json`));
}

export async function runtimeVersion(): Promise<string> {
  const text = await readFile(path.join(runtimeDir(), 'package.json'), 'utf8');
  return packageJson.parse(JSON.parse(text)).version;
}

// Lets `ccc check` type-check interfaces that mention runtime types even in
// projects that haven't installed @ccc/runtime yet.
export function runtimeTypePaths(): Record<string, string[]> {
  const dir = runtimeDir();
  return {
    [RUNTIME_PACKAGE]: [path.join(dir, 'dist', 'index.d.ts')],
    [`${RUNTIME_PACKAGE}/pglite`]: [path.join(dir, 'dist', 'pglite.d.ts')],
  };
}
