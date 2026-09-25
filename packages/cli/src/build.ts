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
import { GeneratorUnavailable, type Generator } from './llm.js';
import type { Project } from './load.js';
import { entryFor, hashFiles, listCccFiles, readManifest, writeManifest, type Manifest, type ManifestEntry } from './manifest.js';
import type { Concept } from './parse.js';
import { topologicalLevels } from './order.js';
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
  // Regenerate `only` (or every concept) regardless of the cache: its tests
  // when testsOnly, otherwise its implementation. Approved tests are never
  // replaced by a fresh build.
  fresh?: boolean;
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

// What a concept needs built before it. An endpoint's tests run the whole
// app, and createApp imports every adapter while wiring imports every sync,
// so an endpoint depends on all of those too.
function buildDependencies(concept: Concept, project: Project): ConceptId[] {
  const direct = dependenciesOf(concept, project);
  if (concept.frontmatter.kind !== 'endpoint') {
    return direct;
  }
  const composed = [...project.concepts.values()]
    .filter((c) => ['store', 'auth', 'sync'].includes(c.frontmatter.kind))
    .map((c) => c.id);
  return [...new Set([...direct, ...composed])].sort(compareIds);
}

function buildClosure(project: Project, id: ConceptId): Set<ConceptId> {
  const seen = new Set<ConceptId>();
  const queue = [id];
  while (queue.length > 0) {
    const next = queue.pop();
    const concept = next === undefined ? undefined : project.concepts.get(next);
    if (next === undefined || concept === undefined || seen.has(next)) {
      continue;
    }
    seen.add(next);
    queue.push(...buildDependencies(concept, project));
  }
  return seen;
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
  fresh: { tests: ReadonlySet<ConceptId>; impl: ReadonlySet<ConceptId> },
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
    const tests =
      fresh.tests.has(id) || entry === undefined || entry.testKey !== key || testHash === null || testHash !== entry.testFileHash;
    let impl = false;
    if (!isHandwritten(concept.frontmatter)) {
      impl =
        tests ||
        fresh.impl.has(id) ||
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

const FAILED_TEST = /^test failed: (\[ex \d+\])/;

// When every attempt that got as far as the tests failed the same unapproved
// test (and at least two did), the test itself may be wrong; no
// implementation can pass it, so say where to look. Attempts that failed
// earlier (type errors, imports) never ran the tests and don't count.
function unapprovedTestHint(concept: Concept, outcome: GenerationOutcome, entry: ManifestEntry | undefined): string | undefined {
  const failing = outcome.attemptProblems.map(
    (problems) =>
      new Set(
        problems.flatMap((problem) => {
          const match = FAILED_TEST.exec(problem);
          return match?.[1] === undefined ? [] : [match[1]];
        }),
      ),
  );
  const ran = failing.filter((tags) => tags.size > 0);
  const first = ran[0];
  if (first === undefined || ran.length < 2 || entry === undefined || entry.approvedTestHash === entry.testFileHash) {
    return undefined;
  }
  const common = [...first].filter((tag) => ran.every((tags) => tags.has(tag)));
  if (common.length === 0) {
    return undefined;
  }
  return `every attempt that ran the tests failed ${common.join(', ')}, and these tests are not approved yet; review ${testPath(concept.id)}. If a test is wrong, delete the file and run \`ccc tests ${concept.id}\` to regenerate it`;
}

function generationFailure(
  concept: Concept,
  artifact: 'tests' | 'impl',
  outcome: GenerationOutcome,
  entry?: ManifestEntry,
): Diagnostic {
  const what = artifact === 'tests' ? 'test' : 'implementation';
  const hint = artifact === 'impl' ? unapprovedTestHint(concept, outcome, entry) : undefined;
  return error(
    concept.file,
    `${what} generation failed after ${outcome.record.attempts} attempt(s); last problems:\n${bullets(outcome.problems)}`,
    hint === undefined ? {} : { hint },
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
  const versions = await loadVersions();
  const scope = options.only === undefined ? new Set(project.concepts.keys()) : buildClosure(project, options.only);
  const freshIds = options.fresh === true ? (options.only === undefined ? scope : new Set([options.only])) : new Set<ConceptId>();
  const none = new Set<ConceptId>();
  const fresh = options.testsOnly === true ? { tests: freshIds, impl: none } : { tests: none, impl: freshIds };
  const states = await planBuild(root, project, exportsByConcept, versions, manifest, scope, fresh);
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
  // Set when the generator can't serve anything; no further work is scheduled.
  const halt: { reason: GeneratorUnavailable | null } = { reason: null };
  const stopOn = (err: Error): void => {
    if (!(err instanceof GeneratorUnavailable)) {
      throw err;
    }
    halt.reason ??= err;
  };

  try {
    // Stage 3: tests, all concepts in parallel (tests depend only on interfaces).
    await mapPool(
      [...states.values()].filter((state) => state.item.tests),
      config.concurrency,
      async (state) => {
        const concept = project.concepts.get(state.item.id);
        if (concept === undefined || halt.reason !== null) {
          return;
        }
        let outcome;
        try {
          outcome = await generateTests(ctx, concept);
        } catch (err) {
          stopOn(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const entry = entryFor(manifest, concept.id);
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
        if (halt.reason !== null) {
          break;
        }
        await mapPool(
          level.filter((id) => scope.has(id)),
          config.concurrency,
          async (id) => {
            const concept = project.concepts.get(id);
            if (concept === undefined || failed.has(id) || halt.reason !== null) {
              return;
            }
            const blocker = buildDependencies(concept, project).find((dep) => failed.has(dep) || skipped.has(dep));
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
            if (!fresh.impl.has(id) && (await isModuleCurrent(root, manifest, concept, key))) {
              return;
            }
            let outcome;
            try {
              outcome = await generateImpl(ctx, concept, testSource, { key, commit: true });
            } catch (err) {
              stopOn(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            const entry = entryFor(manifest, id);
            entry.history.push(outcome.record);
            if (outcome.source === null) {
              failed.add(id);
              result.diagnostics.push(generationFailure(concept, 'impl', outcome, entry));
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
      // They reference every adapter, sync, and endpoint, so only a complete
      // build can check them.
      if (halt.reason === null && failed.size === 0 && skipped.size === 0 && scope.size === project.concepts.size) {
        const composition = new Set([WIRING_FILE, SERVER_FILE]);
        for (const issue of await typecheckFiles(root, [...composition])) {
          if (composition.has(issue.file) || issue.file === '') {
            result.diagnostics.push(
              error(issue.file || WIRING_FILE, `composition: ${issue.line === null ? '' : `line ${issue.line}: `}${issue.message}`),
            );
          }
        }
      }

      if (halt.reason === null) {
        // Stage 6: the full suite, which exercises cross-concept behavior.
        const testFiles: string[] = [];
        for (const id of project.concepts.keys()) {
          // Failed and skipped concepts were already reported; their tests
          // would only add missing-module noise.
          if (!failed.has(id) && !skipped.has(id) && (await fileHash(root, testPath(id))) !== null) {
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
    }
  } finally {
    // Written even if a stage throws, so completed work isn't redone.
    await finalizeManifest(root, project, manifest, touched);
  }
  result.failed = [...failed].sort(compareIds);
  result.skipped = [...skipped].sort(compareIds);
  result.generated.tests.sort(compareIds);
  result.generated.impl.sort(compareIds);
  if (halt.reason !== null) {
    result.diagnostics.push(error('concepts/', `build stopped: ${halt.reason.message}`));
  }
  result.ok = !hasErrors(result.diagnostics);
  return result;
}
