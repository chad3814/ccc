import { describe, expect, it } from 'vitest';
import {
  ACTION_PATTERN,
  ID_PATTERN,
  ancestorsOf,
  idToPath,
  isValidSegment,
  isVisible,
  parentOf,
  parseActionRef,
  pathToId,
} from '../src/ids.js';

describe('isValidSegment', () => {
  it.each(['game', 'game-store', 'v2', 'a1-b2'])('accepts %s', (s) => {
    expect(isValidSegment(s)).toBe(true);
  });
  it.each(['Game', 'game_store', '1game', 'game-', '-game', '', 'game.store'])('rejects %j', (s) => {
    expect(isValidSegment(s)).toBe(false);
  });
});

describe('pathToId / idToPath', () => {
  it('maps nested paths to dotted ids', () => {
    expect(pathToId('game/player/hand.md')).toBe('game.player.hand');
    expect(pathToId('card.md')).toBe('card');
  });
  it('round-trips', () => {
    expect(idToPath('game.player.hand')).toBe('game/player/hand.md');
  });
  it('throws for non-markdown paths', () => {
    expect(() => pathToId('card.txt')).toThrow('not a concept file');
  });
});

describe('parentOf / ancestorsOf', () => {
  it('finds the parent', () => {
    expect(parentOf('game.player.hand')).toBe('game.player');
    expect(parentOf('card')).toBeNull();
  });
  it('lists ancestors nearest first', () => {
    expect(ancestorsOf('game.player.hand')).toEqual(['game.player', 'game']);
    expect(ancestorsOf('card')).toEqual([]);
  });
});

describe('isVisible', () => {
  it.each([
    ['game.player', 'game.player.hand', true, 'own child'],
    ['game.player.hand', 'game.player.score', true, 'sibling'],
    ['game.player.hand', 'card', true, 'top-level concept'],
    ['game.player.hand', 'game.deck', true, 'sibling of an ancestor'],
    ['game.deal-on-full-table', 'game', true, 'ancestor'],
    ['game', 'game.player.hand', false, 'grandchild is private'],
    ['game-api', 'game.player', false, 'nested inside another concept'],
    ['card', 'card', false, 'self'],
  ])('%s → %s is %s (%s)', (from, target, expected) => {
    expect(isVisible(from, target)).toBe(expected);
  });
});

describe('patterns and action refs', () => {
  it('matches ids and actions', () => {
    expect(ID_PATTERN.test('game.player.hand')).toBe(true);
    expect(ID_PATTERN.test('game..hand')).toBe(false);
    expect(ACTION_PATTERN.test('game.players#join')).toBe(true);
    expect(ACTION_PATTERN.test('game.players.join')).toBe(false);
  });
  it('splits an action ref', () => {
    expect(parseActionRef('game.players#join')).toEqual({ conceptId: 'game.players', member: 'join' });
  });
});
