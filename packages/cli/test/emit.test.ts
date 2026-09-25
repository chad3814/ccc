import { describe, expect, it } from 'vitest';
import { emitDeterministicFiles, expectedFiles } from '../src/emit.js';
import { listFilesUnder, readFileOrNull, writeFileAtomic } from '../src/fsutil.js';
import { collectExports } from '../src/interfaces.js';
import { loadProject } from '../src/load.js';
import { concept, writeProject } from './helpers.js';

async function setup() {
  const root = await writeProject({
    'concepts/user.md': concept(
      'kind: value\nimplementation: handwritten\nsource: handwritten/user.ts\ninterface: export type UserId = string;',
    ),
    'concepts/card.md': concept('kind: value\ninterface: |\n  export interface Card { readonly rank: string }'),
    'handwritten/user.ts': 'export type UserId = string;\n',
  });
  const { project } = await loadProject(root);
  return { root, project, exportsByConcept: collectExports(project) };
}

describe('emitDeterministicFiles', () => {
  it('writes package.json, .gitignore, interfaces, conformance, and handwritten re-exports', async () => {
    const { root, project, exportsByConcept } = await setup();
    expect(await emitDeterministicFiles(root, project, exportsByConcept)).toEqual([]);
    expect(await readFileOrNull(root, '.ccc/package.json')).toBe('{\n  "type": "module"\n}\n');
    expect(await readFileOrNull(root, '.ccc/.gitignore')).toBe('.tmp/\n');
    expect(await readFileOrNull(root, '.ccc/interfaces/card.d.ts')).toContain('export interface Card');
    expect(await readFileOrNull(root, '.ccc/conformance/user.ts')).toContain("import * as impl from '../gen/user.js';");
    expect(await readFileOrNull(root, '.ccc/gen/user.ts')).toContain("export * from '../../handwritten/user.js';");
    expect(await readFileOrNull(root, '.ccc/gen/card.ts')).toBeNull();
  });

  it('removes files that belong to no concept and keeps expected ones', async () => {
    const { root, project, exportsByConcept } = await setup();
    await writeFileAtomic(root, '.ccc/gen/card.ts', '// generated earlier');
    await writeFileAtomic(root, '.ccc/gen/card.test.ts', '// generated earlier');
    await writeFileAtomic(root, '.ccc/gen/old.ts', '// concept deleted');
    await writeFileAtomic(root, '.ccc/interfaces/old.d.ts', '// concept deleted');
    await emitDeterministicFiles(root, project, exportsByConcept);
    expect(await listFilesUnder(root, '.ccc/gen')).toEqual([
      '.ccc/gen/card.contract.d.ts',
      '.ccc/gen/card.test.ts',
      '.ccc/gen/card.ts',
      '.ccc/gen/main.ts',
      '.ccc/gen/schema.sql',
      '.ccc/gen/schema.ts',
      '.ccc/gen/server.ts',
      '.ccc/gen/user.contract.d.ts',
      '.ccc/gen/user.ts',
      '.ccc/gen/wiring.ts',
    ]);
    expect(await readFileOrNull(root, '.ccc/interfaces/old.d.ts')).toBeNull();
  });

  it('lists the files each concept owns', async () => {
    const { project } = await setup();
    expect([...expectedFiles(project)].sort()).toEqual([
      '.ccc/.gitignore',
      '.ccc/conformance/card.ts',
      '.ccc/conformance/user.ts',
      '.ccc/gen/card.contract.d.ts',
      '.ccc/gen/card.test.ts',
      '.ccc/gen/card.ts',
      '.ccc/gen/main.ts',
      '.ccc/gen/schema.sql',
      '.ccc/gen/schema.ts',
      '.ccc/gen/server.ts',
      '.ccc/gen/user.contract.d.ts',
      '.ccc/gen/user.test.ts',
      '.ccc/gen/user.ts',
      '.ccc/gen/wiring.ts',
      '.ccc/interfaces/card.d.ts',
      '.ccc/interfaces/user.d.ts',
      '.ccc/package.json',
    ]);
  });
});
