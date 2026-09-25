---
kind: endpoint
uses: [card, user, game, game-store, auth]
interface: |
  import type { Database } from '@ccc/runtime';
  export interface GameApiDeps {
    readonly db: Database;
    readonly auth: Auth;
    readonly gameStore: GameStore;
  }
  export function createHandler(deps: GameApiDeps): (request: Request) => Promise<Response>;
---
## Intent
The HTTP API for playing High Card.

## Rules
- Every /games route needs `Authorization: Bearer <token>`, resolved with auth.authenticate; without a valid one → 401 {"error": string}.
- POST /games with JSON {"seats": 2 | 3 | 4} → 201 {"id": string}. The game gets a random id (crypto.randomUUID()) and a random seed (an integer from 0 to 2^32 − 1), starts with no players, and is saved.
- POST /games/:id/join → 200 with the caller's GameView (the game's view(caller)). Run the join inside `withScope({ 'game': game }, ...)` so the deal-on-full-table sync can deal, then save.
- POST /games/:id/play with JSON {"rank": Rank, "suit": Suit} → 200 {"result": PlayResult, "view": GameView}. Run the play inside `withScope({ 'game': game }, ...)` so the record-winner sync can run, then save.
- GET /games/:id → 200 with the caller's GameView.
- An unknown game id → 404. The game's errors (TableFull, AlreadySeated, AlreadyDealt, TableNotFull, GameNotStarted, GameFinished, NotYourTurn, NotSeated, CardNotInHand) all extend Conflict from '@ccc/runtime', so answer any DomainError with errorResponse(err) (409 {"error": string}); join with game.players.join(userId). An invalid body or malformed JSON → 400 {"error": string}. Any other error is a 500.

## Examples
- POST /games {"seats": 2} without a token → 401
- POST /games {"seats": 2} with a token → 201 with an id; GET /games/<id> → 200 with status "waiting" and no players
- two users (sessions from auth.signup) join a 2-seat game → the second join's view has status "playing" and 5 cards in hand
- a third user joins a full 2-seat game → 409
- once a 2-seat game is playing, the player whose turn it isn't takes the first card of their own view's hand (GET /games/<id> with their own token) and sends POST /games/<id>/play with body {"rank": card.rank, "suit": card.suit} → 409
- the player whose turn it is takes the first card of their own view's hand (GET /games/<id> with their own token) and sends POST /games/<id>/play with body {"rank": card.rank, "suit": card.suit} → 200 with body {"result": PlayResult, "view": GameView}; result.trickComplete is false and view.table lists that card
- two players play all 10 cards: before each play, find whose turn it is from GET /games/<id>, then that player fetches their own view with their own token and sends POST /games/<id>/play with body {"rank": card.rank, "suit": card.suit} for the first card of their hand → every play is 200, and the tenth response's body has result.finished true and a non-null result.winner
- GET /games/unknown-id with a token → 404
