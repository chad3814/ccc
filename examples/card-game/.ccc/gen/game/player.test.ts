import { Player } from './player.js';
import { Hand } from './player/hand.js';
import { card } from '../card.js';
import { userId } from '../user.js';

describe('game.player', () => {
  it('[ex 1] starts with an empty hand and no points', () => {
    const player = new Player(userId('u1'));

    expect(player.hand.size()).toBe(0);
    expect(player.points()).toBe(0);
  });

  it('[ex 2] accumulates points when scorePoint is called twice', () => {
    const player = new Player(userId('u1'));

    player.scorePoint();
    player.scorePoint();

    expect(player.points()).toBe(2);
  });

  it('[ex 3] accepts an initial hand and point total', () => {
    const player = new Player(userId('u1'), new Hand([card('A', '♠')]), 3);

    expect(player.hand.size()).toBe(1);
    expect(player.points()).toBe(3);
  });
});
