---
kind: sync
when: game.players#join
then: [game#deal]
---
## Intent
Start the game automatically when the last seat fills.

## Rules
- Deal only when the join left no seats and the game is still "waiting".

## Examples
- given a 2-seat game with one player, the second join → the handler calls deal() once and the game is "playing"
- given a 3-seat game, the second join → the handler does not deal and the game stays "waiting"
