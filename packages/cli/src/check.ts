import { access } from 'node:fs/promises';
import path from 'node:path';
import { error, hasErrors, sortDiagnostics, type Diagnostic } from './diagnostics.js';
import { checkDependencyCycles, checkReferences } from './graph.js';
import { checkInterfaces, collectExports, emitInterfaces } from './interfaces.js';
import { loadProject, type Project } from './load.js';
import { checkSyncActions, checkSyncCycles } from './syncs.js';
import { typecheckInterfaces } from './typecheck.js';

export interface CheckResult {
  project: Project;
  diagnostics: Diagnostic[];
}

async function checkHandwrittenSources(project: Project): Promise<Diagnostic[]> {
  const results = await Promise.all(
    [...project.concepts.values()].map(async (concept): Promise<Diagnostic | null> => {
      const fm = concept.frontmatter;
      if (fm.kind === 'sync' || fm.implementation !== 'handwritten' || fm.source === undefined) {
        return null;
      }
      try {
        await access(path.join(project.root, fm.source));
        return null;
      } catch {
        return error(concept.file, `handwritten source not found: ${fm.source}`, { line: 1 });
      }
    }),
  );
  return results.filter((d): d is Diagnostic => d !== null);
}

// Runs every rule in spec §2.8. Type-checking runs last and only on a
// structurally valid project, so its errors aren't noise from broken references.
export async function runCheck(root: string): Promise<CheckResult> {
  const { project, diagnostics } = await loadProject(root);
  diagnostics.push(...checkReferences(project), ...checkDependencyCycles(project), ...checkInterfaces(project));
  diagnostics.push(...(await checkHandwrittenSources(project)));
  const exportsByConcept = collectExports(project);
  diagnostics.push(...checkSyncActions(project, exportsByConcept), ...checkSyncCycles(project));
  const emitted = emitInterfaces(project, exportsByConcept);
  diagnostics.push(...emitted.diagnostics);
  if (!hasErrors(diagnostics)) {
    diagnostics.push(...(await typecheckInterfaces(emitted.files)));
  }
  return { project, diagnostics: sortDiagnostics(diagnostics) };
}
