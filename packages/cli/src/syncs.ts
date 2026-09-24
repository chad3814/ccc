import { findCycles } from './cycles.js';
import { error, type Diagnostic } from './diagnostics.js';
import { parseActionRef, type ConceptId } from './ids.js';
import type { ExportInfo } from './interfaces.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';

export function primaryClassName(id: ConceptId): string {
  const last = id.split('.').at(-1) ?? id;
  return last
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function syncs(project: Project): Concept[] {
  return [...project.concepts.values()].filter((concept) => concept.frontmatter.kind === 'sync');
}

function actionsOf(concept: Concept): string[] {
  const fm = concept.frontmatter;
  return fm.kind === 'sync' ? [fm.when, ...fm.then] : [];
}

export function checkSyncActions(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const sync of syncs(project)) {
    for (const ref of actionsOf(sync)) {
      const { conceptId, member } = parseActionRef(ref);
      const info = exportsByConcept.get(conceptId);
      if (info === undefined) {
        continue;
      }
      const className = primaryClassName(conceptId);
      if (info.functions.includes(member) || (info.classMethods.get(className) ?? []).includes(member)) {
        continue;
      }
      diagnostics.push(
        error(
          sync.file,
          `${ref}: '${conceptId}' has no exported function '${member}' and no method '${member}' on class ${className}`,
          { line: 1, hint: `actions are exported functions, or methods of the class named after the concept (${className})` },
        ),
      );
    }
  }
  return diagnostics;
}

export function checkSyncCycles(project: Project): Diagnostic[] {
  const edges = new Map<string, string[]>();
  const firstSyncByWhen = new Map<string, Concept>();
  for (const sync of syncs(project)) {
    const fm = sync.frontmatter;
    if (fm.kind !== 'sync') {
      continue;
    }
    edges.set(fm.when, [...(edges.get(fm.when) ?? []), ...fm.then]);
    if (!firstSyncByWhen.has(fm.when)) {
      firstSyncByWhen.set(fm.when, sync);
    }
  }
  return findCycles(edges).map((cycle) => {
    const owner = firstSyncByWhen.get(cycle[0] ?? '');
    return error(owner?.file ?? 'concepts/', `sync cycle: ${cycle.join(' → ')}`, {
      line: 1,
      hint: 'a sync must not directly or transitively re-trigger its own when action',
    });
  });
}
