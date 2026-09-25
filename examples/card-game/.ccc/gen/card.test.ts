import { card, sameCard, beats, RANKS, SUITS } from './card.js';

describe('card', () => {
  it('[ex 1] builds a card from a rank and a suit', () => {
    expect(card('A', '♠')).toEqual({ rank: 'A', suit: '♠' });
  });

  it('[ex 2] compares cards by rank and suit for identity', () => {
    expect(sameCard(card('10', '♥'), card('10', '♥'))).toBe(true);
    expect(sameCard(card('10', '♥'), card('10', '♦'))).toBe(false);
  });

  it('[ex 3] lets rank decide first', () => {
    expect(beats(card('A', '♣'), card('K', '♠'))).toBe(true);
  });

  it('[ex 4] breaks equal ranks by suit strength', () => {
    expect(beats(card('7', '♠'), card('7', '♥'))).toBe(true);
    expect(beats(card('7', '♥'), card('7', '♠'))).toBe(false);
  });

  it('[ex 5] exposes the rank and suit orders', () => {
    expect([...RANKS]).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);
    expect([...SUITS]).toEqual(['♠', '♥', '♦', '♣']);
  });
});
