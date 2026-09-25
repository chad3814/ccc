import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { error, type Diagnostic } from './diagnostics.js';
import type { EmittedInterface } from './interfaces.js';
import { runtimeTypePaths } from './runtimepkg.js';
import { parseTscLines, runTsc } from './tsc.js';

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    module: 'nodenext',
    moduleResolution: 'nodenext',
    target: 'es2024',
    lib: ['es2024', 'dom'],
    types: [],
  },
  include: ['**/*.d.ts'],
};

export { tscPath } from './tsc.js';

export function parseTscOutput(stdout: string, files: readonly EmittedInterface[]): Diagnostic[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const { messages, other } = parseTscLines(stdout);
  const diagnostics: Diagnostic[] = other.map((line) => error('concepts/', `tsc: ${line}`));
  for (const message of messages) {
    const file = byPath.get(message.file);
    if (file === undefined) {
      diagnostics.push(error('concepts/', `tsc: ${message.file}(${message.line},${message.column}): ${message.message}`));
      continue;
    }
    const interfaceLine = message.line - file.headerLines;
    const where = interfaceLine >= 1 ? `interface line ${interfaceLine}` : 'generated imports';
    diagnostics.push(error(file.conceptFile, `${where}: ${message.message} (${message.code})`, { line: 1 }));
  }
  return diagnostics;
}

export async function typecheckInterfaces(files: readonly EmittedInterface[]): Promise<Diagnostic[]> {
  if (files.length === 0) {
    return [];
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-interfaces-'));
  try {
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      `${JSON.stringify({ ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, paths: runtimeTypePaths() } }, null, 2)}\n`,
    );
    await Promise.all(
      files.map(async (file) => {
        const full = path.join(dir, file.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.content);
      }),
    );
    return parseTscOutput(await runTsc(dir, dir), files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
