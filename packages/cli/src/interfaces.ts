import path from 'node:path';
import ts from '@typescript/typescript6';
import { error, type Diagnostic } from './diagnostics.js';
import { dependenciesOf } from './graph.js';
import type { ConceptId } from './ids.js';
import type { Project } from './load.js';

export interface ExportInfo {
  names: readonly string[];
  functions: readonly string[];
  classMethods: ReadonlyMap<string, readonly string[]>;
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

// Reads declarations with the TS 6 API (TS 7 has no stable API yet; spec §7.5).
export function exportsOf(source: string): ExportInfo {
  const file = parseInterface(source);
  const names: string[] = [];
  const functions: string[] = [];
  const classMethods = new Map<string, readonly string[]>();
  for (const statement of file.statements) {
    if (!isExported(statement)) {
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      const methods = statement.members
        .filter(ts.isMethodDeclaration)
        .map((method) => method.name)
        .filter(ts.isIdentifier)
        .map((name) => name.text);
      names.push(statement.name.text);
      classMethods.set(statement.name.text, [...new Set(methods)]);
    } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      names.push(statement.name.text);
      functions.push(statement.name.text);
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    }
  }
  return { names: [...new Set(names)], functions: [...new Set(functions)], classMethods };
}

function parseInterface(source: string): ts.SourceFile {
  return ts.createSourceFile('interface.d.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// An interface is a self-contained module: it reaches other concepts only
// through `uses`, so imports, ambient modules, and global augmentation are
// rejected. Without an export it would compile as a global script.
export function interfaceProblems(source: string): string[] {
  const file = parseInterface(source);
  const problems: string[] = [];
  let exported = false;
  for (const statement of file.statements) {
    const line = file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1;
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      problems.push(`interface line ${line}: interfaces cannot import modules; list the concept in uses instead`);
    } else if (ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name) || statement.name.text === 'global')) {
      problems.push(`interface line ${line}: interfaces cannot declare global or ambient modules`);
    }
    if (isExported(statement)) {
      exported = true;
    }
  }
  if (!exported) {
    problems.push('interface must export at least one declaration');
  }
  return problems;
}

export function checkInterfaces(project: Project): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const concept of project.concepts.values()) {
    if (concept.frontmatter.kind !== 'sync') {
      for (const problem of interfaceProblems(concept.frontmatter.interface)) {
        diagnostics.push(error(concept.file, problem, { line: 1 }));
      }
    }
  }
  return diagnostics;
}

export function referencedNames(source: string): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parseInterface(source));
  return names;
}

export function collectExports(project: Project): Map<ConceptId, ExportInfo> {
  const result = new Map<ConceptId, ExportInfo>();
  for (const concept of project.concepts.values()) {
    if (concept.frontmatter.kind !== 'sync') {
      result.set(concept.id, exportsOf(concept.frontmatter.interface));
    }
  }
  return result;
}

export function interfacePath(id: ConceptId): string {
  return `${id.split('.').join('/')}.d.ts`;
}

export function relativeImport(from: ConceptId, to: ConceptId): string {
  const rel = path.posix
    .relative(path.posix.dirname(interfacePath(from)), interfacePath(to))
    .replace(/\.d\.ts$/, '.js');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export interface EmittedInterface {
  id: ConceptId;
  conceptFile: string;
  path: string;
  content: string;
  headerLines: number;
}

export interface EmitResult {
  files: EmittedInterface[];
  diagnostics: Diagnostic[];
}

export function emitInterfaces(project: Project, exportsByConcept: ReadonlyMap<ConceptId, ExportInfo>): EmitResult {
  const files: EmittedInterface[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const concept of project.concepts.values()) {
    const fm = concept.frontmatter;
    const own = exportsByConcept.get(concept.id);
    if (fm.kind === 'sync' || own === undefined) {
      continue;
    }
    const ownNames = new Set(own.names);
    const referenced = referencedNames(fm.interface);
    const importedFrom = new Map<string, ConceptId>();
    const importLines: string[] = [];
    for (const dep of dependenciesOf(concept, project)) {
      const depInfo = exportsByConcept.get(dep);
      if (depInfo === undefined || depInfo.names.length === 0) {
        continue;
      }
      const names: string[] = [];
      for (const name of depInfo.names) {
        // Only referenced names are imported; the concept's own exports shadow its dependencies'.
        if (!referenced.has(name) || ownNames.has(name)) {
          continue;
        }
        const previous = importedFrom.get(name);
        if (previous !== undefined) {
          diagnostics.push(error(concept.file, `'${name}' is exported by both dependencies ${previous} and ${dep}`, { line: 1 }));
        } else {
          importedFrom.set(name, dep);
          names.push(name);
        }
      }
      if (names.length > 0) {
        importLines.push(`import { ${names.join(', ')} } from '${relativeImport(concept.id, dep)}';`);
      }
    }
    const header = [`// @generated by ccc from concept ${concept.id}. Do not edit.`, ...importLines];
    files.push({
      id: concept.id,
      conceptFile: concept.file,
      path: interfacePath(concept.id),
      content: [...header, fm.interface.trimEnd(), ''].join('\n'),
      headerLines: header.length,
    });
  }
  return { files, diagnostics };
}
