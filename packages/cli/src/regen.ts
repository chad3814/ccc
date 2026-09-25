import { runCheck } from './check.js';
import { loadConfig } from './config.js';
import { error, hasErrors, type Diagnostic } from './diagnostics.js';
import { readFileOrNull } from './fsutil.js';
import { sha256 } from './hash.js';
import type { ConceptId } from './ids.js';
import { generateImpl } from './implgen.js';
import { collectExports } from './interfaces.js';
import { implKey } from './keys.js';
import { modulePath, testPath } from './layout.js';
import { lineDiff } from './linediff.js';
import type { Generator } from './llm.js';
import { isHandwritten } from './schema.js';
import { loadVersions } from './versions.js';

export interface RegenResult {
  diagnostics: Diagnostic[];
  passed: boolean;
  attempts: number;
  added: number;
  removed: number;
  costUsd: number | null;
}

// Spec §3.5: regenerate one implementation ignoring the cache, check it
// against the approved tests, and measure how far it drifts. Writes nothing.
export async function runRegen(root: string, id: ConceptId, generator: Generator): Promise<RegenResult> {
  const result: RegenResult = { diagnostics: [], passed: false, attempts: 0, added: 0, removed: 0, costUsd: null };
  const check = await runCheck(root);
  result.diagnostics.push(...check.diagnostics.filter((d) => d.severity === 'error'));
  const concept = check.project.concepts.get(id);
  if (concept === undefined) {
    result.diagnostics.push(error('concepts/', `unknown concept '${id}'`));
    return result;
  }
  if (isHandwritten(concept.frontmatter)) {
    result.diagnostics.push(error(concept.file, 'handwritten concepts are not generated'));
  }
  const testSource = await readFileOrNull(root, testPath(id));
  if (testSource === null) {
    result.diagnostics.push(error(concept.file, 'no tests exist for this concept; run ccc build first'));
  }
  const configResult = await loadConfig(root);
  result.diagnostics.push(...configResult.diagnostics);
  if (hasErrors(result.diagnostics) || testSource === null) {
    return result;
  }
  const exportsByConcept = collectExports(check.project);
  const versions = await loadVersions();
  const key = await implKey(concept, check.project, exportsByConcept, versions, await sha256(testSource));
  const committed = (await readFileOrNull(root, modulePath(id))) ?? '';
  const outcome = await generateImpl(
    { root, project: check.project, exportsByConcept, generator, config: configResult.config, now: Date.now },
    concept,
    testSource,
    { key, commit: false },
  );
  result.attempts = outcome.record.attempts;
  result.costUsd = outcome.record.costUsd;
  result.passed = outcome.source !== null;
  if (outcome.source !== null) {
    Object.assign(result, lineDiff(committed, outcome.source));
  }
  return result;
}
