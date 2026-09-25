import { describe, expect, it } from 'vitest';
import { dependencyClosure, topologicalLevels } from '../src/order.js';
import { concept, projectFrom } from './helpers.js';

describe('topologicalLevels', () => {
  it('puts endpoints after every other concept', () => {
    const project = projectFrom({
      'card.md': concept('kind: value\ninterface: export type Card = string;'),
      'api.md': concept(
        'kind: endpoint\nuses: [card]\ninterface: |\n  export function createHandler(deps: object): (request: Request) => Promise<Response>;',
      ),
      'hand.md': concept('kind: collection\nof: card\ninterface: export class Hand {}'),
      'deck.md': concept('kind: collection\nof: card\nuses: [hand]\ninterface: export class Deck {}'),
    });
    expect(topologicalLevels(project)).toEqual([['card'], ['hand'], ['deck'], ['api']]);
    expect([...dependencyClosure(project, 'deck')].sort()).toEqual(['card', 'deck', 'hand']);
  });
});
