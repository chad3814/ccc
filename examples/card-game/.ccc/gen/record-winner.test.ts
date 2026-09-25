import { pgliteDatabase } from '@ccc/runtime/pglite';
import { schemaSql } from './schema.js';
import { card } from './card.js';
import { Game, type PlayResult } from './game.js';
import { LeaderboardStore } from './leaderboard-store.js';
import { userId } from './user.js';
import { handle, type SyncEvent } from './record-winner.js';

describe('sync record-winner', () => {
  const makeStore = async (): Promise<LeaderboardStore> => {
    const db = pgliteDatabase();
    await db.exec(schemaSql);
    return new LeaderboardStore(db);
  };

  const makeEvent = (user: ReturnType<typeof userId>, result: PlayResult): SyncEvent => ({
    target: new Game('g1', 2, 1),
    args: [user, card('A', '♠')],
    result,
  });

  it('[ex 1] records a win for the winner when the play finished the game', async () => {
    const store = await makeStore();
    const spy = vi.spyOn(store, 'recordWin');
    const u1 = userId('u1');

    await handle(
      makeEvent(u1, { trickComplete: true, trickWinner: u1, finished: true, winner: u1 }),
      { leaderboardStore: store },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(u1);
  });

  it('[ex 2] records nothing when the play did not finish the game', async () => {
    const store = await makeStore();
    const spy = vi.spyOn(store, 'recordWin');
    const u1 = userId('u1');

    await handle(
      makeEvent(u1, { trickComplete: true, trickWinner: u1, finished: false, winner: null }),
      { leaderboardStore: store },
    );

    expect(spy).not.toHaveBeenCalled();
    expect(await store.top(10)).toEqual([]);
  });
});
