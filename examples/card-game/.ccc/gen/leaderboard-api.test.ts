import { pgliteDatabase } from '@ccc/runtime/pglite';
import { withScope } from '@ccc/runtime';
import { schemaSql } from './schema.js';
import { createApp } from './server.js';
import { LeaderboardStore } from './leaderboard-store.js';
import { userId } from './user.js';

interface StandingJson {
  readonly userId: string;
  readonly wins: number;
}

async function setup(): Promise<{
  db: Awaited<ReturnType<typeof pgliteDatabase>>;
  app: (request: Request) => Promise<Response>;
}> {
  const db = await pgliteDatabase();
  await db.exec(schemaSql);
  const app = await createApp(db, { endpoints: ['leaderboard-api'] });
  return { db, app };
}

describe('leaderboard-api', () => {
  it('[ex 1] GET /leaderboard with nothing recorded returns 200 and an empty list', async () => {
    const { app } = await setup();

    const response = await app(
      new Request('http://test/leaderboard', { method: 'GET' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as StandingJson[];
    expect(body).toEqual([]);
  });

  it('[ex 2] GET /leaderboard returns recorded wins, most wins first', async () => {
    const { db, app } = await setup();

    const u1 = userId('u1');
    const u2 = userId('u2');
    const store = new LeaderboardStore(db);

    await withScope({ 'leaderboard-store': store }, async () => {
      await store.recordWin(u1);
      await store.recordWin(u1);
      await store.recordWin(u2);
    });

    const response = await app(
      new Request('http://test/leaderboard', { method: 'GET' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as StandingJson[];
    expect(body).toEqual([
      { userId: 'u1', wins: 2 },
      { userId: 'u2', wins: 1 },
    ]);
  });
});
