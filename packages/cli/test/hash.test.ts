import { describe, expect, it } from 'vitest';
import { normalizeConcept, sha256, stableStringify } from '../src/hash.js';
import { parseConcept } from '../src/parse.js';

function parsed(text: string) {
  const result = parseConcept('a', 'concepts/a.md', text);
  if (result.concept === null) throw new Error('fixture');
  return result.concept;
}

const A = '---\nkind: value\ninterface: export type A = string;\nuses: []\n---\n## Intent\nAn A.   \n\n## Rules\n- one\n\n## Examples\n- e\n';

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('sha256', () => {
  it('hashes text as lowercase hex', async () => {
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('normalizeConcept', () => {
  it('ignores key order, section order, trailing whitespace, and line endings', () => {
    const reordered = '---\nuses: []\nkind: value\ninterface: export type A = string;\n---\n## Rules\n- one\n\n## Intent\nAn A.\n\n## Examples\n- e\n';
    expect(normalizeConcept(parsed(reordered))).toBe(normalizeConcept(parsed(A)));
    expect(normalizeConcept(parsed(A.replace(/\n/g, '\r\n')))).toBe(normalizeConcept(parsed(A)));
  });
  it('changes when content changes', () => {
    expect(normalizeConcept(parsed(A.replace('- one', '- two')))).not.toBe(normalizeConcept(parsed(A)));
  });
});
