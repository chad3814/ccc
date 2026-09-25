---
kind: collection
of: card
interface: |
  import type { Conflict } from '@ccc/runtime';
  export class DuplicateCard extends Conflict {}
  export class CardNotInHand extends Conflict {}
  export class Hand {
    constructor(cards?: readonly Card[]);
    add(card: Card): void;
    remove(card: Card): Card;
    has(card: Card): boolean;
    size(): number;
    cards(): readonly Card[];
  }
---
## Intent
The cards a player currently holds, in the order they were received.

## Rules
- A hand never holds the same card twice.

## Examples
- given an empty hand, add(card("A", "♠")) → size() is 1 and has(card("A", "♠")) is true
- given a hand holding A♠, add(card("A", "♠")) → throws DuplicateCard
- given a hand holding A♠ and K♥, remove(card("K", "♥")) → returns K♥, and cards() is [A♠]
- given a hand holding A♠, remove(card("K", "♥")) → throws CardNotInHand
