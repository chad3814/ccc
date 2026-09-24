import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { runCheck } from './check.js';
import { formatDiagnostic } from './diagnostics.js';
import { VERSION } from './version.js';

export interface Io {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

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

async function checkCommand(root: string, io: Io): Promise<number> {
  const { project, diagnostics } = await runCheck(root);
  for (const d of diagnostics) {
    io.stdout(`${formatDiagnostic(d)}\n`);
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  io.stdout(`${summary(project.concepts.size, errors, warnings)}\n`);
  return errors > 0 ? 1 : 0;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = 0;
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
      exitCode = await checkCommand(path.resolve(io.cwd, options.dir), io);
    });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    throw err;
  }
  return exitCode;
}
