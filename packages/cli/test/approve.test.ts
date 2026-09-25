import { describe, expect, it } from 'vitest';
import { approvedTestsOf, keptTests, reviewTests } from '../src/approve.js';

const EXAMPLES = ['an empty hand, add(A♠) → size is 1', 'hand [A♠], add(A♠) → throws DuplicateCard', 'hand [A♠], remove(K♥) → throws CardNotInHand'];

const test = (n: number, body: string) => `  it('[ex ${n}] test', () => {\n    ${body}\n  });\n`;
const file = (...bodies: string[]) => `describe('hand', () => {\n${bodies.map((body, i) => test(i + 1, body)).join('\n')}});\n`;

const A = 'expect(new Hand().size()).toBe(0);';
const B = 'expect(() => twice()).toThrow(DuplicateCard);';
const C = 'expect(() => missing()).toThrow(CardNotInHand);';

describe('reviewTests', () => {
  it('marks every test new before anything was approved', async () => {
    const reviewed = await reviewTests(EXAMPLES, file(A, B, C), {});
    expect(reviewed.map((r) => [r.example, r.status])).toEqual([
      [1, 'new'],
      [2, 'new'],
      [3, 'new'],
    ]);
    expect(reviewed[1]?.text).toBe(EXAMPLES[1]);
    expect(reviewed[1]?.test?.assertions).toEqual([B]);
  });

  it('marks tests unchanged when their example and code match the approval', async () => {
    const approved = await approvedTestsOf(EXAMPLES, file(A, B, C));
    const reviewed = await reviewTests(EXAMPLES, file(A, B, C), approved);
    expect(reviewed.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('marks a test changed when its code differs, and new when its example was edited', async () => {
    const approved = await approvedTestsOf(EXAMPLES, file(A, B, C));
    const edited = [EXAMPLES[0] ?? '', 'hand [A♠], add(A♠) → throws DuplicateCard and size stays 1', EXAMPLES[2] ?? ''];
    const reviewed = await reviewTests(edited, file(A, B, C.replace('missing', 'absent')), approved);
    expect(reviewed.map((r) => r.status)).toEqual(['unchanged', 'new', 'changed']);
  });

  it('matches by example text, so inserting a bullet renumbers without changing the rest', async () => {
    const approved = await approvedTestsOf(EXAMPLES, file(A, B, C));
    const inserted = ['a new first example', ...EXAMPLES];
    const reviewed = await reviewTests(inserted, file('expect(first()).toBe(true);', A, B, C), approved);
    expect(reviewed.map((r) => r.status)).toEqual(['new', 'unchanged', 'unchanged', 'unchanged']);
  });

  it('ignores whitespace-only edits to an example', async () => {
    const approved = await approvedTestsOf(EXAMPLES, file(A, B, C));
    const spaced = EXAMPLES.map((example) => example.replace(' → ', '   →\n  '));
    expect((await reviewTests(spaced, file(A, B, C), approved)).map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('reports an example with no test', async () => {
    const reviewed = await reviewTests(EXAMPLES, file(A, B), {});
    expect(reviewed[2]).toMatchObject({ example: 3, status: 'new', test: null });
  });
});

describe('keptTests', () => {
  it('maps each unchanged example to its test in the approved file', async () => {
    const approved = await approvedTestsOf(EXAMPLES, file(A, B, C));
    const examples = ['a new first example', EXAMPLES[0] ?? '', 'an edited second example', EXAMPLES[2] ?? ''];
    expect(await keptTests(examples, file(A, B, C), approved)).toEqual([
      { example: 2, was: 1 },
      { example: 4, was: 3 },
    ]);
  });
});
