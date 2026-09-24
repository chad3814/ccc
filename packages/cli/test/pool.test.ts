import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/pool.js';

describe('mapPool', () => {
  it('processes every item with at most `limit` in flight', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await mapPool([1, 2, 3, 4, 5], 2, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push(item);
      running -= 1;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    await mapPool([], 3, async () => {
      throw new Error('never');
    });
  });
});
