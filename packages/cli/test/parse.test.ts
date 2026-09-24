import { describe, expect, it } from 'vitest';
import { parseConcept } from '../src/parse.js';

const FILE = 'concepts/game/player/hand.md';

const VALID = `---
kind: collection
of: card
uses: [card]
interface: |
  export class Hand {
    add(card: Card): void;
  }
---
## Intent
The cards a player holds.

## Rules
- Never contains the same card twice.

## Examples
- given an empty hand, add(A♠) → size is 1
- given hand [A♠], add(A♠)
  → throws DuplicateCard

## Decisions
- Unordered.
`;

function messages(text: string): string[] {
  return parseConcept('game.player.hand', FILE, text).diagnostics.map((d) => `${d.severity}: ${d.message}`);
}

describe('parseConcept', () => {
  it('parses a valid concept', () => {
    const { concept, diagnostics } = parseConcept('game.player.hand', FILE, VALID);
    expect(diagnostics).toEqual([]);
    expect(concept?.frontmatter.kind).toBe('collection');
    expect([...(concept?.sections.keys() ?? [])]).toEqual(['Intent', 'Rules', 'Examples', 'Decisions']);
    expect(concept?.sections.get('Intent')?.body).toBe('The cards a player holds.');
    expect(concept?.sections.get('Intent')?.line).toBe(10);
    expect(concept?.examples).toEqual([
      'given an empty hand, add(A♠) → size is 1',
      'given hand [A♠], add(A♠) → throws DuplicateCard',
    ]);
  });

  it('parses CRLF line endings and a BOM identically', () => {
    const crlf = `﻿${VALID.replace(/\n/g, '\r\n')}`;
    const a = parseConcept('game.player.hand', FILE, VALID);
    const b = parseConcept('game.player.hand', FILE, crlf);
    expect(b.diagnostics).toEqual([]);
    expect(b.concept?.examples).toEqual(a.concept?.examples);
    expect(b.concept?.frontmatter).toEqual(a.concept?.frontmatter);
  });

  it('ignores ## lines inside code fences', () => {
    const text = VALID.replace(
      '## Decisions\n- Unordered.\n',
      '## Decisions\n- Unordered.\n\n```md\n## Rules\nnot a heading\n```\n',
    );
    const { concept, diagnostics } = parseConcept('game.player.hand', FILE, text);
    expect(diagnostics).toEqual([]);
    expect(concept?.sections.get('Decisions')?.body).toContain('## Rules');
  });

  it('keeps a longer fence open across shorter inner fences', () => {
    const text = VALID.replace(
      '## Decisions\n- Unordered.\n',
      '## Decisions\n- Unordered.\n\n````md\n```\n## Bogus\n```\n````\n',
    );
    const { concept, diagnostics } = parseConcept('game.player.hand', FILE, text);
    expect(diagnostics).toEqual([]);
    expect(concept?.sections.get('Decisions')?.body).toContain('## Bogus');
  });

  it('reports missing, unterminated, empty, and malformed frontmatter', () => {
    expect(messages('## Intent\nx\n')).toEqual(["error: missing frontmatter: file must start with a '---' line"]);
    expect(messages('---\nkind: value\n')).toEqual(["error: unterminated frontmatter: no closing '---' line"]);
    expect(messages('---\n---\n## Intent\nx\n')).toEqual(['error: frontmatter must be a YAML mapping of fields']);
    const bad = parseConcept('card', 'concepts/card.md', '---\nkind: [value\n---\n');
    expect(bad.concept).toBeNull();
    expect(bad.diagnostics[0]?.severity).toBe('error');
    expect(bad.diagnostics[0]?.message).toMatch(/^frontmatter: /);
    expect(bad.diagnostics[0]?.line).toBeGreaterThanOrEqual(2);
  });

  it('explains an unknown kind', () => {
    expect(messages('---\nkind: widget\ninterface: x\n---\n## Intent\nx\n')).toEqual([
      'error: frontmatter kind: must be one of value, entity, collection, aggregate, store, endpoint, auth, sync',
    ]);
  });

  it('reports schema violations with the field path', () => {
    expect(messages('---\nkind: collection\ninterface: x\n---\n## Intent\nx\n## Examples\n- a\n')).toContainEqual(
      expect.stringMatching(/^error: frontmatter of: /),
    );
  });

  it('reports unknown, duplicate, missing, and stray-text sections', () => {
    const text = `---
kind: value
interface: export type A = string;
---
stray text
## Example
- oops
## Rules
- a
## Rules
- b
`;
    const { diagnostics } = parseConcept('card', 'concepts/card.md', text);
    const found = diagnostics.map((d) => `${d.severity}:${d.line ?? 0}: ${d.message}`);
    expect(found).toEqual([
      'error:5: text before the first ## section is not part of any section',
      "error:10: duplicate section '## Rules'",
      "error:6: unknown section '## Example'",
      "error:1: missing required section '## Intent'",
      "warning:1: missing '## Examples' section; ccc build requires it",
    ]);
    expect(diagnostics.find((d) => d.message.startsWith('unknown section'))?.hint).toBe(
      "allowed sections for kind 'value': Intent, Rules, Examples, Decisions",
    );
  });

  it('requires Examples to be a bulleted list', () => {
    const text = VALID.replace('- given an empty hand, add(A♠) → size is 1', 'given an empty hand');
    const d = parseConcept('game.player.hand', FILE, text).diagnostics;
    expect(d.map((x) => x.message)).toEqual(['Examples must be a bulleted list (one "- " bullet per example)']);
    expect(d[0]?.line).toBe(17);
  });

  it('warns on an empty Examples section and errors on an empty required section', () => {
    const text = '---\nkind: value\ninterface: export type A = string;\n---\n## Intent\n\n## Examples\n';
    expect(messages(text)).toEqual([
      "error: section '## Intent' is empty",
      "warning: '## Examples' has no examples; ccc build requires at least one",
    ]);
  });

  it('reports an unclosed code fence', () => {
    const text = '---\nkind: value\ninterface: export type A = string;\n---\n## Intent\nx\n```ts\nconst a = 1;\n## Examples\n';
    expect(messages(text)).toContain('error: unclosed code fence ```');
  });
});
