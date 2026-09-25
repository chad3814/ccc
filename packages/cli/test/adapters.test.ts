import { describe, expect, it } from 'vitest';
import { checkAdapters, storeSchemaSql } from '../src/adapters.js';
import { collectExports } from '../src/interfaces.js';
import { concept, projectFrom } from './helpers.js';

const TALLY = concept('kind: aggregate\ninterface: |\n  export class Tally {\n    add(amount: number): void;\n  }');
const storeBody = (sql: string) => `## Intent\nx\n\n## Schema\n${sql}\n\n## Examples\n- a\n`;
const STORE = concept(
  "kind: store\npersists: tally\ninterface: |\n  import type { Database } from '@ccc/runtime';\n  export class TallyStore {\n    constructor(db: Database);\n  }",
  storeBody('```sql\ncreate table tallies (id text primary key);\n```'),
);

function messages(files: Record<string, string>): string[] {
  const project = projectFrom(files);
  return checkAdapters(project, collectExports(project)).map((d) => `${d.file}: ${d.message}`);
}

describe('storeSchemaSql', () => {
  it('extracts the sql block', () => {
    const project = projectFrom({ 'tally.md': TALLY, 'tally-store.md': STORE });
    const store = project.concepts.get('tally-store');
    if (store === undefined) throw new Error('fixture');
    expect(storeSchemaSql(store)).toBe('create table tallies (id text primary key);');
  });
});

describe('checkAdapters', () => {
  it('accepts conventional adapters and syncs', () => {
    expect(
      messages({
        'tally.md': TALLY,
        'tally-store.md': STORE,
        'auth.md': concept(
          "kind: auth\ninterface: |\n  import type { Database } from '@ccc/runtime';\n  export class Auth {\n    constructor(db: Database);\n    authenticate(request: Request): Promise<string | null>;\n  }",
        ),
        'tally-api.md': concept(
          'kind: endpoint\ninterface: |\n  export function createHandler(deps: object): (request: Request) => Promise<Response>;',
        ),
        'log-adds.md': concept('kind: sync\nwhen: tally#add\nthen: [tally-store#save]'),
      }),
    ).toEqual([]);
  });

  it('reports reserved names, missing schema, missing classes, and missing handlers', () => {
    const found = messages({
      'tally.md': TALLY,
      'server.md': concept('kind: value\ninterface: export type S = string;'),
      'tally-store.md': concept(
        'kind: store\npersists: tally\ninterface: export class Wrong {}',
        storeBody('create table tallies (id text);'),
      ),
      'auth.md': concept('kind: auth\ninterface: |\n  export class Auth {\n    login(): void;\n  }'),
      'tally-api.md': concept('kind: endpoint\ninterface: |\n  export function handle(r: Request): Promise<Response>;'),
    });
    expect(found).toEqual([
      'concepts/auth.md: auth interface must export class Auth with an authenticate(request) method',
      "concepts/server.md: 'server' is reserved for generated files; rename the concept",
      'concepts/tally-api.md: endpoint interface must export function createHandler(deps)',
      'concepts/tally-store.md: ## Schema must contain a ```sql code block with the table definitions',
      'concepts/tally-store.md: store interface must export class TallyStore (constructor(db: Database))',
    ]);
  });

  it('requires sync triggers to be methods', () => {
    expect(
      messages({
        'card.md': concept('kind: value\ninterface: |\n  export function card(): string;\n  export function other(): string;'),
        'deal.md': concept('kind: sync\nwhen: card#card\nthen: [card#other]'),
      }),
    ).toEqual(["concepts/deal.md: card#card: sync triggers must be methods of class Card; exported functions can't be wired"]);
  });
});
