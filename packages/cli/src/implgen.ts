import { modelTiers } from './config.js';
import { implRequest } from './context.js';
import { readFileOrNull, removeFile, writeFileAtomic } from './fsutil.js';
import { generationLoop, type GenerationOutcome } from './generation.js';
import { PACKAGES_BY_KIND, checkImports, moduleImportsFor } from './imports.js';
import { exportsOf } from './interfaces.js';
import { interfaceTextOf } from './keys.js';
import { conformancePath, generatedHeader, modulePath, testPath } from './layout.js';
import type { Concept } from './parse.js';
import type { GenerateContext } from './testgen.js';
import { lintFiles, runTests, typecheckFiles, type ToolIssue } from './toolchain.js';
import { readPrompt } from './versions.js';

export interface ImplOptions {
  key: string;
  commit: boolean;
}

function formatIssue(issue: ToolIssue): string {
  if (issue.file === '') {
    return issue.message;
  }
  return issue.line === null ? `${issue.file}: ${issue.message}` : `${issue.file}:${issue.line}: ${issue.message}`;
}

// The checks a module must pass where it sits in .ccc/gen: its own files
// type-check (including conformance to the interface), it lints clean, and
// its approved tests pass.
export async function checkModuleOnDisk(ctx: { root: string }, concept: Concept): Promise<string[]> {
  const module = modulePath(concept.id);
  const test = testPath(concept.id);
  const conformance = conformancePath(concept.id);
  const fm = concept.frontmatter;
  const lintTarget = fm.kind !== 'sync' && fm.implementation === 'handwritten' && fm.source !== undefined ? fm.source : module;
  const own = new Set([module, test, conformance, lintTarget]);
  const typeIssues = (await typecheckFiles(ctx.root, [module, conformance, test])).filter(
    (issue) => own.has(issue.file) || issue.file === '',
  );
  const lintIssues = await lintFiles(ctx.root, [lintTarget]);
  const run = await runTests(ctx.root, [test]);
  const problems = [
    ...typeIssues.map(formatIssue),
    ...lintIssues.map(formatIssue),
    ...run.errors.map(formatIssue),
    ...run.cases
      .filter((testCase) => testCase.status === 'failed')
      .map((testCase) => `test failed: ${testCase.name}: ${testCase.message.split('\n').slice(0, 6).join('\n')}`),
    ...run.cases.filter((testCase) => testCase.status === 'skipped').map((testCase) => `test skipped: ${testCase.name}`),
  ];
  if (problems.length === 0 && run.cases.length === 0) {
    problems.push(`no tests ran for ${test}`);
  }
  return problems;
}

async function restore(root: string, rel: string, original: string | null): Promise<void> {
  if (original === null) {
    await removeFile(root, rel);
  } else {
    await writeFileAtomic(root, rel, original);
  }
}

export async function generateImpl(
  ctx: GenerateContext,
  concept: Concept,
  testSource: string,
  options: ImplOptions,
): Promise<GenerationOutcome> {
  const target = modulePath(concept.id);
  const original = await readFileOrNull(ctx.root, target);
  const header = generatedHeader(concept.id, options.key);
  const withHeader = (code: string): string => `${header}\n${code.trimEnd()}\n`;
  let accepted = false;
  try {
    const outcome = await generationLoop({
      generator: ctx.generator,
      models: modelTiers(ctx.config, 'impl'),
      escalateAfter: ctx.config.escalateAfter,
      system: await readPrompt(concept.frontmatter.kind === 'sync' ? 'sync' : 'impl'),
      firstMessage: implRequest(concept, ctx.project, ctx.exportsByConcept, testSource),
      maxAttempts: ctx.config.maxAttempts,
      artifact: 'impl',
      now: ctx.now,
      check: async (code) => {
        const declared = new Set(exportsOf(interfaceTextOf(concept, ctx.exportsByConcept)).names);
        const shapeIssues = [
          ...checkImports(code, moduleImportsFor(concept, ctx.project), PACKAGES_BY_KIND[concept.frontmatter.kind]),
          ...exportsOf(code)
            .names.filter((name) => !declared.has(name))
            .map((name) => `exports ${name}, which is not in the interface`),
        ];
        if (shapeIssues.length > 0) {
          return shapeIssues;
        }
        await writeFileAtomic(ctx.root, target, withHeader(code));
        const problems = await checkModuleOnDisk(ctx, concept);
        if (problems.length > 0) {
          // Never leave a failing candidate in .ccc/gen while the model works
          // on the next attempt.
          await restore(ctx.root, target, original);
        }
        return problems;
      },
    });
    if (outcome.source === null) {
      return outcome;
    }
    accepted = options.commit;
    return { ...outcome, source: withHeader(outcome.source) };
  } finally {
    if (!accepted) {
      await restore(ctx.root, target, original);
    }
  }
}
