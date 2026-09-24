---
kind: sync
when: game.players#join
then: [game#deal]
---
## Intent
Start the round automatically once the table fills.

## Rules
- Only deal when the join made the table full and no round is in progress.

## Examples
- given 3 of 4 seats taken, join(user) → deal() called once
- given 2 of 4 seats taken, join(user) → deal() not called
