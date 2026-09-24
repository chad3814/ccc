import ts from '@typescript/typescript6';
import { dependenciesOf } from './graph.js';
import type { ConceptId } from './ids.js';
import { ownModuleSpecifier, relativeImport } from './layout.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import type { Kind } from './schema.js';

export interface ImportRef {
  specifier: string;
  line: number;
  dynamic: boolean;
}

export function scanImports(source: string): ImportRef[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs: ImportRef[] = [];
  const lineOf = (node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      refs.push({ specifier: node.moduleSpecifier.text, line: lineOf(node), dynamic: false });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      refs.push({ specifier: ts.isStringLiteral(expression) ? expression.text : '', line: lineOf(node), dynamic: true });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const arg = node.arguments[0];
      refs.push({ specifier: arg !== undefined && ts.isStringLiteral(arg) ? arg.text : '', line: lineOf(node), dynamic: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return refs;
}

// Spec §4.3: packages each kind may import. Everything else must be a
// dependency's generated module.
export const PACKAGES_BY_KIND: Readonly<Record<Kind, readonly string[]>> = {
  value: ['@ccc/runtime'],
  entity: ['@ccc/runtime'],
  collection: ['@ccc/runtime'],
  aggregate: ['@ccc/runtime'],
  store: ['@ccc/runtime', 'pg'],
  endpoint: ['@ccc/runtime', 'hono', 'zod'],
  auth: ['@ccc/runtime', 'hono'],
  sync: ['@ccc/runtime'],
};

export const TEST_PACKAGES: readonly string[] = ['@ccc/runtime'];

export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

export function transitiveDependencies(concept: Concept, project: Project): ConceptId[] {
  const seen = new Set<ConceptId>();
  const queue = [...dependenciesOf(concept, project)];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const dep = project.concepts.get(id);
    if (dep !== undefined) {
      queue.push(...dependenciesOf(dep, project));
    }
  }
  seen.delete(concept.id);
  return [...seen].sort();
}

export function moduleImportsFor(concept: Concept, project: Project): Set<string> {
  return new Set(dependenciesOf(concept, project).map((id) => relativeImport(concept.id, id)));
}

// Tests may build values from any concept their subject depends on, directly
// or not, plus the module under test itself.
export function testImportsFor(concept: Concept, project: Project): Set<string> {
  return new Set([
    ownModuleSpecifier(concept.id),
    ...transitiveDependencies(concept, project).map((id) => relativeImport(concept.id, id)),
  ]);
}

export function checkImports(source: string, allowedModules: ReadonlySet<string>, allowedPackages: readonly string[]): string[] {
  return scanImports(source).flatMap((ref) => {
    if (ref.dynamic) {
      return [`line ${ref.line}: dynamic import() and require() are not allowed`];
    }
    if (ref.specifier.startsWith('.')) {
      return allowedModules.has(ref.specifier)
        ? []
        : [
            `line ${ref.line}: '${ref.specifier}' is not a dependency of this concept (allowed: ${[...allowedModules].join(', ') || 'none'})`,
          ];
    }
    return allowedPackages.includes(packageName(ref.specifier))
      ? []
      : [`line ${ref.line}: package '${ref.specifier}' is not allowed here (allowed: ${allowedPackages.join(', ')})`];
  });
}
