import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { SCHEMA_DECLARATION, SERVER_DECLARATION } from './compose.js';
import { testRequest } from './context.js';
import { generationLoop, type GenerationOutcome } from './generation.js';
import { TEST_PACKAGES, checkImports, testImportsFor, transitiveDependencies } from './imports.js';
import { emitInterfaces } from './interfaces.js';
import type { ExportsByConcept } from './keys.js';
import type { Generator } from './llm.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { typecheckFiles, withScratch } from './toolchain.js';
import { readPrompt } from './versions.js';

export interface GenerateContext {
  root: string;
  project: Project;
  exportsByConcept: ExportsByConcept;
  generator: Generator;
  config: Config;
  now: () => number;
}

const TAG = /\b(?:it|test)(?:\.\w+)?\(\s*(['"`])\[ex (\d+)\]/g;

export function exampleTags(source: string): number[] {
  return [...source.matchAll(TAG)].map((match) => Number(match[2])).sort((a, b) => a - b);
}

const MODIFIER = /\b(?:it|test|describe)\.(skip|todo|only|fails)\b/g;

// Every example must actually run: a skipped test verifies nothing.
export function modifierProblems(source: string): string[] {
  const found = [...new Set([...source.matchAll(MODIFIER)].map((match) => match[1] ?? ''))];
  return found.length === 0 ? [] : [`tests must not use .${found.join(', .')} (every example must run)`];
}

export function tagProblems(tags: readonly number[], count: number): string[] {
  if (tags.length === count && tags.every((tag, index) => tag === index + 1)) {
    return [];
  }
  const found = tags.length === 0 ? 'no tags' : tags.map((tag) => `[ex ${tag}]`).join(', ');
  return [`write exactly one test per example, tagged [ex 1] through [ex ${count}]; found ${found}`];
}

// Tests are checked against interfaces only: every interface is written at
// its generated-module path in scratch space, so './hand.js' resolves to the
// declarations, not an implementation.
async function typecheckAgainstInterfaces(ctx: GenerateContext, concept: Concept, source: string): Promise<string[]> {
  const realRoot = await realpath(ctx.root);
  const interfaces = emitInterfaces(ctx.project, ctx.exportsByConcept).files;
  return withScratch(ctx.root, async (dir) => {
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
    await Promise.all(
      interfaces.map(async (file) => {
        const full = path.join(dir, file.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.content);
      }),
    );
    await writeFile(path.join(dir, 'schema.d.ts'), SCHEMA_DECLARATION);
    await writeFile(path.join(dir, 'server.d.ts'), SERVER_DECLARATION);
    const testFile = path.join(dir, `${concept.id.split('.').join('/')}.test.ts`);
    await mkdir(path.dirname(testFile), { recursive: true });
    await writeFile(testFile, source);
    const rel = path.relative(realRoot, testFile).split(path.sep).join('/');
    const issues = await typecheckFiles(ctx.root, [rel]);
    return issues
      .filter((issue) => issue.file === rel || issue.file === '')
      .map((issue) => (issue.line === null ? issue.message : `line ${issue.line}: ${issue.message}`));
  });
}

export async function checkTestSource(ctx: GenerateContext, concept: Concept, source: string): Promise<string[]> {
  const problems = [
    ...tagProblems(exampleTags(source), concept.examples.length),
    ...modifierProblems(source),
    ...checkImports(source, testImportsFor(concept, ctx.project), TEST_PACKAGES),
  ];
  return problems.length > 0 ? problems : typecheckAgainstInterfaces(ctx, concept, source);
}

export async function generateTests(ctx: GenerateContext, concept: Concept): Promise<GenerationOutcome> {
  return generationLoop({
    generator: ctx.generator,
    model: ctx.config.models.tests,
    system: await readPrompt('tests'),
    firstMessage: testRequest(concept, ctx.project, ctx.exportsByConcept, transitiveDependencies(concept, ctx.project)),
    maxAttempts: ctx.config.testMaxAttempts,
    artifact: 'tests',
    now: ctx.now,
    check: (code) => checkTestSource(ctx, concept, code),
  });
}
