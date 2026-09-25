import { MAIN_FILE, SCHEMA_SQL_FILE, SCHEMA_TS_FILE, SERVER_FILE, WIRING_FILE, compositionFiles } from './compose.js';
import type { Diagnostic } from './diagnostics.js';
import { listFilesUnder, readFileOrNull, removeFile, writeFileAtomic } from './fsutil.js';
import { emitInterfaces, exportsOf } from './interfaces.js';
import type { ExportsByConcept } from './keys.js';
import {
  CCC_GITIGNORE,
  CCC_PACKAGE_JSON,
  CONFORMANCE_DIR,
  GEN_DIR,
  INTERFACES_DIR,
  conformancePath,
  conformanceSource,
  contractPath,
  handwrittenModuleSource,
  interfaceFile,
  modulePath,
  testPath,
} from './layout.js';
import type { Project } from './load.js';

export function expectedFiles(project: Project): Set<string> {
  const files = new Set(['.ccc/package.json', '.ccc/.gitignore', WIRING_FILE, SERVER_FILE, MAIN_FILE, SCHEMA_SQL_FILE, SCHEMA_TS_FILE]);
  for (const id of project.concepts.keys()) {
    files.add(modulePath(id));
    files.add(testPath(id));
    files.add(interfaceFile(id));
    files.add(conformancePath(id));
    files.add(contractPath(id));
  }
  return files;
}

export interface DeterministicWrites {
  writes: [string, string][];
  diagnostics: Diagnostic[];
}

// Everything under .ccc that needs no LLM, as (path, content) pairs.
export function deterministicWrites(project: Project, exportsByConcept: ExportsByConcept): DeterministicWrites {
  const { files, diagnostics } = emitInterfaces(project, exportsByConcept);
  const writes: [string, string][] = [
    ['.ccc/package.json', CCC_PACKAGE_JSON],
    ['.ccc/.gitignore', CCC_GITIGNORE],
    ...files.map((file): [string, string] => [`${INTERFACES_DIR}/${file.path}`, file.content]),
    ...files.map((file): [string, string] => [contractPath(file.id), file.content]),
  ];
  const typesById = new Map(files.map((file) => [file.id, exportsOf(file.content).types]));
  for (const concept of project.concepts.values()) {
    writes.push([conformancePath(concept.id), conformanceSource(concept.id, typesById.get(concept.id) ?? [])]);
    const fm = concept.frontmatter;
    if (fm.kind !== 'sync' && fm.implementation === 'handwritten' && fm.source !== undefined) {
      writes.push([modulePath(concept.id), handwrittenModuleSource(concept.id, fm.source)]);
    }
  }
  writes.push(...compositionFiles(project, exportsByConcept));
  return { writes, diagnostics };
}

// Rewritten on every build, written only when content changed, and pruned
// when their concept is gone.
export async function emitDeterministicFiles(
  root: string,
  project: Project,
  exportsByConcept: ExportsByConcept,
): Promise<Diagnostic[]> {
  const { writes, diagnostics } = deterministicWrites(project, exportsByConcept);
  await Promise.all(
    writes.map(async ([rel, content]) => {
      if ((await readFileOrNull(root, rel)) !== content) {
        await writeFileAtomic(root, rel, content);
      }
    }),
  );
  const expected = expectedFiles(project);
  const existing = (await Promise.all([GEN_DIR, INTERFACES_DIR, CONFORMANCE_DIR].map((dir) => listFilesUnder(root, dir)))).flat();
  await Promise.all(existing.filter((rel) => !expected.has(rel)).map((rel) => removeFile(root, rel)));
  return diagnostics;
}
