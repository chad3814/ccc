---
kind: endpoint
uses: [leaderboard-store]
interface: |
  import type { Database } from '@ccc/runtime';
  export interface LeaderboardApiDeps {
    readonly db: Database;
    readonly leaderboardStore: LeaderboardStore;
  }
  export function createHandler(deps: LeaderboardApiDeps): (request: Request) => Promise<Response>;
---
## Intent
The public leaderboard over HTTP.

## Rules
- GET /leaderboard → 200 with the top 10 standings as [{"userId": string, "wins": number}], most wins first. No token is needed.

## Examples
- GET /leaderboard with nothing recorded → 200 []
- after leaderboardStore.recordWin(u1) twice and recordWin(u2) once → GET /leaderboard is 200 [{"userId": u1, "wins": 2}, {"userId": u2, "wins": 1}]
