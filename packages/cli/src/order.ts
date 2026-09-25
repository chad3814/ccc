import { dependenciesOf } from './graph.js';
import type { ConceptId } from './ids.js';
import type { Project } from './load.js';

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Build order: a concept's level is one more than its deepest dependency.
// Endpoints go last, because their tests run the whole app (wiring and
// every adapter) through createApp.
export function topologicalLevels(project: Project): ConceptId[][] {
  const level = new Map<ConceptId, number>();
  const visit = (id: ConceptId): number => {
    const known = level.get(id);
    if (known !== undefined) {
      return known;
    }
    const concept = project.concepts.get(id);
    if (concept === undefined) {
      return -1;
    }
    level.set(id, 0);
    const value = Math.max(-1, ...dependenciesOf(concept, project).map(visit)) + 1;
    level.set(id, value);
    return value;
  };
  for (const id of project.concepts.keys()) {
    visit(id);
  }
  const isEndpoint = (id: ConceptId): boolean => project.concepts.get(id)?.frontmatter.kind === 'endpoint';
  const lastOther = Math.max(-1, ...[...level].filter(([id]) => !isEndpoint(id)).map(([, value]) => value));
  for (const [id, value] of level) {
    if (isEndpoint(id)) {
      level.set(id, Math.max(value, lastOther + 1));
    }
  }
  const levels: ConceptId[][] = [];
  for (const [id, value] of [...level].sort(([a], [b]) => compareIds(a, b))) {
    (levels[value] ??= []).push(id);
  }
  return levels.filter((ids) => ids !== undefined);
}

export function dependencyClosure(project: Project, id: ConceptId): Set<ConceptId> {
  const seen = new Set<ConceptId>();
  const queue = [id];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined || seen.has(next)) {
      continue;
    }
    seen.add(next);
    const concept = project.concepts.get(next);
    if (concept !== undefined) {
      queue.push(...dependenciesOf(concept, project));
    }
  }
  return seen;
}
