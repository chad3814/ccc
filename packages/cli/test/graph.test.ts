import { describe, expect, it } from 'vitest';
import { checkDependencyCycles, checkReferences, dependenciesOf, referencesOf } from '../src/graph.js';
import { concept, projectFrom } from './helpers.js';

const value = (extra = ''): string => concept(`kind: value\ninterface: export type A = string;\n${extra}`);
const aggregate = (extra = ''): string => concept(`kind: aggregate\ninterface: export class Game {}\n${extra}`);
const store = (persists: string): string =>
  concept(
    `kind: store\npersists: ${persists}\ninterface: export class GameStore {}`,
    '## Intent\nx\n\n## Schema\n```sql\ncreate table games (id text);\n```\n\n## Examples\n- a\n',
  );
const sync = (when: string, then: string): string => concept(`kind: sync\nwhen: ${when}\nthen: [${then}]`);

function messages(files: Record<string, string>): string[] {
  const project = projectFrom(files);
  return [...checkReferences(project), ...checkDependencyCycles(project)].map((d) => `${d.file}: ${d.message}`);
}

describe('referencesOf / dependenciesOf', () => {
  it('collects uses, of, persists, and aggregate children (excluding syncs)', () => {
    const project = projectFrom({
      'card.md': value(),
      'game.md': aggregate('uses: [card]'),
      'game/deck.md': concept('kind: collection\nof: card\nuses: [card]\ninterface: export class Deck {}'),
      'game/deal.md': sync('game.deck#draw', 'game#deal'),
      'game-store.md': store('game'),
    });
    const game = project.concepts.get('game');
    const deck = project.concepts.get('game.deck');
    const gameStore = project.concepts.get('game-store');
    if (!game || !deck || !gameStore) throw new Error('fixture');
    expect(referencesOf(game, project).map((r) => `${r.field}:${r.to}`)).toEqual(['uses:card', 'child:game.deck']);
    expect(dependenciesOf(deck, project)).toEqual(['card']);
    expect(dependenciesOf(gameStore, project)).toEqual(['game']);
  });
});

describe('checkReferences', () => {
  it('accepts a valid graph', () => {
    expect(
      messages({ 'card.md': value(), 'game.md': aggregate('uses: [card]'), 'game/deck.md': value('uses: [card]') }),
    ).toEqual([]);
  });
  it('reports unknown concepts and self references', () => {
    expect(messages({ 'card.md': value('uses: [card, nope]') })).toEqual([
      'concepts/card.md: uses refers to itself',
      "concepts/card.md: unknown concept 'nope' in uses",
    ]);
  });
  it('reports references to private concepts with a hint', () => {
    const project = projectFrom({
      'game.md': aggregate(),
      'game/player.md': value(),
      'game/player/hand.md': value(),
      'lobby.md': value('uses: [game.player.hand]'),
    });
    const [d] = checkReferences(project);
    expect(d?.message).toBe("'game.player.hand' is not visible from 'lobby'");
    expect(d?.hint).toBe('game.player.hand is private to game.player; reference game.player instead, or move game.player.hand up a level');
  });
  it('forbids domain concepts depending on adapters', () => {
    expect(messages({ 'game.md': aggregate('uses: [game-store]'), 'game-store.md': store('game') })).toContain(
      "concepts/game.md: domain concept 'game' (aggregate) cannot depend on adapter 'game-store' (store)",
    );
  });
  it('forbids referencing syncs and persisting non-aggregates', () => {
    const found = messages({
      'card.md': value('uses: [deal]'),
      'deal.md': sync('card#a', 'card#b'),
      'card-store.md': store('card'),
    });
    expect(found).toContain("concepts/card.md: 'deal' is a sync; syncs cannot be referenced");
    expect(found).toContain("concepts/card-store.md: persists must reference an aggregate; 'card' is a value");
  });
});

describe('checkDependencyCycles', () => {
  it('reports a cycle once, on the first concept in it', () => {
    expect(messages({ 'a.md': value('uses: [b]'), 'b.md': value('uses: [a]') })).toEqual([
      'concepts/a.md: dependency cycle: a → b → a',
    ]);
  });
  it('does not treat a sync inside an aggregate as a dependency', () => {
    expect(
      messages({
        'game.md': aggregate(),
        'game/players.md': concept('kind: collection\nof: game.player\ninterface: |\n  export class Players {\n    join(): void;\n  }'),
        'game/player.md': value(),
        'game/deal-on-full-table.md': sync('game.players#join', 'game#deal'),
      }),
    ).toEqual([]);
  });
});
