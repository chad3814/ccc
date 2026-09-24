import { describe, expect, it } from 'vitest';
import { feedbackMessage, implRequest, testRequest } from '../src/context.js';
import { collectExports } from '../src/interfaces.js';
import { concept, projectFrom } from './helpers.js';

const project = projectFrom({
  'card.md': concept('kind: value\ninterface: |\n  export interface Card { readonly rank: string }'),
  'hand.md': concept(
    'kind: collection\nof: card\ninterface: |\n  export class Hand {\n    add(card: Card): void;\n  }',
    '## Intent\nCards held.\n\n## Rules\n- no duplicates\n\n## Examples\n- add a card\n- reject a duplicate\n',
  ),
});
const exportsByConcept = collectExports(project);
const hand = project.concepts.get('hand');
if (hand === undefined) throw new Error('fixture');

describe('testRequest', () => {
  it('asks for one tagged test per example against the interface only', () => {
    const request = testRequest(hand, project, exportsByConcept, ['card']);
    expect(request.split('\n')[0]).toBe('Write the Vitest test file for concept `hand` (collection).');
    expect(request).toContain('Test file: .ccc/gen/hand.test.ts');
    expect(request).toContain("Import the module under test from './hand.js'.");
    expect(request).toContain('[ex 1] add a card\n[ex 2] reject a duplicate');
    expect(request).toContain("### card: import from './card.js'");
    expect(request).toContain('export class Hand {');
    expect(request).not.toContain('no duplicates');
  });
});

describe('implRequest', () => {
  it('includes the concept, dependencies, allowed packages, and tests', () => {
    const request = implRequest(hand, project, exportsByConcept, "it('[ex 1] adds', () => {});");
    expect(request.split('\n')[0]).toBe('Write the implementation module for concept `hand` (collection).');
    expect(request).toContain('Module: .ccc/gen/hand.ts');
    expect(request).toContain('Allowed packages: @ccc/runtime.');
    expect(request).toContain('## Rules\n- no duplicates');
    expect(request).toContain("### card: import from './card.js'\n```ts\nexport interface Card { readonly rank: string }\n```");
    expect(request).toContain("## Tests your module must pass (.ccc/gen/hand.test.ts)\n```ts\nit('[ex 1] adds', () => {});\n```");
  });

  it('says so when there are no dependencies', () => {
    const card = project.concepts.get('card');
    if (card === undefined) throw new Error('fixture');
    expect(implRequest(card, project, exportsByConcept, '')).toContain('## Dependencies\nNone.');
  });
});

describe('feedbackMessage', () => {
  it('lists problems and caps the list', () => {
    expect(feedbackMessage(['a', 'b'])).toBe(
      'Your module failed these checks. Fix every problem and call write_module again with the complete file.\n\n- a\n- b',
    );
    const many = feedbackMessage(Array.from({ length: 52 }, (_, i) => `p${i}`));
    expect(many).toContain('- p49\n- …and 2 more');
    expect(many).not.toContain('- p50');
  });
});
