---
kind: collection
of: game.player
uses: [user]
interface: |
  export class TableFull extends Error {}
  export class Players {
    constructor(seats: number);
    join(user: UserId): Player;
    seatsLeft(): number;
    all(): readonly Player[];
  }
---
## Intent
Who is seated at a game, in seat order.

## Examples
- given 1 seat left, join(u) → seatsLeft() is 0
- given 0 seats left, join(u) → throws TableFull
