import { handle } from './deal-on-full-table.js';
import { Game } from '../game.js';
import { userId } from '../user.js';

describe('game.deal-on-full-table', () => {
  it('[ex 1] deals once and starts the game when the last seat fills', async () => {
    const game = new Game('g1', 2, 1);
    const alice = userId('alice');
    const bob = userId('bob');

    game.players.join(alice);

    const dealSpy = vi.spyOn(game, 'deal');
    const seated = game.players.join(bob);

    await handle({ target: game.players, args: [bob], result: seated }, { game });

    expect(dealSpy).toHaveBeenCalledTimes(1);
    expect(game.status()).toBe('playing');
  });

  it('[ex 2] does not deal while a seat remains open', async () => {
    const game = new Game('g2', 3, 1);
    const alice = userId('alice');
    const bob = userId('bob');

    game.players.join(alice);

    const dealSpy = vi.spyOn(game, 'deal');
    const seated = game.players.join(bob);

    await handle({ target: game.players, args: [bob], result: seated }, { game });

    expect(dealSpy).not.toHaveBeenCalled();
    expect(game.status()).toBe('waiting');
  });
});
