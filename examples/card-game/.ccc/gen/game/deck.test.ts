import { Deck, EmptyDeck } from './deck.js';
import { card, sameCard, type Card } from '../card.js';

const key = (c: Card): string => `${c.rank}${c.suit}`;
const keys = (cs: readonly Card[]): string[] => cs.map(key);

describe('game.deck', () => {
  it('[ex 1] standard deck has 52 distinct cards', () => {
    const deck = Deck.standard();
    expect(deck.size()).toBe(52);
    const all = deck.cards();
    expect(all.length).toBe(52);
    expect(new Set(keys(all)).size).toBe(52);
  });

  it('[ex 2] shuffled(seed) permutes deterministically and differs per seed', () => {
    const standard = Deck.standard();
    const standardOrder = keys(standard.cards());

    const a = standard.shuffled(42);
    const aOrder = keys(a.cards());

    expect(aOrder.length).toBe(52);
    expect([...aOrder].sort()).toEqual([...standardOrder].sort());
    expect(aOrder).not.toEqual(standardOrder);

    const again = Deck.standard().shuffled(42);
    expect(keys(again.cards())).toEqual(aOrder);

    const other = Deck.standard().shuffled(43);
    expect([...keys(other.cards())].sort()).toEqual([...standardOrder].sort());
    expect(keys(other.cards())).not.toEqual(aOrder);
  });

  it('[ex 3] draw returns the top card and shrinks the deck', () => {
    const deck = new Deck([card('A', '♠'), card('K', '♥')]);
    const drawn = deck.draw();
    expect(sameCard(drawn, card('K', '♥'))).toBe(true);
    expect(deck.size()).toBe(1);
  });

  it('[ex 4] drawing from an empty deck throws EmptyDeck', () => {
    const deck = new Deck([]);
    expect(() => deck.draw()).toThrow(EmptyDeck);
  });
});
