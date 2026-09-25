---
kind: sync
when: game#play
then: [leaderboard-store#recordWin]
---
## Intent
Put a game's winner on the leaderboard when the game ends.

## Rules
- Record a win only when the play finished the game (result.finished) and there is a winner.

## Examples
- given a play whose result has finished true and winner u1 → the handler calls leaderboardStore.recordWin(u1) once
- given a play whose result has finished false → the handler records nothing
