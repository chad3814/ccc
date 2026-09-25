---
kind: entity
uses: [user, game.player.hand]
interface: |
  export class Player {
    constructor(user: UserId, hand?: Hand, points?: number);
    readonly user: UserId;
    readonly hand: Hand;
    points(): number;
    scorePoint(): void;
  }
---
## Intent
A user seated at one game, with their hand and the tricks they have won.

## Examples
- new Player(userId("u1")) → hand.size() is 0 and points() is 0
- given a player, scorePoint() twice → points() is 2
- new Player(userId("u1"), new Hand([card("A", "♠")]), 3) → hand.size() is 1 and points() is 3
