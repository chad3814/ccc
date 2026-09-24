---
kind: store
persists: game
interface: |
  export class GameStore {
    load(id: string): Promise<Game | null>;
    save(game: Game): Promise<void>;
  }
---
## Intent
Saves and loads games.

## Schema
```sql
create table games (
  id text primary key,
  state jsonb not null
);
```

## Examples
- save(game) then load(game.id) → an equal game
- load("missing") → null
