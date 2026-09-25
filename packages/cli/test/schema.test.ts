import { describe, expect, it } from 'vitest';
import { frontmatterSchema, isAdapterKind, isDomainKind, isHandwritten, sectionRule, usesOf } from '../src/schema.js';

const iface = 'export interface Card { readonly rank: string; }';

describe('frontmatterSchema', () => {
  it('accepts a minimal value concept and fills defaults', () => {
    const result = frontmatterSchema.parse({ kind: 'value', interface: iface });
    expect(result).toEqual({ kind: 'value', interface: iface, uses: [], implementation: 'generated' });
  });
  it('accepts every kind with its required fields', () => {
    const ok = [
      { kind: 'entity', interface: iface },
      { kind: 'aggregate', interface: iface },
      { kind: 'collection', interface: iface, of: 'card' },
      { kind: 'store', interface: iface, persists: 'game' },
      { kind: 'endpoint', interface: iface, uses: ['game', 'game-store'] },
      { kind: 'auth', interface: iface },
      { kind: 'sync', when: 'game.players#join', then: ['game#deal'] },
    ];
    for (const input of ok) {
      expect(frontmatterSchema.safeParse(input).success).toBe(true);
    }
  });
  it('rejects unknown keys such as id', () => {
    expect(frontmatterSchema.safeParse({ kind: 'value', interface: iface, id: 'card' }).success).toBe(false);
  });
  it('requires kind-specific fields', () => {
    expect(frontmatterSchema.safeParse({ kind: 'collection', interface: iface }).success).toBe(false);
    expect(frontmatterSchema.safeParse({ kind: 'store', interface: iface }).success).toBe(false);
    expect(frontmatterSchema.safeParse({ kind: 'sync', when: 'game#deal', then: [] }).success).toBe(false);
  });
  it('requires interface except for syncs', () => {
    expect(frontmatterSchema.safeParse({ kind: 'value' }).success).toBe(false);
  });
  it('validates id and action formats', () => {
    expect(frontmatterSchema.safeParse({ kind: 'value', interface: iface, uses: ['Card'] }).success).toBe(false);
    expect(frontmatterSchema.safeParse({ kind: 'sync', when: 'game.deal', then: ['game#deal'] }).success).toBe(false);
  });
  it('ties handwritten to source', () => {
    const missing = frontmatterSchema.safeParse({ kind: 'value', interface: iface, implementation: 'handwritten' });
    expect(missing.success).toBe(false);
    const stray = frontmatterSchema.safeParse({ kind: 'value', interface: iface, source: 'handwritten/card.ts' });
    expect(stray.success).toBe(false);
    const ok = frontmatterSchema.safeParse({
      kind: 'value',
      interface: iface,
      implementation: 'handwritten',
      source: 'handwritten/card.ts',
    });
    expect(ok.success).toBe(true);
  });
});

describe('kind groups and section rules', () => {
  it('classifies kinds', () => {
    expect(isDomainKind('aggregate')).toBe(true);
    expect(isAdapterKind('aggregate')).toBe(false);
    expect(isAdapterKind('store')).toBe(true);
    expect(isDomainKind('sync')).toBe(false);
    expect(isAdapterKind('sync')).toBe(false);
  });
  it('requires Schema only for stores', () => {
    expect(sectionRule('store').required).toEqual(['Intent', 'Schema']);
    expect(sectionRule('value').required).toEqual(['Intent']);
    expect(sectionRule('value').allowed).not.toContain('Schema');
    expect(sectionRule('sync').recommended).toEqual(['Examples']);
  });
  it('reads uses for any kind', () => {
    expect(usesOf(frontmatterSchema.parse({ kind: 'sync', when: 'a#b', then: ['c#d'] }))).toEqual([]);
    expect(usesOf(frontmatterSchema.parse({ kind: 'value', interface: iface, uses: ['card'] }))).toEqual(['card']);
  });
});

describe('isHandwritten', () => {
  it('is true only for handwritten non-sync concepts', () => {
    const iface = 'export type A = string;';
    expect(isHandwritten(frontmatterSchema.parse({ kind: 'value', interface: iface }))).toBe(false);
    expect(
      isHandwritten(frontmatterSchema.parse({ kind: 'value', interface: iface, implementation: 'handwritten', source: 'h.ts' })),
    ).toBe(true);
    expect(isHandwritten(frontmatterSchema.parse({ kind: 'sync', when: 'a#b', then: ['c#d'] }))).toBe(false);
  });
});

describe('auth sections', () => {
  it('allows an optional Schema section', () => {
    expect(sectionRule('auth')).toEqual({
      required: ['Intent'],
      recommended: ['Examples'],
      allowed: ['Intent', 'Rules', 'Examples', 'Decisions', 'Schema'],
    });
  });
});
