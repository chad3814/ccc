import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export interface TscMessage {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface TscOutput {
  messages: TscMessage[];
  other: string[];
}

export function tscPath(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

// tsc prints one line per error; elaborations follow on indented lines.
export function parseTscLines(stdout: string): TscOutput {
  const messages: TscMessage[] = [];
  const other: string[] = [];
  for (const raw of stdout.split('\n')) {
    if (raw.trim() === '') {
      continue;
    }
    const match = TSC_LINE.exec(raw);
    if (match !== null) {
      messages.push({
        file: (match[1] ?? '').split(path.sep).join('/'),
        line: Number(match[2]),
        column: Number(match[3]),
        code: match[4] ?? '',
        message: match[5] ?? '',
      });
      continue;
    }
    const last = messages.at(-1);
    if (/^\s/.test(raw) && last !== undefined) {
      last.message = `${last.message}\n${raw.trim()}`;
      continue;
    }
    other.push(raw.trim());
  }
  return { messages, other };
}

// Runs TypeScript 7's tsc on a project and returns its diagnostics output.
export async function runTsc(project: string, cwd: string): Promise<string> {
  try {
    // TS 7 prints paths relative to $PWD, not the process cwd, so set both.
    await execFileAsync(process.execPath, [tscPath(), '-p', project, '--pretty', 'false'], {
      cwd,
      env: { ...process.env, PWD: cwd },
      maxBuffer: 16 * 1024 * 1024,
    });
    return '';
  } catch (err) {
    if (err instanceof Error && 'stdout' in err && typeof err.stdout === 'string' && err.stdout !== '') {
      return err.stdout;
    }
    throw err;
  }
}
