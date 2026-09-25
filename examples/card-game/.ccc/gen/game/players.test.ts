import { Players, TableFull, AlreadySeated } from './players.js';
import { userId } from '../user.js';

describe('game.players', () => {
  it('[ex 1] seats the joining user and reports the remaining seat', () => {
    const players = new Players(2);

    const joined = players.join(userId('u1'));

    expect(players.seatsLeft()).toBe(1);
    expect(players.all()).toEqual([joined]);
  });

  it('[ex 2] rejects a join when every seat is taken', () => {
    const players = new Players(2);
    players.join(userId('u1'));
    players.join(userId('u2'));

    expect(() => players.join(userId('u3'))).toThrow(TableFull);
  });

  it('[ex 3] rejects a user who is already seated', () => {
    const players = new Players(2);
    players.join(userId('u1'));

    expect(() => players.join(userId('u1'))).toThrow(AlreadySeated);
  });

  it('[ex 4] looks up a seated user and returns undefined for a stranger', () => {
    const players = new Players(2);
    const u1 = players.join(userId('u1'));

    expect(players.byUser(userId('u1'))).toBe(u1);
    expect(players.byUser(userId('u9'))).toBeUndefined();
  });
});
