---
kind: endpoint
uses: [card, user, game, game-store, auth, leaderboard-store]
interface: |
  import type { Database } from '@ccc/runtime';
  export interface GameApiDeps {
    readonly db: Database;
    readonly auth: Auth;
    readonly gameStore: GameStore;
    readonly leaderboardStore: LeaderboardStore;
  }
  export function createHandler(deps: GameApiDeps): (request: Request) => Promise<Response>;
---
## Intent
The HTTP API for playing High Card.

## Rules
- Every /games route needs `Authorization: Bearer <token>`, resolved with auth.authenticate; without a valid one → 401 {"error": string}. GET /leaderboard is public.
- POST /games with JSON {"seats": 2 | 3 | 4} → 201 {"id": string}. The game gets a random id (crypto.randomUUID()) and a random seed (an integer from 0 to 2^32 − 1), starts with no players, and is saved.
- POST /games/:id/join → 200 with the caller's GameView (the game's view(caller)). Run the join inside `withScope({ 'game': game }, ...)` so the deal-on-full-table sync can deal, then save.
- POST /games/:id/play with JSON {"rank": Rank, "suit": Suit} → 200 {"result": PlayResult, "view": GameView}. Run the play inside `withScope({ 'game': game }, ...)` so the record-winner sync can run, then save.
- GET /games/:id → 200 with the caller's GameView.
- GET /leaderboard → 200 with the top 10 standings as [{"userId": string, "wins": number}].
- An unknown game id → 404. The game's errors (TableFull, AlreadySeated, AlreadyDealt, TableNotFull, GameNotStarted, GameFinished, NotYourTurn, NotSeated, CardNotInHand) all extend Conflict from '@ccc/runtime', so answer any DomainError with errorResponse(err) (409 {"error": string}); join with game.players.join(userId). An invalid body or malformed JSON → 400 {"error": string}. Any other error is a 500.
- Every other route is left to other endpoints (unmatched).

## Examples
- POST /games {"seats": 2} without a token → 401
- POST /games {"seats": 2} with a token → 201 with an id; GET /games/<id> → 200 with status "waiting" and no players
- two users (sessions from auth.signup) join a 2-seat game → the second join's view has status "playing" and 5 cards in hand
- a third user joins a full 2-seat game → 409
- once a 2-seat game is playing, the player whose turn it isn't plays a card from their hand → 409
- the player whose turn it is plays the first card of their view's hand → 200; result.trickComplete is false and view.table lists that card
- two players play every card, each playing the first card of their hand when view.turn is theirs → the tenth response has result.finished true and a winner, and GET /leaderboard lists that winner with 1 win
- GET /games/unknown-id with a token → 404
