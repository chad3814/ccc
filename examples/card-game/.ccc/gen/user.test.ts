import { userId, type UserId } from './user.js';

describe('user', () => {
  it('[ex 1] wraps a raw string as a UserId', () => {
    const id: UserId = userId('u1');
    expect(id).toBe('u1');
  });

  it('[ex 2] rejects a blank user id', () => {
    expect(() => userId('  ')).toThrowError(new Error('empty user id'));
  });
});
