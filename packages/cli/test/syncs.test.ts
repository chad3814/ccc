import { describe, expect, it } from 'vitest';
import { collectExports } from '../src/interfaces.js';
import { checkSyncActions, checkSyncCycles, primaryClassName } from '../src/syncs.js';
import { concept, projectFrom } from './helpers.js';

const GAME = concept('kind: aggregate\ninterface: |\n  export class Game {\n    deal(): void;\n    finish(): void;\n  }\n  export function newGame(): Game;');
const PLAYERS = concept('kind: entity\ninterface: |\n  export class Players {\n    join(): void;\n  }');
const sync = (when: string, then: string): string => concept(`kind: sync\nwhen: ${when}\nthen: [${then}]`);

function actionMessages(files: Record<string, string>): string[] {
  const project = projectFrom(files);
  return checkSyncActions(project, collectExports(project)).map((d) => `${d.file}: ${d.message}`);
}

describe('primaryClassName', () => {
  it('PascalCases the last id segment', () => {
    expect(primaryClassName('game.players')).toBe('Players');
    expect(primaryClassName('game-store')).toBe('GameStore');
    expect(primaryClassName('game')).toBe('Game');
  });
});

describe('checkSyncActions', () => {
  it('accepts methods on the primary class and exported functions', () => {
    expect(
      actionMessages({
        'game.md': GAME,
        'game/players.md': PLAYERS,
        'game/deal-on-full-table.md': sync('game.players#join', 'game#deal, game#newGame'),
      }),
    ).toEqual([]);
  });
  it('reports missing actions with the class it looked for', () => {
    const project = projectFrom({ 'game.md': GAME, 'game/players.md': PLAYERS, 'game/deal.md': sync('game.players#leave', 'game#deal') });
    const [d] = checkSyncActions(project, collectExports(project));
    expect(d?.file).toBe('concepts/game/deal.md');
    expect(d?.message).toBe("game.players#leave: 'game.players' has no exported function 'leave' and no method 'leave' on class Players");
    expect(d?.hint).toBe('actions are exported functions, or methods of the class named after the concept (Players)');
  });
  it('skips unknown concepts (reported by the reference check)', () => {
    expect(actionMessages({ 'game.md': GAME, 'deal.md': sync('nope#x', 'game#deal') })).toEqual([]);
  });
});

describe('checkSyncCycles', () => {
  it('accepts acyclic syncs', () => {
    const project = projectFrom({ 'game.md': GAME, 'deal.md': sync('game#deal', 'game#finish') });
    expect(checkSyncCycles(project)).toEqual([]);
  });
  it('reports direct and transitive cycles', () => {
    const selfLoop = projectFrom({ 'game.md': GAME, 'again.md': sync('game#deal', 'game#deal') });
    expect(checkSyncCycles(selfLoop).map((d) => `${d.file}: ${d.message}`)).toEqual([
      'concepts/again.md: sync cycle: game#deal → game#deal',
    ]);
    const transitive = projectFrom({
      'game.md': GAME,
      'a.md': sync('game#deal', 'game#finish'),
      'b.md': sync('game#finish', 'game#deal'),
    });
    const [d] = checkSyncCycles(transitive);
    expect(d?.message).toBe('sync cycle: game#deal → game#finish → game#deal');
    expect(d?.file).toBe('concepts/a.md');
    expect(d?.hint).toBe('a sync must not directly or transitively re-trigger its own when action');
  });
});
