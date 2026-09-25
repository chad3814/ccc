---
kind: collection
of: card
interface: |
  export class EmptyDeck extends Error {}
  export class Deck {
    constructor(cards: readonly Card[]);
    static standard(): Deck;
    shuffled(seed: number): Deck;
    draw(): Card;
    size(): number;
    cards(): readonly Card[];
  }
---
## Intent
The undealt cards of a game.

## Rules
- A deck never holds the same card twice.
- standard() orders cards by suit (in SUITS order), then rank (in RANKS order).
- shuffled(seed) returns a new deck and leaves the original unchanged; the same seed always gives the same order.
- draw() removes and returns the top card, which is the last element of cards().

## Examples
- Deck.standard().size() → 52, and its cards contain no duplicates
- Deck.standard().shuffled(42) → the same 52 cards in a different order; shuffled(42) again → the same order; shuffled(43) → a different order
- given new Deck([card("A", "♠"), card("K", "♥")]), draw() → K♥ and size() is then 1
- given new Deck([]), draw() → throws EmptyDeck

## Decisions
- The shuffle is Fisher–Yates from the last index down, choosing j = Math.floor(next() * (i + 1)), where next comes from mulberry32(seed):

```ts
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```
