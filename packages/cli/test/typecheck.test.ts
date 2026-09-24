import { describe, expect, it } from 'vitest';
import { collectExports, emitInterfaces } from '../src/interfaces.js';
import { parseTscOutput, typecheckInterfaces } from '../src/typecheck.js';
import { concept, projectFrom } from './helpers.js';

function emit(files: Record<string, string>) {
  const project = projectFrom(files);
  return emitInterfaces(project, collectExports(project)).files;
}

describe('parseTscOutput', () => {
  const files = emit({
    'card.md': concept('kind: value\ninterface: export type Card = string;'),
    'hand.md': concept('kind: value\nuses: [card]\ninterface: |\n  export class Hand {\n    add(card: Card): Nope;\n  }'),
  });

  it('maps tsc lines to concept files and interface lines', () => {
    const out = "hand.d.ts(4,20): error TS2304: Cannot find name 'Nope'.\n";
    expect(parseTscOutput(out, files)).toEqual([
      {
        severity: 'error',
        file: 'concepts/hand.md',
        line: 1,
        message: "interface line 2: Cannot find name 'Nope'. (TS2304)",
      },
    ]);
  });

  it('keeps a multi-line tsc message as one diagnostic', () => {
    const out = "hand.d.ts(4,20): error TS2322: Type 'A' is not assignable to type 'B'.\n  Types of property 'x' are incompatible.\n";
    expect(parseTscOutput(out, files)).toEqual([
      {
        severity: 'error',
        file: 'concepts/hand.md',
        line: 1,
        message: "interface line 2: Type 'A' is not assignable to type 'B'.\nTypes of property 'x' are incompatible. (TS2322)",
      },
    ]);
  });

  it('keeps unrecognized output as a general error', () => {
    expect(parseTscOutput('error TS5023: Unknown compiler option.\n', files)).toEqual([
      { severity: 'error', file: 'concepts/', message: 'tsc: error TS5023: Unknown compiler option.' },
    ]);
  });
});

describe('typecheckInterfaces (runs TypeScript 7)', () => {
  it('passes valid interfaces, including web types like Request', async () => {
    const files = emit({
      'user.md': concept("kind: value\ninterface: |\n  export type UserId = string & { readonly __brand: 'UserId' };"),
      'auth.md': concept(
        'kind: auth\nuses: [user]\ninterface: |\n  export interface Identity { readonly userId: UserId }\n  export function authenticate(request: Request): Promise<Identity | null>;',
      ),
    });
    expect(await typecheckInterfaces(files)).toEqual([]);
  });

  it('reports a type error on the right concept', async () => {
    const files = emit({
      'card.md': concept('kind: value\ninterface: export type Card = string;'),
      'hand.md': concept('kind: value\nuses: [card]\ninterface: |\n  export class Hand {\n    add(card: Card): Nope;\n  }'),
    });
    const diagnostics = await typecheckInterfaces(files);
    expect(diagnostics.map((d) => `${d.file}: ${d.message}`)).toEqual([
      "concepts/hand.md: interface line 2: Cannot find name 'Nope'. (TS2304)",
    ]);
  });

  it('returns nothing for an empty project', async () => {
    expect(await typecheckInterfaces([])).toEqual([]);
  });
});
