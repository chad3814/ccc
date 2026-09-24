import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './hash.js';

export async function readFileOrNull(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

export async function writeFileAtomic(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  const temp = `${full}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content);
  await rename(temp, full);
}

export async function removeFile(root: string, rel: string): Promise<void> {
  await rm(path.join(root, rel), { force: true });
}

export async function fileHash(root: string, rel: string): Promise<string | null> {
  const text = await readFileOrNull(root, rel);
  return text === null ? null : sha256(text);
}

export async function listFilesUnder(root: string, relDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, relDir), { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
  } catch {
    return [];
  }
}
