---
kind: endpoint
uses: [game, game-store, auth]
interface: |
  export function handle(request: Request): Promise<Response>;
---
## Intent
HTTP access to games for authenticated players.

## Examples
- POST /games/:id/join without a session → 401
- POST /games/:id/play with a card not in hand → 409
