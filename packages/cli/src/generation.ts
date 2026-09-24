import { feedbackMessage } from './context.js';
import type { Generator, Usage } from './llm.js';
import type { Generation } from './manifest.js';
import { costUsd } from './pricing.js';

export interface GenerationOutcome {
  source: string | null;
  record: Generation;
  problems: string[];
}

export interface LoopOptions {
  generator: Generator;
  model: string;
  system: string;
  firstMessage: string;
  maxAttempts: number;
  artifact: 'tests' | 'impl';
  now: () => number;
  check: (code: string) => Promise<string[]>;
}

export function generationRecord(
  artifact: 'tests' | 'impl',
  started: number,
  finished: number,
  model: string,
  attempts: number,
  usage: Usage,
  outcome: 'passed' | 'failed',
): Generation {
  return {
    artifact,
    at: new Date(started).toISOString(),
    model,
    attempts,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: costUsd(model, usage.inputTokens, usage.outputTokens),
    durationMs: finished - started,
    outcome,
  };
}

// One session per artifact: send the request, check the code, feed problems
// back, and stop at the first passing attempt or after maxAttempts.
export async function generationLoop(options: LoopOptions): Promise<GenerationOutcome> {
  const started = options.now();
  const session = options.generator.start({ model: options.model, system: options.system });
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let model = options.model;
  let message = options.firstMessage;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const turn = await session.send(message);
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    model = turn.model;
    problems = turn.code === null ? [`${turn.note}; call write_module with the complete file`] : await options.check(turn.code);
    if (turn.code !== null && problems.length === 0) {
      return {
        source: turn.code,
        problems: [],
        record: generationRecord(options.artifact, started, options.now(), model, attempt, usage, 'passed'),
      };
    }
    message = feedbackMessage(problems);
  }
  return {
    source: null,
    problems,
    record: generationRecord(options.artifact, started, options.now(), model, options.maxAttempts, usage, 'failed'),
  };
}
