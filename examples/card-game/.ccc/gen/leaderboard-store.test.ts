import { pgliteDatabase } from '@ccc/runtime/pglite';
import { schemaSql } from './schema.js';
import { LeaderboardStore } from './leaderboard-store.js';
import { userId } from './user.js';

async function createStore(): Promise<LeaderboardStore> {
  const db = pgliteDatabase();
  await db.exec(schemaSql);
  return new LeaderboardStore(db);
}

describe('leaderboard-store', () => {
  it('[ex 1] records wins per user and returns them ordered by wins', async () => {
    const store = await createStore();
    const u1 = userId('u1');
    const u2 = userId('u2');

    await store.recordWin(u1);
    await store.recordWin(u1);
    await store.recordWin(u2);

    const standings = await store.top(10);

    expect(standings).toEqual([
      { userId: u1, wins: 2 },
      { userId: u2, wins: 1 },
    ]);
  });

  it('[ex 2] returns an empty list for an empty leaderboard', async () => {
    const store = await createStore();

    const standings = await store.top(10);

    expect(standings).toEqual([]);
  });
});
