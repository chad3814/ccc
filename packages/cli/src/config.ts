import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { error, type Diagnostic } from './diagnostics.js';

export const DEFAULT_MODEL = 'claude-opus-5';
export const CONFIG_FILE = 'ccc.config.ts';

export const configSchema = z.strictObject({
  models: z
    .strictObject({
      impl: z.string().min(1).default(DEFAULT_MODEL),
      tests: z.string().min(1).default(DEFAULT_MODEL),
    })
    .prefault({}),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  testMaxAttempts: z.number().int().min(1).max(10).default(3),
  concurrency: z.number().int().min(1).max(16).default(4),
});

export type Config = z.output<typeof configSchema>;

export interface ConfigResult {
  config: Config;
  diagnostics: Diagnostic[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// Node 24 strips TypeScript types on import. The query string defeats the
// module cache so a changed config is re-read within one process.
async function importDefault(file: string) {
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return mod.default;
}

export async function loadConfig(root: string): Promise<ConfigResult> {
  const defaults = configSchema.parse({});
  const file = path.join(root, CONFIG_FILE);
  if (!(await exists(file))) {
    return { config: defaults, diagnostics: [] };
  }
  try {
    const parsed = configSchema.safeParse(await importDefault(file));
    if (!parsed.success) {
      return {
        config: defaults,
        diagnostics: parsed.error.issues.map((issue) =>
          error(CONFIG_FILE, `${issue.path.map(String).join('.') || 'config'}: ${issue.message}`),
        ),
      };
    }
    return { config: parsed.data, diagnostics: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { config: defaults, diagnostics: [error(CONFIG_FILE, `cannot load config: ${message}`)] };
  }
}
