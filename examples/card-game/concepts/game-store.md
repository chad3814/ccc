---
kind: store
persists: game
interface: |
  import type { Database } from '@ccc/runtime';
  export class GameStore {
    constructor(db: Database);
    load(id: string): Promise<Game | null>;
    save(game: Game): Promise<void>;
  }
---
## Intent
Saves and loads games.

## Rules
- A game is stored as its toState() JSON; load restores it with Game.fromState.
- save inserts a new game or replaces the stored state of an existing one.

## Schema
```sql
create table games (
  id text primary key,
  state jsonb not null
);
```

## Examples
- save(a new 2-seat game) then load(its id) → a game whose toState() equals the original's
- given a saved game, a second save after a player joins, then load → the loaded game has that player
- load("missing") → null
