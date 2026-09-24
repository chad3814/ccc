---
kind: collection
of: card
interface: |
  export class DuplicateCard extends Error {}
  export class CardNotInHand extends Error {}
  export class Hand {
    constructor(cards?: readonly Card[]);
    add(card: Card): void;
    remove(card: Card): Card;
    has(card: Card): boolean;
    size(): number;
  }
---
## Intent
The cards a player currently holds.

## Rules
- A hand never contains the same card twice.

## Examples
- given an empty hand, add(A♠) → size is 1
- given hand [A♠], add(A♠) → throws DuplicateCard
- given hand [A♠], remove(K♥) → throws CardNotInHand
