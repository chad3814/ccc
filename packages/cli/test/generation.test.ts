import { describe, expect, it } from 'vitest';
import { generationLoop } from '../src/generation.js';
import { GeneratorUnavailable } from '../src/llm.js';
import { FakeGenerator } from './fake-generator.js';

function options(fake: FakeGenerator, check: (code: string) => Promise<string[]>) {
  let clock = 1000;
  return {
    generator: fake,
    models: ['claude-opus-5'],
    escalateAfter: 2,
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
      escalations: 0,
    });
    expect(fake.requests[1]?.messages[1]).toContain('- it is bad');
    expect(outcome.attemptProblems).toEqual([['it is bad'], []]);
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

  it('lets GeneratorUnavailable escape so the build can stop', async () => {
    const fake = new FakeGenerator(() => {
      throw new GeneratorUnavailable('claude-opus-5 is rate-limited');
    });
    await expect(generationLoop(options(fake, async () => []))).rejects.toBeInstanceOf(GeneratorUnavailable);
  });

  describe('escalation', () => {
    const tiers = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];

    it('moves up one tier after every escalateAfter failed attempts, then stays at the cap', async () => {
      const fake = new FakeGenerator(() => 'bad');
      const outcome = await generationLoop({ ...options(fake, async () => ['still bad']), models: tiers, maxAttempts: 8 });
      expect(fake.requests.map((request) => request.model)).toEqual([
        'claude-haiku-4-5',
        'claude-haiku-4-5',
        'claude-sonnet-5',
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-opus-5',
        'claude-opus-5',
        'claude-opus-5',
      ]);
      expect(outcome.record).toMatchObject({ model: 'claude-opus-5', attempts: 8, escalations: 2, outcome: 'failed' });
    });

    it('continues the same conversation on the stronger model', async () => {
      const escalated = new FakeGenerator((request) => (request.messages.length === 3 ? 'good' : 'bad'));
      const result = await generationLoop({
        ...options(escalated, async (code) => (code === 'good' ? [] : ['it is bad'])),
        models: tiers,
      });
      expect(result.source).toBe('good');
      expect(escalated.requests[2]).toMatchObject({ model: 'claude-sonnet-5' });
      expect(escalated.requests[2]?.messages).toHaveLength(3);
      expect(result.record).toMatchObject({ model: 'claude-sonnet-5', attempts: 3, escalations: 1, outcome: 'passed' });
    });

    it('prices each attempt at the model that ran it', async () => {
      const fake = new FakeGenerator((request) => (request.messages.length === 3 ? 'good' : 'bad'));
      const outcome = await generationLoop({
        ...options(fake, async (code) => (code === 'good' ? [] : ['bad'])),
        models: ['claude-haiku-4-5', 'claude-opus-5'],
      });
      // Two haiku turns ($1/$5) and one opus turn ($5/$25), 100 in / 50 out each.
      expect(outcome.record.costUsd).toBeCloseTo(2 * (100 * 1 + 50 * 5) / 1e6 + (100 * 5 + 50 * 25) / 1e6, 10);
    });
  });
});
