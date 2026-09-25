import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { runCheck } from '../src/check.js';
import { FakeGenerator } from './fake-generator.js';

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
    const result = await runBuild({ root: EXAMPLE, generator: fake, dryRun: true });
    expect(result.ok).toBe(true);
    expect(fake.requests).toEqual([]);
    expect(result.plan.filter((item) => item.tests)).toHaveLength(16);
    expect(result.plan.filter((item) => item.impl)).toHaveLength(15);
    expect(result.plan.find((item) => item.id === 'user')).toEqual({ id: 'user', tests: true, impl: false });
  });
});
