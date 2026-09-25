import { readFile } from 'node:fs/promises';
import { runtimeVersion } from './runtimepkg.js';

export type PromptName = 'impl' | 'tests' | 'sync';

// What cached output depends on besides the concepts. Models and prompts are
// deliberately absent: generated code is current as long as it passes its
// tests, whoever wrote it. `ccc build --fresh` regenerates on purpose.
export interface Versions {
  runtime: string;
}

// Prompts ship in packages/cli/prompts, one level above both src/ and dist/.
export async function readPrompt(name: PromptName): Promise<string> {
  return readFile(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
}

export async function loadVersions(): Promise<Versions> {
  return { runtime: await runtimeVersion() };
}
