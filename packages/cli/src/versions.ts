import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { sha256 } from './hash.js';
import { runtimeVersion } from './runtimepkg.js';

export type PromptName = 'impl' | 'tests' | 'sync';


export interface Versions {
  implPrompt: string;
  testPrompt: string;
  syncPrompt: string;
  implModel: string;
  testModel: string;
  runtime: string;
}

// Prompts ship in packages/cli/prompts, one level above both src/ and dist/.
export async function readPrompt(name: PromptName): Promise<string> {
  return readFile(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
}

export async function loadVersions(config: Config): Promise<Versions> {
  const [impl, tests, sync] = await Promise.all([readPrompt('impl'), readPrompt('tests'), readPrompt('sync')]);
  return {
    implPrompt: await sha256(impl),
    testPrompt: await sha256(tests),
    syncPrompt: await sha256(sync),
    implModel: config.models.impl,
    testModel: config.models.tests,
    runtime: await runtimeVersion(),
  };
}
