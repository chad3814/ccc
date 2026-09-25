---
kind: value
interface: |
  export type Suit = '♠' | '♥' | '♦' | '♣';
  export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
  export interface Card {
    readonly rank: Rank;
    readonly suit: Suit;
  }
  export const SUITS: readonly Suit[];
  export const RANKS: readonly Rank[];
  export function card(rank: Rank, suit: Suit): Card;
  export function sameCard(a: Card, b: Card): boolean;
  export function beats(a: Card, b: Card): boolean;
---
## Intent
A playing card from a standard 52-card deck, and how cards compare.

## Rules
- Ranks order from low to high: 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, A.
- Suits break ties from strongest to weakest: ♠, ♥, ♦, ♣.
- beats(a, b) is true when a's rank is higher, or the ranks are equal and a's suit is stronger.

## Examples
- card("A", "♠") → { rank: "A", suit: "♠" }
- sameCard(card("10", "♥"), card("10", "♥")) → true; sameCard(card("10", "♥"), card("10", "♦")) → false
- beats(card("A", "♣"), card("K", "♠")) → true (rank decides first)
- beats(card("7", "♠"), card("7", "♥")) → true; beats(card("7", "♥"), card("7", "♠")) → false
- RANKS is ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]; SUITS is ["♠", "♥", "♦", "♣"]
