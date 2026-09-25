import { describe, expect, it } from 'vitest';
import { testCases } from '../src/testsummary.js';

const SOURCE = `import { Hand, DuplicateCard } from './hand.js';
import { card } from '../card.js';

describe('hand', () => {
  const ace = card('A', '♠');

  it('[ex 1] adds a card', () => {
    const hand = new Hand();
    hand.add(ace);
    expect(hand.size()).toBe(1);
  });

  it("[ex 2] rejects a duplicate", () => {
    const hand = new Hand([ace]);
    expect(() =>
      hand.add(ace),
    ).toThrow(
      DuplicateCard,
    );
  });

  test.concurrent(\`[ex 3] loads\`, async () => {
    for (const c of [ace]) {
      await expect(load(c)).resolves.toEqual(c);
    }
    expect.assertions(1);
  });

  it('[ex 4] checks through a helper', () => {
    const hand = new Hand();
    assertEmpty(hand);
  });

  it('not an example', () => {
    expect(1).toBe(1);
  });
});
`;

describe('testCases', () => {
  it('finds every tagged test, in order, with its example number', () => {
    expect(testCases(SOURCE).map((t) => t.example)).toEqual([1, 2, 3, 4]);
  });

  it('lists each expect statement on one line, leaving out setup', () => {
    const [one, two, three] = testCases(SOURCE);
    expect(one?.assertions).toEqual(['expect(hand.size()).toBe(1);']);
    expect(two?.assertions).toEqual(['expect(() => hand.add(ace)).toThrow(DuplicateCard);']);
    expect(three?.assertions).toEqual(['await expect(load(c)).resolves.toEqual(c);']);
  });

  it('keeps the whole body for a test with no expect statements', () => {
    const four = testCases(SOURCE)[3];
    expect(four?.assertions).toEqual([]);
    expect(four?.body).toBe('const hand = new Hand();\nassertEmpty(hand);');
  });

  it('ignores formatting, comments, and the title when comparing code', () => {
    const reformatted = SOURCE.replace("it('[ex 1] adds a card', () => {", "it('[ex 1] adds one card', () => { // setup\n")
      .replace('    hand.add(ace);\n', '    hand.add(  ace  );\n');
    expect(testCases(reformatted)[0]?.code).toBe(testCases(SOURCE)[0]?.code);
    const changed = SOURCE.replace('toBe(1);\n  });\n\n  it("', 'toBe(2);\n  });\n\n  it("');
    expect(testCases(changed)[0]?.code).not.toBe(testCases(SOURCE)[0]?.code);
  });
});
