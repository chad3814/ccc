---
kind: value
interface: |
  export type Suit = '♠' | '♥' | '♦' | '♣';
  export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
  export interface Card {
    readonly rank: Rank;
    readonly suit: Suit;
  }
  export function card(rank: Rank, suit: Suit): Card;
  export function sameCard(a: Card, b: Card): boolean;
---
## Intent
A playing card from a standard 52-card deck.

## Examples
- card("A", "♠") → { rank: "A", suit: "♠" }
- sameCard(card("A", "♠"), card("A", "♠")) → true
- sameCard(card("A", "♠"), card("K", "♠")) → false
