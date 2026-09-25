import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { runCheck } from '../src/check.js';
import { FakeGenerator } from './fake-generator.js';
import { linkPackages } from './helpers.js';

// A copy of the model without generated output, so a local `pnpm generate`
// in the example doesn't change what a fresh build would plan.
async function freshCopy(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ccc-example-'));
  await cp(EXAMPLE, root, {
    recursive: true,
    filter: (source) => !/[\\/](\.ccc|node_modules)([\\/]|$)/.test(path.relative(EXAMPLE, source) === '' ? '' : `/${path.relative(EXAMPLE, source)}`),
  });
  await linkPackages(root, ['@ccc/runtime']);
  return root;
}

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/card-game');

describe('examples/card-game', () => {
  it('checks clean with the full model', async () => {
    const { project, diagnostics } = await runCheck(EXAMPLE);
    expect(diagnostics).toEqual([]);
    expect([...project.concepts.keys()]).toEqual([
      'auth-api',
      'auth',
      'card',
      'game-api',
      'game-store',
      'game',
      'game.deal-on-full-table',
      'game.deck',
      'game.player',
      'game.player.hand',
      'game.players',
      'leaderboard-api',
      'leaderboard-store',
      'leaderboard',
      'record-winner',
      'user',
    ]);
  });

  it('plans a complete build without calling the model', async () => {
    const fake = new FakeGenerator(() => null);
    const result = await runBuild({ root: await freshCopy(), generator: fake, dryRun: true });
    expect(result.ok).toBe(true);
    expect(fake.requests).toEqual([]);
    expect(result.plan.filter((item) => item.tests)).toHaveLength(16);
    expect(result.plan.filter((item) => item.impl)).toHaveLength(15);
    expect(result.plan.find((item) => item.id === 'user')).toEqual({ id: 'user', tests: true, impl: false });
  });
});
