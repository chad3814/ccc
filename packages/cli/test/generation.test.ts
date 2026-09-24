import { describe, expect, it } from 'vitest';
import { generationLoop } from '../src/generation.js';
import { FakeGenerator } from './fake-generator.js';

function options(fake: FakeGenerator, check: (code: string) => Promise<string[]>) {
  let clock = 1000;
  return {
    generator: fake,
    model: 'claude-opus-5',
    system: 'sys',
    firstMessage: 'first',
    maxAttempts: 3,
    artifact: 'impl' as const,
    now: () => (clock += 10),
    check,
  };
}

describe('generationLoop', () => {
  it('returns the first code that passes its checks, with a record', async () => {
    const fake = new FakeGenerator((request) => (request.messages.length === 1 ? 'bad' : 'good'));
    const outcome = await generationLoop(options(fake, async (code) => (code === 'good' ? [] : ['it is bad'])));
    expect(outcome.source).toBe('good');
    expect(outcome.problems).toEqual([]);
    expect(outcome.record).toEqual({
      artifact: 'impl',
      at: new Date(1010).toISOString(),
      model: 'claude-opus-5',
      attempts: 2,
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.0035,
      durationMs: 10,
      outcome: 'passed',
    });
    expect(fake.requests[1]?.messages[1]).toContain('- it is bad');
  });

  it('gives up after maxAttempts and keeps the last problems', async () => {
    const fake = new FakeGenerator(() => null);
    const outcome = await generationLoop(options(fake, async () => []));
    expect(outcome.source).toBeNull();
    expect(outcome.record.outcome).toBe('failed');
    expect(outcome.record.attempts).toBe(3);
    expect(outcome.problems).toEqual(['you did not call write_module; call write_module with the complete file']);
  });

  it('stops at a generator error and reports it as the problem', async () => {
    const fake = new FakeGenerator(() => {
      throw new Error('socket hang up');
    });
    const outcome = await generationLoop(options(fake, async () => []));
    expect(outcome.source).toBeNull();
    expect(outcome.record).toMatchObject({ attempts: 1, outcome: 'failed' });
    expect(outcome.problems).toEqual(['generator error: socket hang up']);
  });
});
