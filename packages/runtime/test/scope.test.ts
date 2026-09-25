import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SyncTargetMissing, afterAction, currentScope, requireScope, withScope } from '../src/scope.js';

class Game {
  dealt = 0;
}

describe('withScope', () => {
  it('binds values, merging nested scopes', async () => {
    const game = new Game();
    const store = { name: 'store' };
    await withScope({ 'game-store': store }, async () => {
      await withScope({ game }, async () => {
        expect(currentScope()?.resolve<Game>('game', 's')).toBe(game);
        expect(currentScope()?.resolve<{ name: string }>('game-store', 's')).toBe(store);
      });
    });
    expect(currentScope()).toBeUndefined();
  });

  it('names the sync and the missing binding', async () => {
    await withScope({}, async () => {
      expect(() => currentScope()?.resolve('game', 'game.deal-on-full-table')).toThrow(SyncTargetMissing);
      expect(() => currentScope()?.resolve('game', 'game.deal-on-full-table')).toThrow(
        "sync game.deal-on-full-table needs 'game' in scope; bind it with withScope({ 'game': ... }, ...)",
      );
    });
  });
});

describe('afterAction', () => {
  it('runs deferred sync work before withScope resolves, including chains', async () => {
    const order: string[] = [];
    const result = await withScope({}, async () => {
      const value = afterAction(41, 'first', async (settled, scope) => {
        order.push(`first:${settled}`);
        scope.defer(Promise.resolve().then(() => void order.push('chained')));
      });
      order.push('action returned');
      return value + 1;
    });
    expect(result).toBe(42);
    expect(order).toEqual(['action returned', 'first:41', 'chained']);
  });

  it('waits for async actions and passes their settled value', async () => {
    let seen = '';
    await withScope({}, async () => {
      await afterAction(Promise.resolve('ok'), 's', async (settled) => {
        seen = settled;
      });
    });
    expect(seen).toBe('ok');
  });

  it('fails the operation when a sync fails, without unhandled rejections', async () => {
    await expect(
      withScope({}, async () => {
        afterAction(undefined, 'a', async () => {
          throw new Error('handler failed');
        });
        afterAction(undefined, 'b', async () => {
          throw new Error('second failure');
        });
      }),
    ).rejects.toThrow('handler failed');
  });

  it('fails the operation without an unhandled rejection when the caller is still awaiting', async () => {
    const unhandled: string[] = [];
    const onUnhandled = (reason: Error): void => {
      unhandled.push(reason.message);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        withScope({}, async () => {
          afterAction(undefined, 'late', async () => {
            throw new Error('handler failed while caller awaited');
          });
          await sleep(20);
        }),
      ).rejects.toThrow('handler failed while caller awaited');
      await sleep(5);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('skips syncs when an async action rejects', async () => {
    let ran = false;
    await expect(
      withScope({}, async () => {
        await afterAction(Promise.reject(new Error('action failed')), 's', async () => {
          ran = true;
        });
      }),
    ).rejects.toThrow('action failed');
    expect(ran).toBe(false);
  });

  it('lets wiring check for a scope before the action runs', async () => {
    expect(() => requireScope('on-save')).toThrow('sync on-save fired outside withScope');
    await withScope({}, async () => {
      expect(requireScope('on-save')).toBe(currentScope());
    });
  });

  it('refuses to run outside a scope', () => {
    expect(() => afterAction(1, 'orphan', async () => undefined)).toThrow('sync orphan fired outside withScope');
  });
});
