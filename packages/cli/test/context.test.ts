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

describe('adapter requests', () => {
  const adapterProject = projectFrom({
    'tally.md': concept('kind: aggregate\ninterface: |\n  export class Tally {\n    add(n: number): void;\n  }'),
    'tally-store.md': concept(
      "kind: store\npersists: tally\ninterface: |\n  import type { Database } from '@ccc/runtime';\n  export class TallyStore {\n    constructor(db: Database);\n    save(t: Tally): Promise<void>;\n  }",
      '## Intent\nx\n\n## Schema\n```sql\ncreate table t (n integer);\n```\n\n## Examples\n- a\n',
    ),
    'notify.md': concept('kind: sync\nwhen: tally#add\nthen: [tally-store#save, tally#add]'),
    'api.md': concept(
      'kind: endpoint\nuses: [tally, tally-store]\ninterface: |\n  export function createHandler(deps: object): (request: Request) => Promise<Response>;',
    ),
  });
  const adapterExports = collectExports(adapterProject);
  const get = (id: string) => {
    const found = adapterProject.concepts.get(id);
    if (found === undefined) throw new Error('fixture');
    return found;
  };

  it('tells store and endpoint test writers how to get a database and an app', () => {
    const storeRequest = testRequest(get('tally-store'), adapterProject, adapterExports, ['tally']);
    expect(storeRequest).toContain("## Test support\nCreate a database with `pgliteDatabase()` from '@ccc/runtime/pglite', then run `await db.exec(schemaSql)` with `schemaSql` from './schema.js'.");
    expect(storeRequest).not.toContain('createApp');
    const apiRequest = testRequest(get('api'), adapterProject, adapterExports, ['tally', 'tally-store']);
    expect(apiRequest).toContain("Build the app with `const app = await createApp(db, { endpoints: ['api'] })` from './server.js'");
    const plain = testRequest(get('tally'), adapterProject, adapterExports, []);
    expect(plain).not.toContain('## Test support');
  });

  it('lists syncs an endpoint may trigger and what they need in scope', () => {
    const request = implRequest(get('api'), adapterProject, adapterExports, '');
    expect(request).toContain('## Syncs that may fire\n- notify: after tally#add; bind in scope: tally');
  });
});
