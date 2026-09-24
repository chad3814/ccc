import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { SCRATCH_DIR } from './layout.js';
import { parseTscLines, runTsc } from './tsc.js';

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

export interface ToolIssue {
  file: string;
  line: number | null;
  message: string;
}

function packageDir(name: string): string {
  return path.dirname(requireFromHere.resolve(`${name}/package.json`));
}

export function vitestGlobalsPath(): string {
  return path.join(packageDir('vitest'), 'globals.d.ts');
}

// Scratch space inside the project so module resolution still finds the
// project's node_modules.
export async function withScratch<T>(root: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const base = path.join(await realpath(root), SCRATCH_DIR);
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'run-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function toProjectPath(realRoot: string, absolute: string): string {
  return path.relative(realRoot, absolute).split(path.sep).join('/');
}

// Child tools inherit a clean environment: no Vitest variables from a parent
// test run, and PWD matching cwd (TS 7 prints paths relative to $PWD).
function childEnv(cwd: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  return { ...env, PWD: cwd };
}

interface ToolOutput {
  stdout: string;
  stderr: string;
}

async function runAllowingFailure(args: readonly string[], cwd: string): Promise<ToolOutput> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...args], {
      cwd,
      env: childEnv(cwd),
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
    });
    return { stdout, stderr };
  } catch (err) {
    if (err instanceof Error && 'stdout' in err && typeof err.stdout === 'string') {
      return { stdout: err.stdout, stderr: 'stderr' in err && typeof err.stderr === 'string' ? err.stderr : '' };
    }
    throw err;
  }
}

const GENERATED_COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  module: 'nodenext',
  moduleResolution: 'nodenext',
  target: 'es2024',
  lib: ['es2024', 'dom'],
  types: [],
  skipLibCheck: true,
};

export async function typecheckFiles(root: string, files: readonly string[]): Promise<ToolIssue[]> {
  const realRoot = await realpath(root);
  return withScratch(root, async (dir) => {
    const tsconfig = path.join(dir, 'tsconfig.json');
    await writeFile(
      tsconfig,
      JSON.stringify(
        {
          compilerOptions: GENERATED_COMPILER_OPTIONS,
          files: [vitestGlobalsPath(), ...files.map((file) => path.join(realRoot, file))],
        },
        null,
        2,
      ),
    );
    const { messages, other } = parseTscLines(await runTsc(tsconfig, dir));
    return [
      ...messages.map((m) => ({
        file: toProjectPath(realRoot, path.resolve(dir, m.file)),
        line: m.line,
        message: `${m.message} (${m.code})`,
      })),
      ...other.map((line) => ({ file: '', line: null, message: line })),
    ];
  });
}

const oxlintReportSchema = z.object({
  diagnostics: z.array(
    z.object({
      message: z.string(),
      code: z.string().default(''),
      severity: z.string().default('error'),
      filename: z.string(),
      labels: z.array(z.object({ span: z.object({ line: z.number() }) })).default([]),
    }),
  ),
});

export async function lintFiles(root: string, files: readonly string[]): Promise<ToolIssue[]> {
  if (files.length === 0) {
    return [];
  }
  const realRoot = await realpath(root);
  return withScratch(root, async (dir) => {
    const config = path.join(dir, 'oxlintrc.json');
    await writeFile(config, JSON.stringify({ plugins: ['typescript'], rules: { 'typescript/no-explicit-any': 'error' } }));
    const { stdout } = await runAllowingFailure(
      [path.join(packageDir('oxlint'), 'bin', 'oxlint'), '-c', config, '-f', 'json', ...files.map((f) => path.join(realRoot, f))],
      realRoot,
    );
    const report = oxlintReportSchema.parse(JSON.parse(stdout.slice(stdout.indexOf('{'))));
    return report.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => ({
        file: toProjectPath(realRoot, path.resolve(realRoot, d.filename)),
        line: d.labels[0]?.span.line ?? null,
        message: `${d.message} (${d.code})`,
      }));
  });
}

export interface TestCase {
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  message: string;
}

export interface TestRun {
  cases: TestCase[];
  errors: ToolIssue[];
}

const vitestReportSchema = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string().default(''),
      assertionResults: z
        .array(
          z.object({
            title: z.string(),
            status: z.string(),
            failureMessages: z.array(z.string()).nullable().default([]),
          }),
        )
        .default([]),
    }),
  ),
});

function caseStatus(status: string): TestCase['status'] {
  return status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped';
}

export async function runTests(root: string, testFiles: readonly string[]): Promise<TestRun> {
  if (testFiles.length === 0) {
    return { cases: [], errors: [] };
  }
  const realRoot = await realpath(root);
  return withScratch(root, async (dir) => {
    const config = path.join(dir, 'vitest.config.mjs');
    const report = path.join(dir, 'report.json');
    const settings = {
      cacheDir: path.join(dir, 'cache'),
      test: { globals: true, include: ['.ccc/gen/**/*.test.ts'], watch: false, testTimeout: 10_000 },
    };
    await writeFile(config, `export default ${JSON.stringify(settings)};\n`);
    const { stdout, stderr } = await runAllowingFailure(
      [
        path.join(packageDir('vitest'), 'vitest.mjs'),
        'run',
        '--root',
        realRoot,
        '--config',
        config,
        '--reporter=json',
        `--outputFile=${report}`,
        ...testFiles,
      ],
      realRoot,
    );
    const text = await readFile(report, 'utf8').catch(() => null);
    if (text === null) {
      return { cases: [], errors: [{ file: '', line: null, message: `vitest produced no report:\n${`${stdout}${stderr}`.slice(-2000)}` }] };
    }
    const parsed = vitestReportSchema.parse(JSON.parse(text));
    const cases: TestCase[] = [];
    const errors: ToolIssue[] = [];
    for (const result of parsed.testResults) {
      const file = toProjectPath(realRoot, await realpath(result.name).catch(() => result.name));
      if (result.assertionResults.length === 0 && result.status !== 'passed') {
        errors.push({ file, line: null, message: result.message || 'test file failed to run' });
      }
      for (const assertion of result.assertionResults) {
        cases.push({
          file,
          name: assertion.title,
          status: caseStatus(assertion.status),
          message: (assertion.failureMessages ?? []).join('\n'),
        });
      }
    }
    return { cases, errors };
  });
}
