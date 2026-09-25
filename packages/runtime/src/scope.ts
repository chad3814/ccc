import { AsyncLocalStorage } from 'node:async_hooks';

export class SyncTargetMissing extends Error {}

// One unit of work: named bindings that syncs resolve their targets from,
// and sync work deferred until the unit finishes.
export class Scope {
  readonly #bindings: Map<string, object>;
  readonly #pending: Promise<void>[] = [];

  constructor(bindings: ReadonlyMap<string, object>) {
    this.#bindings = new Map(bindings);
  }

  resolve<T extends object>(id: string, sync: string): T {
    const value = this.#bindings.get(id);
    if (value === undefined) {
      throw new SyncTargetMissing(`sync ${sync} needs '${id}' in scope; bind it with withScope({ '${id}': ... }, ...)`);
    }
    return value as T;
  }

  defer(work: Promise<void>): void {
    // Mark the rejection handled now; drain() still sees and rethrows it.
    work.catch(() => undefined);
    this.#pending.push(work);
  }

  // Deferred work may defer more; settle everything, then rethrow the first
  // failure so none become unhandled rejections.
  async drain(): Promise<void> {
    let failure: PromiseRejectedResult | undefined;
    while (this.#pending.length > 0) {
      const results = await Promise.allSettled(this.#pending.splice(0));
      failure ??= results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    }
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  bindings(): ReadonlyMap<string, object> {
    return this.#bindings;
  }
}

const storage = new AsyncLocalStorage<Scope>();

export async function withScope<T>(bindings: Readonly<Record<string, object>>, fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  const scope = new Scope(new Map([...(parent?.bindings() ?? []), ...Object.entries(bindings)]));
  return storage.run(scope, async () => {
    try {
      const value = await fn();
      await scope.drain();
      return value;
    } catch (err) {
      await scope.drain().catch(() => undefined);
      throw err;
    }
  });
}

export function currentScope(): Scope | undefined {
  return storage.getStore();
}

// Called by generated wiring before a trigger action runs, so an action
// outside any scope fails before its side effects rather than after.
export function requireScope(sync: string): Scope {
  const scope = storage.getStore();
  if (scope === undefined) {
    throw new Error(`sync ${sync} fired outside withScope`);
  }
  return scope;
}

// Called by generated wiring after a trigger action returns: sync work runs
// once the action settles (and only if it succeeded), inside the scope.
export function afterAction<R>(result: R, sync: string, run: (settled: Awaited<R>, scope: Scope) => Promise<void>): R {
  const scope = requireScope(sync);
  scope.defer(
    Promise.resolve(result).then(
      (settled) => run(settled, scope),
      () => undefined,
    ),
  );
  return result;
}
