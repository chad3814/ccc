import type { Generation, Manifest } from './manifest.js';

export interface ArtifactStats {
  generations: number;
  firstAttemptPasses: number;
  passed: number;
  meanAttempts: number;
  costUsd: number;
  unpriced: number;
}

export interface ModelStats {
  model: string;
  impl: ArtifactStats;
  tests: ArtifactStats;
}

export interface Stats {
  impl: ArtifactStats;
  tests: ArtifactStats;
  generatorErrors: number;
  pendingApprovals: number;
  perConcept: { id: string; costUsd: number; generations: number }[];
  perModel: ModelStats[];
}

// A generation that used no tokens never reached the model (rate limit,
// bad key, network): it says nothing about the model, so pass rates skip it.
function reachedModel(generation: Generation): boolean {
  return generation.inputTokens > 0 || generation.outputTokens > 0;
}

// The API reports dated snapshot ids (claude-haiku-4-5-20251001).
function baseModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
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
  const history = entries.flatMap(([, entry]) => entry.history);
  const all = history.filter(reachedModel);
  const models = [...new Set(all.map((g) => baseModel(g.model)))].sort();
  return {
    impl: summarize(all.filter((g) => g.artifact === 'impl')),
    tests: summarize(all.filter((g) => g.artifact === 'tests')),
    generatorErrors: history.length - all.length,
    perModel: models.map((model) => {
      const mine = all.filter((g) => baseModel(g.model) === model);
      return {
        model,
        impl: summarize(mine.filter((g) => g.artifact === 'impl')),
        tests: summarize(mine.filter((g) => g.artifact === 'tests')),
      };
    }),
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

function brief(label: string, stats: ArtifactStats): string {
  if (stats.generations === 0) {
    return `${label}: 0`;
  }
  const rate = Math.round((stats.firstAttemptPasses / stats.generations) * 100);
  return `${label}: ${stats.generations} (${stats.firstAttemptPasses} first-attempt, ${rate}%)`;
}

export function formatStats(stats: Stats): string {
  const lines = [line('implementations', stats.impl), line('tests', stats.tests), `pending approvals: ${stats.pendingApprovals}`];
  if (stats.generatorErrors > 0) {
    lines.push(`generator errors (no model call, left out of pass rates): ${stats.generatorErrors}`);
  }
  if (stats.perConcept.length > 0) {
    const width = Math.max(...stats.perConcept.map((row) => row.id.length));
    lines.push(
      'cost by concept:',
      ...stats.perConcept.map((row) => `  ${row.id.padEnd(width)}  $${row.costUsd.toFixed(4)} (${row.generations} generation(s))`),
    );
  }
  if (stats.perModel.length > 0) {
    const width = Math.max(...stats.perModel.map((row) => row.model.length));
    lines.push(
      'by model:',
      ...stats.perModel.map(
        (row) =>
          `  ${row.model.padEnd(width)}  ${brief('implementations', row.impl)}, ${brief('tests', row.tests)}, $${(row.impl.costUsd + row.tests.costUsd).toFixed(4)}`,
      ),
    );
  }
  return lines.join('\n');
}
