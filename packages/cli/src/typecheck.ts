import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { error, type Diagnostic } from './diagnostics.js';
import type { EmittedInterface } from './interfaces.js';

const execFileAsync = promisify(execFile);
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

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

export function tscPath(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

export function parseTscOutput(stdout: string, files: readonly EmittedInterface[]): Diagnostic[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const diagnostics: Diagnostic[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    const match = TSC_LINE.exec(line);
    const file = match === null ? undefined : byPath.get((match[1] ?? '').split(path.sep).join('/'));
    if (match === null || file === undefined) {
      diagnostics.push(error('concepts/', `tsc: ${line}`));
      continue;
    }
    const interfaceLine = Number(match[2]) - file.headerLines;
    const where = interfaceLine >= 1 ? `interface line ${interfaceLine}` : 'generated imports';
    diagnostics.push(error(file.conceptFile, `${where}: ${match[5]} (${match[4]})`, { line: 1 }));
  }
  return diagnostics;
}

async function runTsc(dir: string): Promise<string> {
  try {
    // TS 7 prints paths relative to $PWD, not the process cwd, so set both.
    await execFileAsync(process.execPath, [tscPath(), '-p', dir, '--pretty', 'false'], {
      cwd: dir,
      env: { ...process.env, PWD: dir },
    });
    return '';
  } catch (err) {
    if (err instanceof Error && 'stdout' in err && typeof err.stdout === 'string' && err.stdout !== '') {
      return err.stdout;
    }
    throw err;
  }
}

export async function typecheckInterfaces(files: readonly EmittedInterface[]): Promise<Diagnostic[]> {
  if (files.length === 0) {
    return [];
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-interfaces-'));
  try {
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
    await writeFile(path.join(dir, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
    await Promise.all(
      files.map(async (file) => {
        const full = path.join(dir, file.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.content);
      }),
    );
    return parseTscOutput(await runTsc(dir), files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
