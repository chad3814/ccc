import { runCheck } from './check.js';
import { loadConfig } from './config.js';
import { error, hasErrors, warning, type Diagnostic } from './diagnostics.js';
import { deterministicWrites, emitDeterministicFiles, expectedFiles } from './emit.js';
import { fileHash, readFileOrNull, writeFileAtomic } from './fsutil.js';
import type { GenerationOutcome } from './generation.js';
import { dependenciesOf } from './graph.js';
import { sha256 } from './hash.js';
import type { ConceptId } from './ids.js';
import { SERVER_FILE, WIRING_FILE } from './compose.js';
import { checkModuleOnDisk, generateImpl } from './implgen.js';
import { collectExports } from './interfaces.js';
import { implKey, testKey, type ExportsByConcept } from './keys.js';
import { modulePath, testPath } from './layout.js';
import type { Generator } from './llm.js';
import type { Project } from './load.js';
import { entryFor, hashFiles, listCccFiles, readManifest, writeManifest, type Manifest } from './manifest.js';
import type { Concept } from './parse.js';
import { dependencyClosure, topologicalLevels } from './order.js';
import { mapPool } from './pool.js';
import { isHandwritten } from './schema.js';
import { generateTests, type GenerateContext } from './testgen.js';
import { runTests, typecheckFiles } from './toolchain.js';
import { loadVersions, type Versions } from './versions.js';

export { dependencyClosure, topologicalLevels } from './order.js';

export interface BuildOptions {
  root: string;
  generator: Generator;
  only?: ConceptId;
  dryRun?: boolean;
  testsOnly?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PlanItem {
  id: ConceptId;
  tests: boolean;
  impl: boolean;
}

export interface BuildResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  plan: PlanItem[];
  generated: { tests: ConceptId[]; impl: ConceptId[] };
  failed: ConceptId[];
  skipped: ConceptId[];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface PlanState {
  item: PlanItem;
  testKey: string;
}

async function isModuleCurrent(
  root: string,
  manifest: Manifest,
  concept: Concept,
  key: string,
): Promise<boolean> {
  const entry = manifest.concepts[concept.id];
  const moduleHash = await fileHash(root, modulePath(concept.id));
  return entry?.implKey === key && moduleHash !== null && manifest.files[modulePath(concept.id)] === moduleHash;
}

async function planBuild(
  root: string,
  project: Project,
  exportsByConcept: ExportsByConcept,
  versions: Versions,
  manifest: Manifest,
  scope: ReadonlySet<ConceptId>,
): Promise<Map<ConceptId, PlanState>> {
  const states = new Map<ConceptId, PlanState>();
  for (const id of [...scope].sort(compareIds)) {
    const concept = project.concepts.get(id);
    if (concept === undefined) {
      continue;
    }
    const entry = manifest.concepts[id];
    const key = await testKey(concept, project, exportsByConcept, versions);
    const testHash = await fileHash(root, testPath(id));
    const tests = entry === undefined || entry.testKey !== key || testHash === null || testHash !== entry.testFileHash;
    let impl = false;
    if (!isHandwritten(concept.frontmatter)) {
      impl =
        tests ||
        testHash === null ||
        !(await isModuleCurrent(root, manifest, concept, await implKey(concept, project, exportsByConcept, versions, testHash)));
    }
    states.set(id, { item: { id, tests, impl }, testKey: key });
  }
  return states;
}

function bullets(problems: readonly string[]): string {
  return problems
    .slice(0, 10)
    .map((problem) => `  - ${problem.split('\n').join('\n    ')}`)
    .join('\n');
}

function generationFailure(concept: Concept, artifact: 'tests' | 'impl', outcome: GenerationOutcome): Diagnostic {
  const what = artifact === 'tests' ? 'test' : 'implementation';
  return error(
    concept.file,
    `${what} generation failed after ${outcome.record.attempts} attempt(s); last problems:\n${bullets(outcome.problems)}`,
  );
}

function firstLines(text: string): string {
  return text.split('\n').slice(0, 6).join('\n');
}

// Record fresh hashes only for files this build wrote. Every other file keeps
// its previous hash (a mismatch stays visible to build and verify), an
// unrecorded file stays unrecorded, and entries for deleted concepts go.
async function finalizeManifest(root: string, project: Project, manifest: Manifest, touched: ReadonlySet<string>): Promise<void> {
  const onDisk = await listCccFiles(root);
  const fresh = await hashFiles(
    root,
    onDisk.filter((file) => touched.has(file)),
  );
  const expected = expectedFiles(project);
  const files: Record<string, string> = {};
  for (const file of onDisk) {
    const recorded = touched.has(file) ? fresh[file] : manifest.files[file];
    if (recorded !== undefined) {
      files[file] = recorded;
    }
  }
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (files[file] === undefined && expected.has(file) && !onDisk.includes(file)) {
      files[file] = hash;
    }
  }
  manifest.files = files;
  for (const id of Object.keys(manifest.concepts)) {
    if (!project.concepts.has(id)) {
      delete manifest.concepts[id];
    }
  }
  await writeManifest(root, manifest);
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const { root } = options;
  const log = options.log ?? ((): void => undefined);
  const now = options.now ?? Date.now;
  const result: BuildResult = { ok: false, diagnostics: [], plan: [], generated: { tests: [], impl: [] }, failed: [], skipped: [] };

  const check = await runCheck(root);
  result.diagnostics.push(...check.diagnostics);
  const project = check.project;
  for (const concept of project.concepts.values()) {
    if (concept.examples.length === 0) {
      result.diagnostics.push(error(concept.file, "ccc build requires at least one example in '## Examples'"));
    }
  }
  const configResult = await loadConfig(root);
  const manifestResult = await readManifest(root);
  result.diagnostics.push(...configResult.diagnostics, ...manifestResult.diagnostics);
  if (options.only !== undefined && !project.concepts.has(options.only)) {
    result.diagnostics.push(error('concepts/', `unknown concept '${options.only}'`));
  }
  if (hasErrors(result.diagnostics)) {
    return result;
  }

  const { config } = configResult;
  const { manifest } = manifestResult;
  const exportsByConcept = collectExports(project);
  const versions = await loadVersions(config);
  const scope = options.only === undefined ? new Set(project.concepts.keys()) : dependencyClosure(project, options.only);
  const states = await planBuild(root, project, exportsByConcept, versions, manifest, scope);
  result.plan = [...states.values()].map((state) => state.item);
  if (options.dryRun === true) {
    result.ok = true;
    return result;
  }

  result.diagnostics.push(...(await emitDeterministicFiles(root, project, exportsByConcept)));
  if (hasErrors(result.diagnostics)) {
    return result;
  }
  const ctx: GenerateContext = { root, project, exportsByConcept, generator: options.generator, config, now };
  const failed = new Set<ConceptId>();
  const skipped = new Set<ConceptId>();
  // Files this build wrote (or emitted deterministically); only these get
  // fresh hashes in the manifest, so hand edits elsewhere stay detectable.
  const touched = new Set(deterministicWrites(project, exportsByConcept).writes.map(([file]) => file));

  try {
    // Stage 3: tests, all concepts in parallel (tests depend only on interfaces).
    await mapPool(
      [...states.values()].filter((state) => state.item.tests),
      config.concurrency,
      async (state) => {
        const concept = project.concepts.get(state.item.id);
        if (concept === undefined) {
          return;
        }
        const entry = entryFor(manifest, concept.id);
        const outcome = await generateTests(ctx, concept);
        entry.history.push(outcome.record);
        if (outcome.source === null) {
          failed.add(concept.id);
          result.diagnostics.push(generationFailure(concept, 'tests', outcome));
          log(`tests  ${concept.id}  FAILED`);
          return;
        }
        await writeFileAtomic(root, testPath(concept.id), outcome.source);
        touched.add(testPath(concept.id));
        entry.testKey = state.testKey;
        entry.testFileHash = await sha256(outcome.source);
        entry.approvedTestHash = null;
        result.generated.tests.push(concept.id);
        log(`tests  ${concept.id}  generated in ${outcome.record.attempts} attempt(s), pending approval`);
      },
    );

    // Stage 4: implementations, level by level so dependencies exist first.
    if (options.testsOnly !== true) {
      for (const level of topologicalLevels(project)) {
        await mapPool(
          level.filter((id) => scope.has(id)),
          config.concurrency,
          async (id) => {
            const concept = project.concepts.get(id);
            if (concept === undefined || failed.has(id)) {
              return;
            }
            const blocker = dependenciesOf(concept, project).find((dep) => failed.has(dep) || skipped.has(dep));
            if (blocker !== undefined) {
              skipped.add(id);
              result.diagnostics.push(warning(concept.file, `skipped: dependency '${blocker}' did not build`));
              return;
            }
            const testSource = await readFileOrNull(root, testPath(id));
            if (testSource === null) {
              failed.add(id);
              result.diagnostics.push(error(concept.file, 'no tests exist for this concept; run ccc tests'));
              return;
            }
            if (isHandwritten(concept.frontmatter)) {
              const problems = await checkModuleOnDisk(ctx, concept);
              if (problems.length > 0) {
                failed.add(id);
                result.diagnostics.push(error(concept.file, `handwritten module fails its checks:\n${bullets(problems)}`));
              }
              return;
            }
            const key = await implKey(concept, project, exportsByConcept, versions, await sha256(testSource));
            if (await isModuleCurrent(root, manifest, concept, key)) {
              return;
            }
            const entry = entryFor(manifest, id);
            const outcome = await generateImpl(ctx, concept, testSource, { key, commit: true });
            entry.history.push(outcome.record);
            if (outcome.source === null) {
              failed.add(id);
              result.diagnostics.push(generationFailure(concept, 'impl', outcome));
              log(`impl   ${id}  FAILED`);
              return;
            }
            entry.implKey = key;
            touched.add(modulePath(id));
            result.generated.impl.push(id);
            log(`impl   ${id}  generated in ${outcome.record.attempts} attempt(s)`);
          },
        );
      }

      // Stage 5: the composition files must type-check against what was built.
      if (failed.size === 0 && skipped.size === 0) {
        const composition = new Set([WIRING_FILE, SERVER_FILE]);
        for (const issue of await typecheckFiles(root, [...composition])) {
          if (composition.has(issue.file) || issue.file === '') {
            result.diagnostics.push(
              error(issue.file || WIRING_FILE, `composition: ${issue.line === null ? '' : `line ${issue.line}: `}${issue.message}`),
            );
          }
        }
      }

      // Stage 6: the full suite, which exercises cross-concept behavior.
      const testFiles: string[] = [];
      for (const id of project.concepts.keys()) {
        if ((await fileHash(root, testPath(id))) !== null) {
          testFiles.push(testPath(id));
        }
      }
      const run = await runTests(root, testFiles);
      for (const issue of run.errors) {
        result.diagnostics.push(error(issue.file || 'concepts/', `test file failed to run: ${firstLines(issue.message)}`));
      }
      for (const testCase of run.cases.filter((c) => c.status === 'failed')) {
        result.diagnostics.push(error(testCase.file, `test failed: ${testCase.name}: ${firstLines(testCase.message)}`));
      }
    }
  } finally {
    // Written even if a stage throws, so completed work isn't redone.
    await finalizeManifest(root, project, manifest, touched);
  }
  result.failed = [...failed].sort(compareIds);
  result.skipped = [...skipped].sort(compareIds);
  result.generated.tests.sort(compareIds);
  result.generated.impl.sort(compareIds);
  result.ok = !hasErrors(result.diagnostics);
  return result;
}
