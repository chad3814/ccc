import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileHash, listFilesUnder, readFileOrNull, removeFile, writeFileAtomic } from '../src/fsutil.js';
import { writeProject } from './helpers.js';

describe('fsutil', () => {
  it('writes atomically, creating directories, and reads back', async () => {
    const root = await writeProject({});
    await writeFileAtomic(root, '.ccc/gen/a/b.ts', 'x');
    expect(await readFileOrNull(root, '.ccc/gen/a/b.ts')).toBe('x');
    expect(await readdir(path.join(root, '.ccc/gen/a'))).toEqual(['b.ts']);
  });

  it('returns null or nothing for missing files', async () => {
    const root = await writeProject({});
    expect(await readFileOrNull(root, 'nope.txt')).toBeNull();
    expect(await fileHash(root, 'nope.txt')).toBeNull();
    expect(await listFilesUnder(root, '.ccc/gen')).toEqual([]);
    await removeFile(root, 'nope.txt');
  });

  it('hashes and lists files', async () => {
    const root = await writeProject({ '.ccc/gen/z.ts': 'z', '.ccc/gen/a/b.ts': 'abc' });
    expect(await fileHash(root, '.ccc/gen/a/b.ts')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await listFilesUnder(root, '.ccc/gen')).toEqual(['.ccc/gen/a/b.ts', '.ccc/gen/z.ts']);
  });
});
