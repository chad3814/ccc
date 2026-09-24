import { describe, expect, it } from 'vitest';
import { loadProject } from '../src/load.js';
import { concept, writeProject } from './helpers.js';

const VALUE = concept('kind: value\ninterface: export type A = string;');

describe('loadProject', () => {
  it('loads nested concepts with path-derived ids', async () => {
    const root = await writeProject({
      'concepts/card.md': VALUE,
      'concepts/game.md': concept('kind: aggregate\ninterface: export class Game {}'),
      'concepts/game/deck.md': VALUE,
    });
    const { project, diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([]);
    expect([...project.concepts.keys()]).toEqual(['card', 'game', 'game.deck']);
    expect(project.concepts.get('game.deck')?.file).toBe('concepts/game/deck.md');
  });

  it('ignores dotfiles silently and warns about other non-markdown files', async () => {
    const root = await writeProject({
      'concepts/card.md': VALUE,
      'concepts/.DS_Store': 'binary',
      'concepts/notes.txt': 'scratch',
    });
    const { project, diagnostics } = await loadProject(root);
    expect([...project.concepts.keys()]).toEqual(['card']);
    expect(diagnostics.map((d) => `${d.severity} ${d.file}: ${d.message}`)).toEqual([
      'warning concepts/notes.txt: ignored: not a .md concept file',
    ]);
  });

  it('rejects names that are not kebab-case', async () => {
    const root = await writeProject({ 'concepts/Game_Store.md': VALUE });
    const { project, diagnostics } = await loadProject(root);
    expect(project.concepts.size).toBe(0);
    expect(diagnostics[0]?.message).toBe("invalid name 'Game_Store': use lowercase kebab-case (e.g. game-store)");
  });

  it('reports a directory with no parent concept file', async () => {
    const root = await writeProject({ 'concepts/game/hand.md': VALUE });
    const { diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        file: 'concepts/game/hand.md',
        message: 'no parent concept: expected concepts/game.md',
        hint: 'files in concepts/game/ are contained by concept game; create its concept file',
      },
    ]);
  });

  it('does not report a missing parent when the parent file exists but fails to parse', async () => {
    const root = await writeProject({ 'concepts/game.md': 'no frontmatter', 'concepts/game/hand.md': VALUE });
    const { project, diagnostics } = await loadProject(root);
    expect([...project.concepts.keys()]).toEqual(['game.hand']);
    expect(diagnostics.map((d) => d.file)).toEqual(['concepts/game.md']);
  });

  it('reports a missing concepts directory', async () => {
    const root = await writeProject({ 'README.md': '# hi' });
    const { diagnostics } = await loadProject(root);
    expect(diagnostics[0]?.message).toMatch(/^no concepts\/ directory in /);
  });
});
