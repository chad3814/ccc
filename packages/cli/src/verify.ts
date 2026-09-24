import { runCheck } from './check.js';
import { loadConfig } from './config.js';
import { error, hasErrors, sortDiagnostics, type Diagnostic } from './diagnostics.js';
import { collectExports } from './interfaces.js';
import { implKey, testKey } from './keys.js';
import { testPath } from './layout.js';
import { hashFiles, listCccFiles, readManifest } from './manifest.js';
import { isHandwritten } from './schema.js';
import { runTests } from './toolchain.js';
import { loadVersions } from './versions.js';

// The CI gate from spec §6. Never calls the LLM.
export async function runVerify(root: string): Promise<{ diagnostics: Diagnostic[] }> {
  const check = await runCheck(root);
  const diagnostics: Diagnostic[] = [...check.diagnostics];
  if (hasErrors(diagnostics)) {
    return { diagnostics: sortDiagnostics(diagnostics) };
  }
  const manifestResult = await readManifest(root);
  const configResult = await loadConfig(root);
  diagnostics.push(...manifestResult.diagnostics, ...configResult.diagnostics);
  if (hasErrors(diagnostics)) {
    return { diagnostics: sortDiagnostics(diagnostics) };
  }
  const { manifest } = manifestResult;
  const project = check.project;
  const exportsByConcept = collectExports(project);
  const versions = await loadVersions(configResult.config);

  const onDisk = await listCccFiles(root);
  const hashes = await hashFiles(root, onDisk);
  for (const file of onDisk) {
    const recorded = manifest.files[file];
    if (recorded === undefined) {
      diagnostics.push(error(file, 'not recorded in the manifest (created outside ccc build?)'));
    } else if (recorded !== hashes[file]) {
      diagnostics.push(error(file, 'modified since ccc build generated it'));
    }
  }
  for (const file of Object.keys(manifest.files)) {
    if (hashes[file] === undefined) {
      diagnostics.push(error(file, 'recorded in the manifest but missing'));
    }
  }

  for (const concept of project.concepts.values()) {
    const entry = manifest.concepts[concept.id];
    if (entry === undefined || entry.testFileHash === null) {
      diagnostics.push(error(concept.file, 'not built; run ccc build'));
      continue;
    }
    if ((await testKey(concept, project, exportsByConcept, versions)) !== entry.testKey) {
      diagnostics.push(error(concept.file, 'changed since the last build (tests are stale); run ccc build'));
    } else if (
      !isHandwritten(concept.frontmatter) &&
      (await implKey(concept, project, exportsByConcept, versions, entry.testFileHash)) !== entry.implKey
    ) {
      diagnostics.push(error(concept.file, 'changed since the last build (implementation is stale); run ccc build'));
    }
    if (entry.approvedTestHash !== entry.testFileHash) {
      diagnostics.push(error(testPath(concept.id), 'tests are not approved; run ccc approve', { line: 1 }));
    }
  }

  const testFiles = onDisk.filter((file) => file.endsWith('.test.ts'));
  const run = await runTests(root, testFiles);
  for (const issue of run.errors) {
    diagnostics.push(error(issue.file || 'concepts/', `test file failed to run: ${issue.message.split('\n')[0] ?? ''}`));
  }
  for (const testCase of run.cases.filter((c) => c.status === 'failed')) {
    diagnostics.push(error(testCase.file, `test failed: ${testCase.name}: ${testCase.message.split('\n')[0] ?? ''}`));
  }
  return { diagnostics: sortDiagnostics(diagnostics) };
}
