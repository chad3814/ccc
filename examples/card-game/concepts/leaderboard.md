---
kind: aggregate
uses: [user]
interface: |
  export interface Standing {
    readonly userId: UserId;
    readonly wins: number;
  }
  export class Leaderboard {
    constructor(standings?: readonly Standing[]);
    recordWin(user: UserId): void;
    top(limit: number): readonly Standing[];
  }
---
## Intent
Who has won the most games.

## Rules
- top(limit) orders by wins (descending), then userId (ascending), and returns at most limit standings.

## Examples
- given an empty leaderboard, recordWin(u1) twice and recordWin(u2) once → top(10) is [{ userId: u1, wins: 2 }, { userId: u2, wins: 1 }]
- given u2 and u1 with 1 win each → top(10) lists u1 before u2; top(1) returns only u1
