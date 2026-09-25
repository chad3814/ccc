import { pgliteDatabase } from '@ccc/runtime/pglite';
import { schemaSql } from './schema.js';
import { GameStore } from './game-store.js';
import { Game } from './game.js';
import { userId } from './user.js';

async function freshStore(): Promise<GameStore> {
  const db = await pgliteDatabase();
  await db.exec(schemaSql);
  return new GameStore(db);
}

describe('game-store', () => {
  it('[ex 1] saves a new 2-seat game and loads it back with the same state', async () => {
    const store = await freshStore();
    const game = new Game('game-1', 2, 7);

    await store.save(game);
    const loaded = await store.load('game-1');

    expect(loaded).not.toBeNull();
    if (loaded === null) throw new Error('expected a loaded game');
    expect(loaded.toState()).toEqual(game.toState());
  });

  it('[ex 2] loads the player added by a later save', async () => {
    const store = await freshStore();
    const game = new Game('game-2', 2, 11);
    await store.save(game);

    const alice = userId('alice');
    game.players.join(alice);
    await store.save(game);

    const loaded = await store.load('game-2');

    expect(loaded).not.toBeNull();
    if (loaded === null) throw new Error('expected a loaded game');
    const seated = loaded.players.byUser(alice);
    expect(seated).toBeDefined();
    expect(seated?.user).toBe(alice);
  });

  it('[ex 3] returns null for an unknown game id', async () => {
    const store = await freshStore();

    await expect(store.load('missing')).resolves.toBeNull();
  });
});
