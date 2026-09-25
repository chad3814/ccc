import { Leaderboard, type Standing } from './leaderboard.js';
import { userId } from './user.js';

describe('leaderboard', () => {
  it('[ex 1] ranks users by number of recorded wins', () => {
    const u1 = userId('u1');
    const u2 = userId('u2');
    const board = new Leaderboard();

    board.recordWin(u1);
    board.recordWin(u1);
    board.recordWin(u2);

    expect(board.top(10)).toEqual([
      { userId: u1, wins: 2 },
      { userId: u2, wins: 1 },
    ]);
  });

  it('[ex 2] breaks ties by userId ascending and honours the limit', () => {
    const u1 = userId('u1');
    const u2 = userId('u2');
    const seeded: readonly Standing[] = [
      { userId: u2, wins: 1 },
      { userId: u1, wins: 1 },
    ];
    const board = new Leaderboard(seeded);

    expect(board.top(10)).toEqual([
      { userId: u1, wins: 1 },
      { userId: u2, wins: 1 },
    ]);
    expect(board.top(1)).toEqual([{ userId: u1, wins: 1 }]);
  });
});
