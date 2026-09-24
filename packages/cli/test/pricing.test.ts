import { describe, expect, it } from 'vitest';
import { costUsd } from '../src/pricing.js';

describe('costUsd', () => {
  it('prices known models per million tokens', () => {
    expect(costUsd('claude-opus-5', 1_000_000, 1_000_000)).toBe(30);
    expect(costUsd('claude-opus-5', 1000, 500)).toBe(0.0175);
    expect(costUsd('claude-sonnet-5', 2_000_000, 0)).toBe(4);
  });
  it('returns null for an unknown model', () => {
    expect(costUsd('some-future-model', 10, 10)).toBeNull();
  });
});
