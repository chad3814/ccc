# Card game example: High Card

This whole game is defined as concepts in `concepts/`. The only hand-written code is `handwritten/user.ts`, which is one line of real logic. `ccc build` generates everything else into `.ccc/`.

**The game.** Two to four players join a table. When the last seat fills, a sync deals 5 cards each. Players take turns playing one card per trick, and the strongest card wins the trick. After 5 tricks, the player with the most tricks wins, and a second sync records the win on a leaderboard.

## The model

| Concept | Kind | Notes |
|---|---|---|
| `user` | value (handwritten) | `UserId` |
| `card` | value | ranks, suits, `beats` |
| `game` | aggregate | contains `deck`, `player` (with `hand`), `players` |
| `game.deal-on-full-table` | sync | `players#join` → `game#deal` |
| `leaderboard` | aggregate | standings |
| `auth` | auth | email/password, bearer tokens, owns `users` and `sessions` tables |
| `game-store`, `leaderboard-store` | store | Postgres tables |
| `record-winner` | sync | `game#play` → `leaderboard-store#recordWin` (domain → adapter) |
| `auth-api`, `game-api`, `leaderboard-api` | endpoint | HTTP |

## Build it

Generation calls Claude, so it needs credentials: an `ANTHROPIC_API_KEY` in the environment (for example through 1Password), or an `ant auth login` profile.

```bash
pnpm install && pnpm build                 # from the repo root: builds ccc itself
cd examples/card-game
pnpm check                                  # validate the model (no LLM)
pnpm exec ccc build --dry-run               # 31 generations planned
op run --env-file=.env -- pnpm generate     # generate (.env holds ANTHROPIC_API_KEY=op://…)
pnpm approve                                # read and approve each generated test file
pnpm verify-generated                       # CI gate: current, approved, passing
pnpm smoke                                  # play a full game over the generated HTTP API
pnpm stats                                  # pass rates and cost
```

Serve it for real against Postgres:

```bash
DATABASE_URL=postgres://localhost/cardgame pnpm exec ccc db reset
DATABASE_URL=postgres://localhost/cardgame PORT=3000 pnpm serve
```

## Play over HTTP

```bash
curl -s -XPOST localhost:3000/auth/signup -d '{"email":"a@x.io","password":"pw"}' -H 'content-type: application/json'
# → {"token":"…","userId":"…"}
curl -s -XPOST localhost:3000/games -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"seats":2}'
curl -s -XPOST localhost:3000/games/$ID/join -H "authorization: Bearer $TOKEN"
curl -s -XPOST localhost:3000/games/$ID/play -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"rank":"A","suit":"♠"}'
curl -s localhost:3000/leaderboard
```
