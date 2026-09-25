import { describe, expect, it } from 'vitest';
import { exampleTags, generateTests, modifierProblems, tagProblems } from '../src/testgen.js';
import { FakeGenerator } from './fake-generator.js';
import { CANNED_TESTS, createPipelineProject, pipelineContext, pipelineResponder } from './pipeline-fixture.js';

describe('exampleTags / tagProblems', () => {
  it('reads tags from it() and test() calls', () => {
    expect(exampleTags("it('[ex 2] b', f);\ntest(\"[ex 1] a\", f);\nit.skip(`[ex 3] c`, f);")).toEqual([1, 2, 3]);
  });
  it('requires exactly one test per example', () => {
    expect(tagProblems([1, 2], 2)).toEqual([]);
    expect(tagProblems([1, 3], 2)).toEqual([
      'write exactly one test per example, tagged [ex 1] through [ex 2]; found [ex 1], [ex 3]',
    ]);
    expect(tagProblems([], 1)).toEqual(['write exactly one test per example, tagged [ex 1] through [ex 1]; found no tags']);
  });
});

describe('modifierProblems', () => {
  it('rejects skipped, todo, focused, and expected-failure tests', () => {
    expect(modifierProblems("it('[ex 1] a', f);")).toEqual([]);
    expect(modifierProblems("it.skip('[ex 1] a', f);\ntest.only('[ex 2] b', f);\ndescribe.skip('x', f);")).toEqual([
      'tests must not use .skip, .only (every example must run)',
    ]);
  });
});

async function handTests(overrides: Parameters<typeof pipelineResponder>[0]) {
  const root = await createPipelineProject();
  const fake = new FakeGenerator(pipelineResponder(overrides));
  const ctx = await pipelineContext(root, fake);
  const hand = ctx.project.concepts.get('hand');
  if (hand === undefined) throw new Error('fixture');
  return { fake, outcome: await generateTests(ctx, hand) };
}

describe('generateTests', () => {
  it('accepts tests that match the examples and type-check against interfaces', async () => {
    const { fake, outcome } = await handTests({});
    expect(outcome.source).toBe(CANNED_TESTS.hand);
    expect(outcome.record).toMatchObject({ artifact: 'tests', attempts: 1, outcome: 'passed', model: 'claude-sonnet-5' });
    expect(fake.requests[0]?.system).toMatch(/^You are the test writer/);
  });

  it('asks again when tags are wrong', async () => {
    const good = CANNED_TESTS.hand ?? '';
    const { fake, outcome } = await handTests({
      'tests:hand': (attempt) => (attempt === 1 ? good.replace('[ex 2]', '[ex 3]') : good),
    });
    expect(outcome.record.attempts).toBe(2);
    expect(fake.requests[1]?.messages[1]).toContain('tagged [ex 1] through [ex 2]; found [ex 1], [ex 3]');
  });

  it('reports type errors and disallowed imports as problems', async () => {
    const good = CANNED_TESTS.hand ?? '';
    const typeError = await handTests({ 'tests:hand': () => good.replace('hand.size()', 'hand.nope()') });
    expect(typeError.outcome.source).toBeNull();
    expect(typeError.outcome.problems.join('\n')).toMatch(/line \d+: Property 'nope' does not exist/);
    const badImport = await handTests({ 'tests:hand': () => `import { x } from './secret.js';\n${good}` });
    expect(badImport.outcome.problems[0]).toMatch(/^line 1: '.\/secret.js' is not a dependency/);
  });

  it('rejects tests whose options disable them', async () => {
    const good = CANNED_TESTS.hand ?? '';
    const { outcome } = await handTests({ 'tests:hand': () => good.replace(/it\('(\[ex 1\][^']*)', /, "it('$1', { fails: true }, ") });
    expect(outcome.problems).toContain('tests must not set fails in their options (every example must run)');
  });

  it('fails after the configured attempts', async () => {
    const { outcome } = await handTests({ 'tests:hand': () => null });
    expect(outcome.source).toBeNull();
    expect(outcome.record).toMatchObject({ attempts: 3, outcome: 'failed' });
  });
});
