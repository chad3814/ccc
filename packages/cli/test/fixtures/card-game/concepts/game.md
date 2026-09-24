---
kind: aggregate
uses: [card, user]
interface: |
  export class RoundInProgress extends Error {}
  export class Game {
    constructor(id: string, seats: number);
    readonly id: string;
    readonly players: Players;
    deal(): void;
    play(user: UserId, played: Card): void;
    isRoundInProgress(): boolean;
  }
---
## Intent
One table of a card game: its seats, deck, and the round being played.

## Rules
- Every card is in exactly one place: the deck or one player's hand.
- Dealing is only allowed when no round is in progress.

## Examples
- given a new 4-seat game, deal() → each seated player holds 13 cards, deck is empty
- given a round in progress, deal() → throws RoundInProgress
- given a dealt game, play(user, a card in their hand) → the card leaves their hand

## Decisions
- Seats are fixed at creation; changing table size mid-game isn't a real-world need.
