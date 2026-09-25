import { card, sameCard } from '../../card.js';
import { CardNotInHand, DuplicateCard, Hand } from './hand.js';

describe('game.player.hand', () => {
  it('[ex 1] adds a card to an empty hand', () => {
    const hand = new Hand();

    hand.add(card('A', '♠'));

    expect(hand.size()).toBe(1);
    expect(hand.has(card('A', '♠'))).toBe(true);
  });

  it('[ex 2] rejects adding a card already in the hand', () => {
    const hand = new Hand([card('A', '♠')]);

    expect(() => hand.add(card('A', '♠'))).toThrow(DuplicateCard);
  });

  it('[ex 3] removes a held card and leaves the rest', () => {
    const hand = new Hand([card('A', '♠'), card('K', '♥')]);

    const removed = hand.remove(card('K', '♥'));

    expect(sameCard(removed, card('K', '♥'))).toBe(true);
    const remaining = hand.cards();
    expect(remaining).toHaveLength(1);
    expect(sameCard(remaining[0], card('A', '♠'))).toBe(true);
  });

  it('[ex 4] rejects removing a card not in the hand', () => {
    const hand = new Hand([card('A', '♠')]);

    expect(() => hand.remove(card('K', '♥'))).toThrow(CardNotInHand);
  });
});
