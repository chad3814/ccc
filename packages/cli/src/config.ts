import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { error, warning, type Diagnostic } from './diagnostics.js';

export const CONFIG_FILE = 'ccc.config.ts';

// Models from weakest to strongest; escalation climbs one step at a time.
export const DEFAULT_LADDER: readonly string[] = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1'];

export type Artifact = 'impl' | 'tests';

// A plain model name is one fixed model; a range starts at `start` and
// escalates along the ladder, never past `cap`.
const modelChoice = z.union([z.string().min(1), z.strictObject({ start: z.string().min(1), cap: z.string().min(1) })]);

export const configSchema = z
  .strictObject({
    models: z
      .strictObject({
        impl: modelChoice.default({ start: 'claude-haiku-4-5', cap: 'claude-opus-5' }),
        tests: modelChoice.default({ start: 'claude-sonnet-5', cap: 'claude-opus-5' }),
      })
      .prefault({}),
    ladder: z.array(z.string().min(1)).min(1).default([...DEFAULT_LADDER]),
    // Failed attempts on one model before the next attempt moves up a step.
    escalateAfter: z.number().int().min(1).max(10).default(2),
    // Enough for implementations to climb from haiku to opus at escalateAfter 2.
    maxAttempts: z.number().int().min(1).max(10).default(6),
    testMaxAttempts: z.number().int().min(1).max(10).default(3),
    concurrency: z.number().int().min(1).max(16).default(4),
  })
  .superRefine((config, ctx) => {
    for (const artifact of ['impl', 'tests'] as const) {
      const choice = config.models[artifact];
      if (typeof choice === 'string') {
        continue;
      }
      const startAt = config.ladder.indexOf(choice.start);
      const capAt = config.ladder.indexOf(choice.cap);
      for (const [field, index] of [['start', startAt], ['cap', capAt]] as const) {
        if (index === -1) {
          ctx.addIssue({ code: 'custom', path: ['models', artifact, field], message: `'${choice[field]}' is not on the ladder` });
        }
      }
      if (startAt !== -1 && capAt !== -1 && startAt > capAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', artifact],
          message: `start '${choice.start}' is above cap '${choice.cap}' on the ladder`,
        });
      }
    }
  });

export type Config = z.output<typeof configSchema>;

// The models an artifact may use, in the order it tries them.
export function modelTiers(config: Config, artifact: Artifact): string[] {
  const choice = config.models[artifact];
  if (typeof choice === 'string') {
    return [choice];
  }
  return config.ladder.slice(config.ladder.indexOf(choice.start), config.ladder.indexOf(choice.cap) + 1);
}

// Attempts that stop before the cap make the cap unreachable, which is
// legal but almost never meant.
function reachWarnings(config: Config): Diagnostic[] {
  return (['impl', 'tests'] as const).flatMap((artifact) => {
    const tiers = modelTiers(config, artifact);
    const needed = config.escalateAfter * (tiers.length - 1) + 1;
    const attempts = artifact === 'impl' ? config.maxAttempts : config.testMaxAttempts;
    if (attempts >= needed) {
      return [];
    }
    const field = artifact === 'impl' ? 'maxAttempts' : 'testMaxAttempts';
    return [
      warning(
        CONFIG_FILE,
        `${field}: ${attempts} attempts escalating after every ${config.escalateAfter} never reach cap '${tiers.at(-1) ?? ''}' for ${artifact} (needs ${needed})`,
      ),
    ];
  });
}

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
    return { config: parsed.data, diagnostics: reachWarnings(parsed.data) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { config: defaults, diagnostics: [error(CONFIG_FILE, `cannot load config: ${message}`)] };
  }
}
