import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { AnthropicGenerator } from './anthropic.js';
import { approve, pendingApprovals, type PendingApproval } from './approve.js';
import { runBuild, type BuildResult } from './build.js';
import { runCheck } from './check.js';
import { formatDiagnostic, hasErrors, type Diagnostic } from './diagnostics.js';
import type { Generator } from './llm.js';
import { readManifest, writeManifest } from './manifest.js';
import { runVerify } from './verify.js';
import { VERSION } from './version.js';

export interface Io {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  confirm?(question: string): Promise<boolean>;
}

export interface Services {
  generator(): Generator;
}

const defaultServices: Services = { generator: () => new AnthropicGenerator() };

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
