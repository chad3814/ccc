# Writing concepts

How to write concepts that generate good code. [schema.md](schema.md) says what a concept file may contain; this guide is about what to put in it. The examples come from the card game in [examples/card-game/concepts](../examples/card-game/concepts).

Two readers see every concept: the model that writes its tests, and the model that writes its implementation. Neither can ask you a question. Anything the concept doesn't say, they guess, and they don't always guess the same way. Most build failures are a concept that left something open.

## The loop

```bash
ccc check                  # after every edit: free, and catches most mistakes
ccc build --dry-run        # what will regenerate
ccc build game             # one concept and whatever it depends on
ccc approve                # read the tests before trusting them
```

Build one concept at a time while you're writing it. Start with the leaves (`card`, `user`) and work up, so each concept's dependencies already exist and pass.

Editing a concept regenerates its tests and implementation, and the new tests need approving again. Formatting-only edits are free: whitespace and key order don't change the cache key. A dependency's Rules and Decisions don't regenerate its dependents; only its interface does.

## Choosing concepts

- **One concept, one idea.** `card` knows how cards compare; `game.deck` knows how to shuffle them; `game` knows the rules of play. A concept whose Intent needs "and" twice is probably two concepts.
- **Not too small.** A concept per function turns the model into pseudocode, and every extra concept is an extra interface to keep consistent. `game.players` earns its place because seating has its own rules (seat order, `TableFull`, `AlreadySeated`).
- **Nest what's private.** `game.player.hand` lives under `game/player/` because nothing outside the player needs it. Anything nested is invisible above its parent, so nesting doubles as encapsulation.
- **Choose the kind by what it does:**

| If it… | Kind |
|---|---|
| is data compared by its fields (a card, a user id) | `value` |
| has identity and changes over time (a player) | `entity` |
| holds and manages other concepts (a hand of cards, the seated players) | `collection` |
| owns children and enforces rules across them (a game) | `aggregate` |
| saves and loads an aggregate | `store` |
| answers HTTP requests | `endpoint` |
| turns a request into an identity | `auth` |
| reacts to an action on one concept by acting on another | `sync` |

Keep I/O out of domain kinds. If `game` needs to update the leaderboard, don't make it depend on the store; write a sync (`record-winner`).

## The interface

The interface is the contract: other concepts compile against it, conformance checks the implementation against it, and it's the only part of a concept its dependents see.

```yaml
interface: |
  import type { Conflict } from '@ccc/runtime';
  export class TableFull extends Conflict {}
  export class AlreadySeated extends Conflict {}
  export class Players {
    constructor(seats: number, seated?: readonly Player[]);
    join(user: UserId): Player;
    seatsLeft(): number;
    all(): readonly Player[];
    byUser(user: UserId): Player | undefined;
  }
```

- **Declare every error as a class.** Tests assert on the class (`throws TableFull`), and endpoints map it to a status. Extend a runtime error when HTTP should see it: `Conflict` → 409, `Invalid` → 400, `NotFound` → 404, `Unauthorized` → 401. Then an endpoint answers every domain error with one `errorResponse(err)`.
- **Name the primary class after the concept** (`game.players` → `Players`). Syncs resolve `game.players#join` to `Players.join`.
- **Don't write imports.** Types from concepts in `uses` (`UserId`, `Player`) are imported automatically when the interface mentions them. The one allowed import is `import type { … } from '@ccc/runtime'`.
- **Prefer `readonly`** for fields and arrays. It tells both readers what may change.
- **Pass randomness and time in.** `new Game(id, seats, seed)` takes its seed, so tests can reproduce a game; the endpoint picks a random seed. Code that calls `Math.random()` inside can't be tested precisely.
- **Put persistence into the interface when a store needs it.** `toState()` and `static fromState(state)` let `game-store` save a game without knowing its internals.
- **Every name used in Rules and Examples should be in the interface.** A test can only call what's declared.

## Intent

One or two sentences on what the concept is for, in domain terms. It frames everything else, so make it specific:

> One table of High Card: players join, each is dealt a hand, and they play tricks until their hands are empty. Each trick goes to the strongest card, and the player who wins the most tricks wins the game.

## Rules

Rules are the specification. The implementation must follow them, and tests use them to set up and check examples. Write them as precise, testable statements:

- **Be exact about order, ranges, and ties.** "Suits break ties from strongest to weakest: ♠, ♥, ♦, ♣" leaves nothing to guess. "The winner has the most points, and ties go to the earliest-seated player" closes the case a model would otherwise invent.
- **Name the error for every failure.** "deal() needs every seat taken (else TableNotFull) and works once (else AlreadyDealt)."
- **Cover inputs that aren't the happy path.** When an example calls `view()` for someone who isn't seated, the Rules must say what happens: "view(viewer) never throws: a viewer who isn't seated sees an empty hand." Otherwise one model throws and another doesn't.
- **Say how, when the how matters to other concepts.** "fromState builds Players from the seated players (new Players(seats, seated)); it never calls join." Calling `join` would fire the deal sync while loading a saved game.
- **Say each thing once.** The request body for `POST /games` is in the Rules; the Examples don't repeat it. Both models read the whole concept, and a fact written twice can drift into two facts.
- **Put a rule on the lowest concept that can see everything it mentions.** "A hand never contains the same card twice" belongs to `hand`, not `game`.
- **Leave out conventions ccc already follows.** Endpoints answer routes they don't own with `unmatched()`, and endpoints map `DomainError`s through `errorResponse`. Rules only need to cover what's particular to this concept.

## Examples

Every example bullet becomes exactly one test, named `[ex N]` after its position. When `[ex 6]` fails, bullet 6 is where to look. Examples are what the implementation is held to, so they're the most important thing you write.

```markdown
- given 2 seats, join(userId("u1")) → seatsLeft() is 1 and all() is [the new player]
- given 2 seats with u1 and u2 seated, join(userId("u3")) → throws TableFull
```

- **Given, action, outcome.** State the setup, the call, and what must be true after. Use the interface's own names so the test writer can translate directly.
- **One behavior per bullet.** A bullet can check several facts about one behavior (status, turn, and hand size after a deal) but shouldn't test two unrelated behaviors. Splitting them makes failures point somewhere useful.
- **Never depend on what a seed or random choice produces.** "Player 1 plays A♠" assumes the seeded deal gave them A♠, and the test fails for reasons unrelated to the code. Describe values by their role instead, and let the test read them through the interface:
  - "the player whose turn it is plays the first card of their view's hand"
  - "the player whose card beats the other's scores 1 point"
- **Build setup through the interface.** "given a 2-seat game that two users joined through players.join" tells the test how to get there. A setup the interface can't reach ("given a game with 3 points") forces the test to fake state.
- **Cover each error at least once**, and every branch a Rule describes. A Rule with no example is enforced only by the prompt.
- **Name the outcome, not the mechanism.** "the second join's view has status "playing" and 5 cards in hand" says what a user sees; it doesn't prescribe how the deal happened.
- **Keep example values concrete.** `userId("u1")`, `card("A", "♠")`, `{"seats": 2}`. Concrete values make tests readable and failures obvious.

Longer bullets can continue on indented lines.

## Decisions

Decisions record why: choices a future reader might otherwise undo. They go into every generation too, so they steer the model as well.

```markdown
## Decisions
- Seeded shuffles keep games reproducible and testable; the endpoint picks a random seed per game.
- The trick winner leads the next trick, which is the common convention.
```

A decision that constrains behavior ("the trick winner leads") should also be a Rule. Decisions explain; Rules specify.

## Syncs

A sync connects an action to reactions without making the concepts depend on each other:

```markdown
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
```

- **Conditions go in Rules.** The handler receives the trigger's arguments, its result, and the targets; it decides whether to act. Write the condition in terms of those: "only when the play finished the game (result.finished) and there is a winner."
- **Give an example for acting and one for not acting.** The negative case is the one that goes wrong.
- **Return what the sync needs.** `record-winner` can check `result.finished` only because `play()` returns a `PlayResult`. If a sync needs information, put it in the trigger's return type.
- **Place the file in the lowest directory containing everything it connects.** `deal-on-full-table` connects `game.players` and `game`, so it lives in `concepts/game/`. `record-winner` connects `game` and `leaderboard-store`, so it's top-level.
- **Endpoints must bind domain targets.** A sync that acts on `game` finds it in the request's scope, so the endpoint's Rules say "run the join inside `withScope({ 'game': game }, ...)`, then save." Stores and auth are bound automatically.

## Adapters

### Stores

Give the table in `## Schema`, and say how the aggregate maps to it:

```markdown
## Rules
- A game is stored as its toState() JSON; load restores it with Game.fromState.
- save inserts a new game or replaces the stored state of an existing one.
```

Say what `load` returns for a missing id (`null`) and what `save` does to an existing row. Those are the choices a model otherwise makes for you.

### Endpoints

- **One endpoint per area.** `GET /leaderboard` lives in `leaderboard-api`, not `game-api`. An endpoint only describes the routes it owns.
- **Write each route as a Rule:** method, path, body shape, success status, and response body. "POST /games with JSON {"seats": 2 | 3 | 4} → 201 {"id": string}."
- **Say what each failure returns:** a missing token → 401, an unknown id → 404, a domain error → 409 through `errorResponse`, a malformed body → 400.
- **Examples go through HTTP.** "a third user joins a full 2-seat game → 409." Endpoint tests run the whole app, so they're the closest thing to a user.
- **List the dependencies it receives** in the `deps` interface (`db`, plus adapters by camelCase id: `gameStore`, `auth`).

### Auth

Auth is generated code handling credentials. It's fine for a prototype; don't ship it. Say exactly how tokens are issued and checked, and what `authenticate` returns for a missing, malformed, or unknown token.

## Handwritten concepts

When code shouldn't be generated, mark the concept `implementation: handwritten` and point `source` at your module. It still needs an interface and examples, and its generated tests hold your code to them. `user` is handwritten because a branded id type is one line of code and not worth a model call.

## When a build fails

The build error lists the last attempt's problems. Before rerunning, decide which of three things is wrong:

- **The concept is ambiguous.** Attempts fail in different ways, or the model keeps making one reasonable-looking choice you didn't intend. Tighten the Rule or the Example; this is the usual case.
- **The test is wrong.** Every attempt fails the same unapproved test, and the build error says so. Read the test against its example. If it assumes something the concept doesn't say, fix the concept and let the test regenerate. To regenerate it without editing the concept, delete `.ccc/gen/<id>.test.ts` and run `ccc tests <id>`.
- **The concept is too big.** Every attempt runs out of room or gets something different wrong. Split it.

Raising `maxAttempts` or escalating to a stronger model can get an under-specified concept through, but the next regeneration might resolve the ambiguity differently. Fixing the concept is what makes regeneration safe.

## Checklist

- [ ] `ccc check` passes.
- [ ] The Intent is specific to this concept.
- [ ] Every error is a class in the interface; errors HTTP should see extend a runtime error.
- [ ] Randomness and time are passed in, not reached for.
- [ ] Rules cover order, ties, edge inputs, and every failure.
- [ ] Each fact is written once.
- [ ] Every Rule has an example; every error is exercised.
- [ ] No example depends on what a seed produces.
- [ ] Every example's setup can be reached through the interface.
- [ ] Syncs have an acting and a non-acting example; endpoints bind what syncs need.
