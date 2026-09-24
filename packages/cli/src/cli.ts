import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { AnthropicGenerator } from './anthropic.js';
import { runBuild, type BuildResult } from './build.js';
import { runCheck } from './check.js';
import { formatDiagnostic, type Diagnostic } from './diagnostics.js';
import type { Generator } from './llm.js';
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
