---
kind: collection
of: game.player
uses: [user]
interface: |
  import type { Conflict } from '@ccc/runtime';
  export class TableFull extends Conflict {}
  export class AlreadySeated extends Conflict {}
  export class Players {
    constructor(seats: number, seated?: readonly Player[]);
    join(user: UserId): Player;
    seats(): number;
    seatsLeft(): number;
    all(): readonly Player[];
    byUser(user: UserId): Player | undefined;
  }
---
## Intent
Who is seated at a game, in seat order.

## Rules
- Seats fill in join order; all() lists players by seat.

## Examples
- given 2 seats, join(userId("u1")) → seatsLeft() is 1 and all() is [the new player]
- given 2 seats with u1 and u2 seated, join(userId("u3")) → throws TableFull
- given u1 seated, join(userId("u1")) → throws AlreadySeated
- given u1 seated, byUser(userId("u1")) → u1's player; byUser(userId("u9")) → undefined
