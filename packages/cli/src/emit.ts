import type { Diagnostic } from './diagnostics.js';
import { listFilesUnder, readFileOrNull, removeFile, writeFileAtomic } from './fsutil.js';
import { emitInterfaces } from './interfaces.js';
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
  const files = new Set(['.ccc/package.json', '.ccc/.gitignore']);
  for (const id of project.concepts.keys()) {
    files.add(modulePath(id));
    files.add(testPath(id));
    files.add(interfaceFile(id));
    files.add(conformancePath(id));
    files.add(contractPath(id));
  }
  return files;
}

// Everything under .ccc that needs no LLM: rewritten on every build, written
// only when its content changed, and pruned when its concept is gone.
export async function emitDeterministicFiles(
  root: string,
  project: Project,
  exportsByConcept: ExportsByConcept,
): Promise<Diagnostic[]> {
  const { files, diagnostics } = emitInterfaces(project, exportsByConcept);
  const writes: [string, string][] = [
    ['.ccc/package.json', CCC_PACKAGE_JSON],
    ['.ccc/.gitignore', CCC_GITIGNORE],
    ...files.map((file): [string, string] => [`${INTERFACES_DIR}/${file.path}`, file.content]),
    ...files.map((file): [string, string] => [contractPath(file.id), file.content]),
  ];
  for (const concept of project.concepts.values()) {
    writes.push([conformancePath(concept.id), conformanceSource(concept.id)]);
    const fm = concept.frontmatter;
    if (fm.kind !== 'sync' && fm.implementation === 'handwritten' && fm.source !== undefined) {
      writes.push([modulePath(concept.id), handwrittenModuleSource(concept.id, fm.source)]);
    }
  }
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
