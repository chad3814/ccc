import type { Generation, Manifest } from './manifest.js';

export interface ArtifactStats {
  generations: number;
  firstAttemptPasses: number;
  passed: number;
  meanAttempts: number;
  costUsd: number;
  unpriced: number;
}

export interface Stats {
  impl: ArtifactStats;
  tests: ArtifactStats;
  pendingApprovals: number;
  perConcept: { id: string; costUsd: number; generations: number }[];
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function summarize(generations: readonly Generation[]): ArtifactStats {
  const priced = generations.filter((g) => g.costUsd !== null);
  const attempts = generations.reduce((sum, g) => sum + g.attempts, 0);
  return {
    generations: generations.length,
    firstAttemptPasses: generations.filter((g) => g.outcome === 'passed' && g.attempts === 1).length,
    passed: generations.filter((g) => g.outcome === 'passed').length,
    meanAttempts: generations.length === 0 ? 0 : round(attempts / generations.length, 2),
    costUsd: round(
      priced.reduce((sum, g) => sum + (g.costUsd ?? 0), 0),
      6,
    ),
    unpriced: generations.length - priced.length,
  };
}

export function computeStats(manifest: Manifest): Stats {
  const entries = Object.entries(manifest.concepts);
  const all = entries.flatMap(([, entry]) => entry.history);
  return {
    impl: summarize(all.filter((g) => g.artifact === 'impl')),
    tests: summarize(all.filter((g) => g.artifact === 'tests')),
    pendingApprovals: entries.filter(([, e]) => e.testFileHash !== null && e.approvedTestHash !== e.testFileHash).length,
    perConcept: entries
      .map(([id, entry]) => ({
        id,
        costUsd: round(
          entry.history.reduce((sum, g) => sum + (g.costUsd ?? 0), 0),
          6,
        ),
        generations: entry.history.length,
      }))
      .filter((row) => row.generations > 0)
      .sort((a, b) => b.costUsd - a.costUsd || (a.id < b.id ? -1 : 1)),
  };
}

function line(label: string, stats: ArtifactStats): string {
  if (stats.generations === 0) {
    return `${label}: no generations yet`;
  }
  const rate = Math.round((stats.firstAttemptPasses / stats.generations) * 100);
  const unpriced = stats.unpriced > 0 ? ` (+${stats.unpriced} unpriced)` : '';
  return `${label}: ${stats.generations} generation(s), ${stats.firstAttemptPasses} passed on the first attempt (${rate}%), ${stats.passed} passed, mean ${stats.meanAttempts.toFixed(2)} attempts, $${stats.costUsd.toFixed(4)}${unpriced}`;
}

export function formatStats(stats: Stats): string {
  const lines = [line('implementations', stats.impl), line('tests', stats.tests), `pending approvals: ${stats.pendingApprovals}`];
  if (stats.perConcept.length > 0) {
    const width = Math.max(...stats.perConcept.map((row) => row.id.length));
    lines.push(
      'cost by concept:',
      ...stats.perConcept.map((row) => `  ${row.id.padEnd(width)}  $${row.costUsd.toFixed(4)} (${row.generations} generation(s))`),
    );
  }
  return lines.join('\n');
}
