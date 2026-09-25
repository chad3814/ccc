---
kind: endpoint
uses: [game, game-store, auth]
interface: |
  import type { Database } from '@ccc/runtime';
  export interface GameApiDeps {
    readonly db: Database;
    readonly gameStore: GameStore;
    readonly auth: Auth;
  }
  export function createHandler(deps: GameApiDeps): (request: Request) => Promise<Response>;
---
## Intent
HTTP access to games for authenticated players.

## Examples
- POST /games/:id/join without a session → 401
- POST /games/:id/play with a card not in hand → 409
