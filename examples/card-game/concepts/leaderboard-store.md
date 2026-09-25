---
kind: store
persists: leaderboard
uses: [user]
interface: |
  import type { Database } from '@ccc/runtime';
  export class LeaderboardStore {
    constructor(db: Database);
    recordWin(user: UserId): Promise<void>;
    top(limit: number): Promise<Standing[]>;
  }
---
## Intent
Keeps win counts per user.

## Rules
- top(limit) orders by wins (descending), then user id (ascending).

## Schema
```sql
create table leaderboard (
  user_id text primary key,
  wins integer not null
);
```

## Examples
- recordWin(u1) twice and recordWin(u2) once → top(10) is [{ userId: u1, wins: 2 }, { userId: u2, wins: 1 }]
- top(10) of an empty leaderboard → []
