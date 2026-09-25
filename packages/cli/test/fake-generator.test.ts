import { describe, expect, it } from 'vitest';
import { FakeGenerator } from './fake-generator.js';

describe('FakeGenerator', () => {
  it('records each turn with the session history', async () => {
    const fake = new FakeGenerator((request) => (request.messages.length === 1 ? null : 'code'));
    const session = fake.start({ system: 's' });
    expect((await session.send('first', 'm')).code).toBeNull();
    expect((await session.send('second', 'm')).code).toBe('code');
    expect(fake.requests.map((r) => r.messages)).toEqual([['first'], ['first', 'second']]);
  });
});
