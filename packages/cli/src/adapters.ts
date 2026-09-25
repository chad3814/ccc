import { error, type Diagnostic } from './diagnostics.js';
import { transitiveDependencies } from './imports.js';
import { parentOf, parseActionRef, type ConceptId } from './ids.js';
import type { ExportInfo } from './interfaces.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { topologicalLevels } from './order.js';
import { isAdapterKind } from './schema.js';
import { primaryClassName } from './syncs.js';

// Top-level names the build writes into .ccc/gen itself.
export const RESERVED_IDS: readonly string[] = ['main', 'schema', 'server', 'wiring'];

const SQL_FENCE = /^\s*(`{3,}|~{3,})\s*sql\s*$/i;

export function storeSchemaSql(concept: Concept): string | null {
  const lines = concept.sections.get('Schema')?.lines ?? [];
  const start = lines.findIndex((line) => SQL_FENCE.test(line));
  if (start === -1) {
    return null;
  }
  const fence = SQL_FENCE.exec(lines[start] ?? '')?.[1] ?? '```';
  const end = lines.findIndex((line, index) => index > start && line.trim() === fence);
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

function hasClass(info: ExportInfo | undefined, id: ConceptId, method?: string): boolean {
  const methods = info?.classMethods.get(primaryClassName(id));
  return methods !== undefined && (method === undefined || methods.includes(method));
}

export function checkAdapters(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const concept of project.concepts.values()) {
    const fm = concept.frontmatter;
    const info = exportsByConcept.get(concept.id);
    const cls = primaryClassName(concept.id);
    if (parentOf(concept.id) === null && RESERVED_IDS.includes(concept.id)) {
      diagnostics.push(error(concept.file, `'${concept.id}' is reserved for generated files; rename the concept`, { line: 1 }));
    }
    if (fm.kind === 'store') {
      if (storeSchemaSql(concept) === null) {
        diagnostics.push(error(concept.file, '## Schema must contain a ```sql code block with the table definitions', { line: 1 }));
      }
      if (!hasClass(info, concept.id)) {
        diagnostics.push(error(concept.file, `store interface must export class ${cls} (constructor(db: Database))`, { line: 1 }));
      }
    } else if (fm.kind === 'auth') {
      if (concept.sections.has('Schema') && storeSchemaSql(concept) === null) {
        diagnostics.push(error(concept.file, '## Schema must contain a ```sql code block with the table definitions', { line: 1 }));
      }
      if (!hasClass(info, concept.id, 'authenticate')) {
        diagnostics.push(
          error(concept.file, `auth interface must export class ${cls} with an authenticate(request) method`, { line: 1 }),
        );
      }
    } else if (fm.kind === 'endpoint' && !(info?.functions.includes('createHandler') ?? false)) {
      diagnostics.push(error(concept.file, 'endpoint interface must export function createHandler(deps)', { line: 1 }));
    } else if (fm.kind === 'sync') {
      const when = parseActionRef(fm.when);
      const whenInfo = exportsByConcept.get(when.conceptId);
      if (whenInfo?.functions.includes(when.member) === true) {
        diagnostics.push(
          error(
            concept.file,
            `${fm.when}: sync triggers must be methods of class ${primaryClassName(when.conceptId)}; exported functions can't be wired`,
            { line: 1 },
          ),
        );
      }
    }
  }
  diagnostics.push(...unbindableTargets(project, exportsByConcept));
  return diagnostics;
}

// An endpoint binds the domain targets of the syncs its actions can trigger;
// it can only bind concepts it can import.
function unbindableTargets(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const syncs = [...project.concepts.values()].filter((c) => c.frontmatter.kind === 'sync');
  for (const endpoint of project.concepts.values()) {
    if (endpoint.frontmatter.kind !== 'endpoint') {
      continue;
    }
    const reachable = new Set(transitiveDependencies(endpoint, project));
    for (const sync of syncs) {
      const fm = sync.frontmatter;
      if (fm.kind !== 'sync' || !reachable.has(parseActionRef(fm.when).conceptId)) {
        continue;
      }
      for (const ref of fm.then) {
        const { conceptId } = parseActionRef(ref);
        const target = project.concepts.get(conceptId);
        const isClassTarget = exportsByConcept.get(conceptId)?.classMethods.has(primaryClassName(conceptId)) === true;
        if (target === undefined || isAdapterKind(target.frontmatter.kind) || !isClassTarget || reachable.has(conceptId)) {
          continue;
        }
        diagnostics.push(
          error(
            endpoint.file,
            `sync ${sync.id} needs '${conceptId}' bound in scope, but ${endpoint.id} doesn't use it; add ${conceptId} to uses`,
            { line: 1 },
          ),
        );
      }
    }
  }
  return diagnostics;
}

export function combinedSchema(project: Project): string {
  const parts: string[] = [];
  for (const id of topologicalLevels(project).flat()) {
    const concept = project.concepts.get(id);
    const kind = concept?.frontmatter.kind;
    const sql = concept !== undefined && (kind === 'store' || kind === 'auth') ? storeSchemaSql(concept) : null;
    if (sql !== null) {
      parts.push(`-- ${id}\n${sql}\n`);
    }
  }
  return parts.join('\n');
}
