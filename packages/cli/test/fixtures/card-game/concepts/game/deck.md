---
kind: collection
of: card
interface: |
  export class EmptyDeck extends Error {}
  export class Deck {
    static standard(): Deck;
    shuffle(random: () => number): void;
    draw(): Card;
    size(): number;
  }
---
## Intent
The undealt cards of a game.

## Rules
- A deck never contains the same card twice.

## Examples
- Deck.standard().size() → 52
- given an empty deck, draw() → throws EmptyDeck
