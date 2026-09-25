import { feedbackMessage } from './context.js';
import { GeneratorUnavailable, type Generator, type Usage } from './llm.js';
import type { Generation } from './manifest.js';
import { costUsd } from './pricing.js';

export interface GenerationOutcome {
  source: string | null;
  record: Generation;
  problems: string[];
  // Problems found at each attempt, in order ([] for a passing attempt).
  attemptProblems: string[][];
}

export interface LoopOptions {
  generator: Generator;
  // The models to try, weakest first; a single entry never escalates.
  models: readonly string[];
  escalateAfter: number;
  system: string;
  firstMessage: string;
  maxAttempts: number;
  artifact: 'tests' | 'impl';
  now: () => number;
  check: (code: string) => Promise<string[]>;
}

export interface Spend {
  usage: Usage;
  // Null once any turn ran on a model without a known price.
  costUsd: number | null;
}

export function generationRecord(
  artifact: 'tests' | 'impl',
  started: number,
  finished: number,
  model: string,
  attempts: number,
  spend: Spend,
  outcome: 'passed' | 'failed',
  escalations: number,
): Generation {
  return {
    artifact,
    at: new Date(started).toISOString(),
    model,
    attempts,
    inputTokens: spend.usage.inputTokens,
    outputTokens: spend.usage.outputTokens,
    costUsd: spend.costUsd === null ? null : Math.round(spend.costUsd * 1_000_000) / 1_000_000,
    durationMs: finished - started,
    outcome,
    escalations,
  };
}

// Attempt n (1-based) runs on the tier reached after every escalateAfter
// failed attempts, never past the last (the cap).
export function tierFor(attempt: number, tiers: number, escalateAfter: number): number {
  return Math.min(Math.floor((attempt - 1) / escalateAfter), tiers - 1);
}

// One session per artifact: send the request, check the code, feed problems
// back, and stop at the first passing attempt or after maxAttempts. Repeated
// failures move the conversation to a stronger model.
export async function generationLoop(options: LoopOptions): Promise<GenerationOutcome> {
  const started = options.now();
  const session = options.generator.start({ system: options.system });
  const spend: Spend = { usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
  let tier = 0;
  let model = options.models[0] ?? '';
  let message = options.firstMessage;
  let problems: string[] = [];
  const attemptProblems: string[][] = [];
  const record = (attempts: number, outcome: 'passed' | 'failed'): Generation =>
    generationRecord(options.artifact, started, options.now(), model, attempts, spend, outcome, tier);
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    tier = tierFor(attempt, options.models.length, options.escalateAfter);
    model = options.models[tier] ?? model;
    let turn;
    try {
      turn = await session.send(message, model);
    } catch (err) {
      if (err instanceof GeneratorUnavailable) {
        throw err;
      }
      // The SDK already retried transient failures; stop this artifact and
      // let the build carry on with the rest.
      const reason = err instanceof Error ? err.message : String(err);
      attemptProblems.push([`generator error: ${reason}`]);
      return { source: null, attemptProblems, problems: [`generator error: ${reason}`], record: record(attempt, 'failed') };
    }
    spend.usage.inputTokens += turn.usage.inputTokens;
    spend.usage.outputTokens += turn.usage.outputTokens;
    const cost = costUsd(turn.model, turn.usage.inputTokens, turn.usage.outputTokens);
    spend.costUsd = spend.costUsd === null || cost === null ? null : spend.costUsd + cost;
    model = turn.model;
    problems = turn.code === null ? [`${turn.note}; call write_module with the complete file`] : await options.check(turn.code);
    attemptProblems.push(problems);
    if (turn.code !== null && problems.length === 0) {
      return { source: turn.code, attemptProblems, problems: [], record: record(attempt, 'passed') };
    }
    message = feedbackMessage(problems);
  }
  return { source: null, attemptProblems, problems, record: record(options.maxAttempts, 'failed') };
}
