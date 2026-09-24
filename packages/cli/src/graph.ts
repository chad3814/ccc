import { findCycles } from './cycles.js';
import { error, type Diagnostic } from './diagnostics.js';
import { isVisible, parentOf, parseActionRef, type ConceptId } from './ids.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { isAdapterKind, isDomainKind } from './schema.js';

export type ReferenceField = 'uses' | 'of' | 'persists' | 'child' | 'when' | 'then';

export interface Reference {
  from: ConceptId;
  to: ConceptId;
  field: ReferenceField;
}

export function childrenOf(project: Project, id: ConceptId): Concept[] {
  return [...project.concepts.values()].filter((candidate) => parentOf(candidate.id) === id);
}

export function referencesOf(concept: Concept, project: Project): Reference[] {
  const fm = concept.frontmatter;
  const refs: Reference[] = [];
  const add = (to: ConceptId, field: ReferenceField): void => {
    refs.push({ from: concept.id, to, field });
  };
  if (fm.kind === 'sync') {
    add(parseActionRef(fm.when).conceptId, 'when');
    for (const target of fm.then) {
      add(parseActionRef(target).conceptId, 'then');
    }
    return refs;
  }
  for (const used of fm.uses) {
    add(used, 'uses');
  }
  if (fm.kind === 'collection') {
    add(fm.of, 'of');
  }
  if (fm.kind === 'store') {
    add(fm.persists, 'persists');
  }
  if (fm.kind === 'aggregate') {
    for (const child of childrenOf(project, concept.id)) {
      if (child.frontmatter.kind !== 'sync') {
        add(child.id, 'child');
      }
    }
  }
  return refs;
}

export function dependenciesOf(concept: Concept, project: Project): ConceptId[] {
  const ids = referencesOf(concept, project)
    .map((ref) => ref.to)
    .filter((to) => to !== concept.id && project.concepts.has(to));
  return [...new Set(ids)].sort();
}

export function checkReferences(project: Project): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const concept of project.concepts.values()) {
    for (const ref of referencesOf(concept, project)) {
      const target = project.concepts.get(ref.to);
      const fromKind = concept.frontmatter.kind;
      if (ref.to === ref.from) {
        diagnostics.push(error(concept.file, `${ref.field} refers to itself`, { line: 1 }));
      } else if (target === undefined) {
        diagnostics.push(error(concept.file, `unknown concept '${ref.to}' in ${ref.field}`, { line: 1 }));
      } else if (ref.field !== 'child' && !isVisible(ref.from, ref.to)) {
        const owner = parentOf(ref.to) ?? ref.to;
        diagnostics.push(
          error(concept.file, `'${ref.to}' is not visible from '${ref.from}'`, {
            line: 1,
            hint: `${ref.to} is private to ${owner}; reference ${owner} instead, or move ${ref.to} up a level`,
          }),
        );
      } else if (target.frontmatter.kind === 'sync') {
        diagnostics.push(error(concept.file, `'${ref.to}' is a sync; syncs cannot be referenced`, { line: 1 }));
      } else if (isDomainKind(fromKind) && isAdapterKind(target.frontmatter.kind)) {
        diagnostics.push(
          error(
            concept.file,
            `domain concept '${ref.from}' (${fromKind}) cannot depend on adapter '${ref.to}' (${target.frontmatter.kind})`,
            { line: 1, hint: 'connect them with a sync, or move the dependency into an adapter' },
          ),
        );
      } else if (ref.field === 'persists' && target.frontmatter.kind !== 'aggregate') {
        diagnostics.push(
          error(concept.file, `persists must reference an aggregate; '${ref.to}' is a ${target.frontmatter.kind}`, {
            line: 1,
          }),
        );
      }
    }
  }
  return diagnostics;
}

export function checkDependencyCycles(project: Project): Diagnostic[] {
  const edges = new Map<string, readonly string[]>();
  for (const concept of project.concepts.values()) {
    edges.set(concept.id, dependenciesOf(concept, project));
  }
  return findCycles(edges).map((cycle) => {
    const first = project.concepts.get(cycle[0] ?? '');
    return error(first?.file ?? 'concepts/', `dependency cycle: ${cycle.join(' → ')}`, { line: 1 });
  });
}
