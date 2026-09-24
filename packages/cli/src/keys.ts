import { dependenciesOf } from './graph.js';
import { normalizeConcept, sha256, stableStringify } from './hash.js';
import type { ConceptId } from './ids.js';
import { transitiveDependencies } from './imports.js';
import type { ExportInfo } from './interfaces.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { syncInterface } from './synciface.js';
import type { Versions } from './versions.js';

export type ExportsByConcept = ReadonlyMap<ConceptId, ExportInfo>;

export function interfaceTextOf(concept: Concept, exportsByConcept: ExportsByConcept): string {
  const fm = concept.frontmatter;
  return fm.kind === 'sync' ? (syncInterface(concept, exportsByConcept).source ?? '') : fm.interface;
}

// Dependencies contribute their interfaces only, never their implementations
// or prose (spec §3.2: separate compilation). Tests see every transitive
// dependency (they may import any of them); implementations see direct ones.
function dependencyInterfaces(ids: readonly ConceptId[], project: Project, exportsByConcept: ExportsByConcept): [string, string][] {
  return ids.flatMap((id): [string, string][] => {
    const dep = project.concepts.get(id);
    return dep === undefined ? [] : [[id, interfaceTextOf(dep, exportsByConcept)]];
  });
}

export async function testKey(
  concept: Concept,
  project: Project,
  exportsByConcept: ExportsByConcept,
  versions: Versions,
): Promise<string> {
  return sha256(
    stableStringify({
      artifact: 'tests',
      id: concept.id,
      kind: concept.frontmatter.kind,
      interface: interfaceTextOf(concept, exportsByConcept),
      intent: concept.sections.get('Intent')?.body ?? '',
      examples: concept.examples,
      dependencies: dependencyInterfaces(transitiveDependencies(concept, project), project, exportsByConcept),
      prompt: versions.testPrompt,
      model: versions.testModel,
      runtime: versions.runtime,
    }),
  );
}

export async function implKey(
  concept: Concept,
  project: Project,
  exportsByConcept: ExportsByConcept,
  versions: Versions,
  testFileHash: string,
): Promise<string> {
  return sha256(
    stableStringify({
      artifact: 'impl',
      concept: normalizeConcept(concept),
      dependencies: dependencyInterfaces(dependenciesOf(concept, project), project, exportsByConcept),
      tests: testFileHash,
      prompt: concept.frontmatter.kind === 'sync' ? versions.syncPrompt : versions.implPrompt,
      model: versions.implModel,
      runtime: versions.runtime,
    }),
  );
}
