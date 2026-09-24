import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/check.js';
import { concept, writeProject } from './helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'card-game');

describe('runCheck', () => {
  it('passes the card-game fixture with no diagnostics', async () => {
    const { project, diagnostics } = await runCheck(FIXTURE);
    expect(diagnostics).toEqual([]);
    expect(project.concepts.size).toBe(11);
  });

  it('reports a missing handwritten source', async () => {
    const root = await writeProject({
      'concepts/user.md': concept(
        'kind: value\nimplementation: handwritten\nsource: handwritten/user.ts\ninterface: export type UserId = string;',
      ),
    });
    const { diagnostics } = await runCheck(root);
    expect(diagnostics.map((d) => `${d.file}: ${d.message}`)).toEqual([
      'concepts/user.md: handwritten source not found: handwritten/user.ts',
    ]);
  });

  it('skips type-checking when structural errors exist', async () => {
    const root = await writeProject({
      'concepts/card.md': concept('kind: value\nuses: [nope]\ninterface: export type Card = Nope;'),
    });
    const { diagnostics } = await runCheck(root);
    expect(diagnostics.map((d) => d.message)).toEqual(["unknown concept 'nope' in uses"]);
  });

  it('type-checks when the structure is valid', async () => {
    const root = await writeProject({ 'concepts/card.md': concept('kind: value\ninterface: export type Card = Nope;') });
    const { diagnostics } = await runCheck(root);
    expect(diagnostics.map((d) => d.message)).toEqual(["interface line 1: Cannot find name 'Nope'. (TS2304)"]);
  });

  it('returns sorted diagnostics from every stage', async () => {
    const root = await writeProject({
      'concepts/b.md': concept('kind: value\nuses: [a]\ninterface: export type B = string;'),
      'concepts/a.md': concept('kind: value\nuses: [b]\ninterface: export type A = string;'),
      'concepts/notes.txt': 'x',
    });
    const { diagnostics } = await runCheck(root);
    expect(diagnostics.map((d) => `${d.severity} ${d.file}: ${d.message}`)).toEqual([
      'error concepts/a.md: dependency cycle: a → b → a',
      'warning concepts/notes.txt: ignored: not a .md concept file',
    ]);
  });
});
