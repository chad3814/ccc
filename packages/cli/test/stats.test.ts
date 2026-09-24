import { describe, expect, it } from 'vitest';
import { computeStats, formatStats } from '../src/stats.js';
import { emptyManifest, entryFor, type Generation } from '../src/manifest.js';

const gen = (artifact: 'tests' | 'impl', attempts: number, outcome: 'passed' | 'failed', costUsd: number | null): Generation => ({
  artifact,
  at: '2026-09-24T00:00:00.000Z',
  model: 'claude-opus-5',
  attempts,
  inputTokens: 1,
  outputTokens: 1,
  costUsd,
  durationMs: 1,
  outcome,
});

describe('stats', () => {
  it('summarizes generation history', () => {
    const manifest = emptyManifest();
    const hand = entryFor(manifest, 'hand');
    hand.history.push(gen('tests', 1, 'passed', 0.01), gen('impl', 2, 'passed', 0.03), gen('impl', 3, 'failed', 0.05));
    hand.testFileHash = 'x';
    const card = entryFor(manifest, 'card');
    card.history.push(gen('tests', 1, 'passed', null), gen('impl', 1, 'passed', 0.02));
    card.testFileHash = 'y';
    card.approvedTestHash = 'y';
    const stats = computeStats(manifest);
    expect(stats.impl).toEqual({ generations: 3, firstAttemptPasses: 1, passed: 2, meanAttempts: 2, costUsd: 0.1, unpriced: 0 });
    expect(stats.tests).toEqual({ generations: 2, firstAttemptPasses: 2, passed: 2, meanAttempts: 1, costUsd: 0.01, unpriced: 1 });
    expect(stats.pendingApprovals).toBe(1);
    expect(stats.perConcept).toEqual([
      { id: 'hand', costUsd: 0.09, generations: 3 },
      { id: 'card', costUsd: 0.02, generations: 2 },
    ]);
    expect(formatStats(stats)).toBe(
      [
        'implementations: 3 generation(s), 1 passed on the first attempt (33%), 2 passed, mean 2.00 attempts, $0.1000',
        'tests: 2 generation(s), 2 passed on the first attempt (100%), 2 passed, mean 1.00 attempts, $0.0100 (+1 unpriced)',
        'pending approvals: 1',
        'cost by concept:',
        '  hand  $0.0900 (3 generation(s))',
        '  card  $0.0200 (2 generation(s))',
      ].join('\n'),
    );
  });

  it('handles an empty manifest', () => {
    expect(formatStats(computeStats(emptyManifest()))).toBe(
      'implementations: no generations yet\ntests: no generations yet\npending approvals: 0',
    );
  });
});
