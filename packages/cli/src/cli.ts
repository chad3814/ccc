import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { AnthropicGenerator } from './anthropic.js';
import { approve, pendingApprovals, type PendingApproval } from './approve.js';
import { runBuild, type BuildResult } from './build.js';
import { runCheck } from './check.js';
import { SCHEMA_SQL_FILE } from './compose.js';
import { openPgDatabase, resetDatabase, type OpenedDatabase } from './dbreset.js';
import { formatDiagnostic, hasErrors, type Diagnostic } from './diagnostics.js';
import { readFileOrNull } from './fsutil.js';
import type { Generator } from './llm.js';
import { readManifest, writeManifest } from './manifest.js';
import { runRegen } from './regen.js';
import { computeStats, formatStats } from './stats.js';
import { runVerify } from './verify.js';
import { VERSION } from './version.js';

export interface Io {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  confirm?(question: string): Promise<boolean>;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface Services {
  generator(): Generator;
  openDatabase(url: string): Promise<OpenedDatabase>;
}

const defaultServices: Services = { generator: () => new AnthropicGenerator(), openDatabase: openPgDatabase };

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function summary(concepts: number, errors: number, warnings: number): string {
  const subject = plural(concepts, 'concept');
  if (errors === 0 && warnings === 0) {
    return `✓ ${subject}, no problems`;
  }
  return `${subject}: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`;
}

export function buildSummary(result: BuildResult): string {
  if (result.ok) {
    return `✓ build complete: ${result.generated.tests.length} test file(s) and ${result.generated.impl.length} implementation(s) generated`;
  }
  if (result.failed.length === 0 && result.skipped.length === 0) {
    return 'build failed; see the errors above';
  }
  return `build failed: ${result.failed.length} failed, ${result.skipped.length} skipped`;
}

function printDiagnostics(io: Io, diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    io.stdout(`${formatDiagnostic(d)}\n`);
  }
}

async function checkCommand(root: string, io: Io): Promise<number> {
  const { project, diagnostics } = await runCheck(root);
  printDiagnostics(io, diagnostics);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  io.stdout(`${summary(project.concepts.size, errors, warnings)}\n`);
  return errors > 0 ? 1 : 0;
}

interface BuildCommandOptions {
  only: string | undefined;
  dryRun: boolean;
  testsOnly: boolean;
}

async function buildCommand(root: string, io: Io, services: Services, options: BuildCommandOptions): Promise<number> {
  const result = await runBuild({
    root,
    generator: services.generator(),
    ...(options.only === undefined ? {} : { only: options.only }),
    dryRun: options.dryRun,
    testsOnly: options.testsOnly,
    log: (line) => io.stdout(`${line}\n`),
  });
  printDiagnostics(io, result.diagnostics);
  if (options.dryRun && result.ok) {
    for (const item of result.plan) {
      const what = [item.tests ? 'tests' : '', item.impl ? 'impl' : ''].filter((part) => part !== '').join('+') || 'up to date';
      io.stdout(`${what.padEnd(12)}${item.id}\n`);
    }
    const calls = result.plan.filter((item) => item.tests).length + result.plan.filter((item) => item.impl).length;
    io.stdout(`${calls} generation(s) planned\n`);
    return 0;
  }
  io.stdout(`${buildSummary(result)}\n`);
  return result.ok ? 0 : 1;
}

async function approveCommand(root: string, io: Io, options: { only: string | undefined; yes: boolean }): Promise<number> {
  const { manifest, diagnostics } = await readManifest(root);
  printDiagnostics(io, diagnostics);
  if (hasErrors(diagnostics)) {
    return 1;
  }
  const pending = await pendingApprovals(root, manifest, options.only);
  if (pending.length === 0) {
    io.stdout('nothing to approve\n');
    return 0;
  }
  const chosen: PendingApproval[] = [];
  for (const item of pending) {
    io.stdout(`\n=== ${item.file} (${item.id}) ===\n${item.source}\n`);
    if (item.edited) {
      io.stdout('this file was edited after generation; regenerate it with ccc tests instead\n');
      continue;
    }
    if (options.yes || (io.confirm !== undefined && (await io.confirm(`approve tests for ${item.id}?`)))) {
      chosen.push(item);
    }
  }
  if (!options.yes && io.confirm === undefined) {
    io.stdout('re-run with --yes to approve\n');
    return 1;
  }
  approve(manifest, chosen);
  await writeManifest(root, manifest);
  io.stdout(`approved ${chosen.length} of ${pending.length}\n`);
  return chosen.length === pending.length ? 0 : 1;
}

async function verifyCommand(root: string, io: Io): Promise<number> {
  const { diagnostics } = await runVerify(root);
  printDiagnostics(io, diagnostics);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  io.stdout(errors === 0 ? '✓ verified: generated code is current, approved, and passing\n' : `verify failed: ${errors} problem(s)\n`);
  return errors === 0 ? 0 : 1;
}

async function statsCommand(root: string, io: Io): Promise<number> {
  const { manifest, diagnostics } = await readManifest(root);
  printDiagnostics(io, diagnostics);
  if (hasErrors(diagnostics)) {
    return 1;
  }
  io.stdout(`${formatStats(computeStats(manifest))}\n`);
  return 0;
}

async function regenCommand(root: string, io: Io, services: Services, id: string): Promise<number> {
  const result = await runRegen(root, id, services.generator());
  printDiagnostics(io, result.diagnostics);
  if (hasErrors(result.diagnostics)) {
    return 1;
  }
  const cost = result.costUsd === null ? 'unknown' : `$${result.costUsd.toFixed(4)}`;
  io.stdout(
    result.passed
      ? `regen ${id}: passed the approved tests in ${result.attempts} attempt(s); diff vs committed: +${result.added} -${result.removed} lines; cost ${cost}\n`
      : `regen ${id}: FAILED after ${result.attempts} attempt(s); cost ${cost}\n`,
  );
  return result.passed ? 0 : 1;
}

async function dbResetCommand(root: string, io: Io, services: Services): Promise<number> {
  const url = io.env?.DATABASE_URL;
  if (url === undefined || url === '') {
    io.stdout('error: set DATABASE_URL to the database to reset\n');
    return 1;
  }
  const schema = await readFileOrNull(root, SCHEMA_SQL_FILE);
  if (schema === null) {
    io.stdout(`error: no ${SCHEMA_SQL_FILE}; run ccc build first\n`);
    return 1;
  }
  const opened = await services.openDatabase(url);
  try {
    await resetDatabase(opened.db, schema);
  } finally {
    await opened.close();
  }
  io.stdout(`✓ database reset from ${SCHEMA_SQL_FILE}\n`);
  return 0;
}

export async function main(argv: readonly string[], io: Io, services: Services = defaultServices): Promise<number> {
  let exitCode = 0;
  const rootOf = (dir: string): string => path.resolve(io.cwd, dir);
  const program = new Command('ccc')
    .description('chris-chad-concepts: compile concept models into code')
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  program
    .command('check')
    .description('validate the concept model (no LLM calls)')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string }) => {
      exitCode = await checkCommand(rootOf(options.dir), io);
    });
  program
    .command('build [concept]')
    .description('generate tests and implementations for stale concepts')
    .option('-C, --dir <path>', 'project root', '.')
    .option('--dry-run', 'show what would be generated, without calling the LLM', false)
    .action(async (concept: string | undefined, options: { dir: string; dryRun: boolean }) => {
      exitCode = await buildCommand(rootOf(options.dir), io, services, { only: concept, dryRun: options.dryRun, testsOnly: false });
    });
  program
    .command('tests [concept]')
    .description('generate tests only')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (concept: string | undefined, options: { dir: string }) => {
      exitCode = await buildCommand(rootOf(options.dir), io, services, { only: concept, dryRun: false, testsOnly: true });
    });
  program
    .command('approve [concept]')
    .description('review and approve generated test files')
    .option('-C, --dir <path>', 'project root', '.')
    .option('-y, --yes', 'approve without asking', false)
    .action(async (concept: string | undefined, options: { dir: string; yes: boolean }) => {
      exitCode = await approveCommand(rootOf(options.dir), io, { only: concept, yes: options.yes });
    });
  program
    .command('verify')
    .description('CI gate: generated code is current, approved, and passing (no LLM calls)')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string }) => {
      exitCode = await verifyCommand(rootOf(options.dir), io);
    });
  program
    .command('stats')
    .description('generation pass rates and cost from the manifest')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string }) => {
      exitCode = await statsCommand(rootOf(options.dir), io);
    });
  program
    .command('regen')
    .description('regenerate one implementation ignoring the cache and compare it (writes nothing)')
    .requiredOption('--compare <concept>', 'concept to regenerate')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string; compare: string }) => {
      exitCode = await regenCommand(rootOf(options.dir), io, services, options.compare);
    });
  program
    .command('db')
    .description('development database commands')
    .command('reset')
    .description('drop everything in DATABASE_URL and apply .ccc/gen/schema.sql')
    .option('-C, --dir <path>', 'project root', '.')
    .action(async (options: { dir: string }) => {
      exitCode = await dbResetCommand(rootOf(options.dir), io, services);
    });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  return exitCode;
}
