---
kind: entity
uses: [user, game.player.hand]
interface: |
  export class Player {
    constructor(user: UserId);
    readonly user: UserId;
    readonly hand: Hand;
  }
---
## Intent
A user seated at one game, with their hand for that game.

## Examples
- new Player(userId("u1")).hand.size() → 0
