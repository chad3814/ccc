import { describe, expect, it } from 'vitest';
import { collectExports } from '../src/interfaces.js';
import { implKey, interfaceTextOf, testKey } from '../src/keys.js';
import type { Versions } from '../src/versions.js';
import { concept, projectFrom } from './helpers.js';

const VERSIONS: Versions = { implPrompt: 'ip', testPrompt: 'tp', syncPrompt: 'sp', implModel: 'm1', testModel: 'm2', runtime: 'r' };

const CARD = (extra = '') =>
  concept(`kind: value\ninterface: |\n  export interface Card { readonly rank: string }${extra}`, '## Intent\nA card.\n\n## Rules\n- ranks are strings\n\n## Examples\n- a\n');
const HAND = (rules = '- no duplicates', examples = '- add a card') =>
  concept('kind: collection\nof: card\ninterface: |\n  export class Hand {\n    add(card: Card): void;\n  }', `## Intent\nCards held.\n\n## Rules\n${rules}\n\n## Examples\n${examples}\n`);

async function keysFor(files: Record<string, string>, id: string, versions: Versions = VERSIONS, testHash = 'h') {
  const project = projectFrom(files);
  const exportsByConcept = collectExports(project);
  const target = project.concepts.get(id);
  if (target === undefined) throw new Error('fixture');
  return {
    test: await testKey(target, project, exportsByConcept, versions),
    impl: await implKey(target, project, exportsByConcept, versions, testHash),
  };
}

const BASE = { 'card.md': CARD(), 'hand.md': HAND() };

describe('cache keys', () => {
  it('are deterministic', async () => {
    expect(await keysFor(BASE, 'hand')).toEqual(await keysFor(BASE, 'hand'));
  });

  it('change only the implementation key when Rules change', async () => {
    const before = await keysFor(BASE, 'hand');
    const after = await keysFor({ ...BASE, 'hand.md': HAND('- no duplicates, ever') }, 'hand');
    expect(after.test).toBe(before.test);
    expect(after.impl).not.toBe(before.impl);
  });

  it('change both keys when Examples change', async () => {
    const before = await keysFor(BASE, 'hand');
    const after = await keysFor({ ...BASE, 'hand.md': HAND(undefined, '- add two cards') }, 'hand');
    expect(after.test).not.toBe(before.test);
    expect(after.impl).not.toBe(before.impl);
  });

  it('follow dependency interfaces but not dependency prose', async () => {
    const before = await keysFor(BASE, 'hand');
    const iface = await keysFor({ ...BASE, 'card.md': CARD('\n  export type Suit = string;') }, 'hand');
    expect(iface.test).not.toBe(before.test);
    expect(iface.impl).not.toBe(before.impl);
    const prose = await keysFor({ ...BASE, 'card.md': CARD().replace('ranks are strings', 'ranks are short strings') }, 'hand');
    expect(prose).toEqual(before);
  });

  it('include the test file hash, models, and prompt versions', async () => {
    const before = await keysFor(BASE, 'hand');
    const testHash = await keysFor(BASE, 'hand', VERSIONS, 'other');
    expect(testHash.test).toBe(before.test);
    expect(testHash.impl).not.toBe(before.impl);
    const implModel = await keysFor(BASE, 'hand', { ...VERSIONS, implModel: 'm3' });
    expect(implModel.test).toBe(before.test);
    expect(implModel.impl).not.toBe(before.impl);
    const testModel = await keysFor(BASE, 'hand', { ...VERSIONS, testModel: 'm3' });
    expect(testModel.test).not.toBe(before.test);
    expect(testModel.impl).toBe(before.impl);
  });

  it('use the sync prompt for syncs', async () => {
    const files = {
      ...BASE,
      'counter.md': concept('kind: entity\ninterface: |\n  export class Counter {\n    increment(): void;\n  }'),
      'count-adds.md': concept('kind: sync\nwhen: hand#add\nthen: [counter#increment]'),
    };
    const before = await keysFor(files, 'count-adds');
    expect((await keysFor(files, 'count-adds', { ...VERSIONS, implPrompt: 'other' })).impl).toBe(before.impl);
    expect((await keysFor(files, 'count-adds', { ...VERSIONS, syncPrompt: 'other' })).impl).not.toBe(before.impl);
  });

  it('expose the synthesized interface text for syncs', () => {
    const project = projectFrom({
      ...BASE,
      'counter.md': concept('kind: entity\ninterface: |\n  export class Counter {\n    increment(): void;\n  }'),
      'count-adds.md': concept('kind: sync\nwhen: hand#add\nthen: [counter#increment]'),
    });
    const sync = project.concepts.get('count-adds');
    if (sync === undefined) throw new Error('fixture');
    expect(interfaceTextOf(sync, collectExports(project))).toContain('export interface SyncTargets');
  });

  it('key tests on transitive dependencies and implementations on direct ones', async () => {
    const files = {
      ...BASE,
      'counter.md': concept('kind: entity\ninterface: |\n  export class Counter {\n    increment(): void;\n  }'),
      'count-adds.md': concept('kind: sync\nwhen: hand#add\nthen: [counter#increment]'),
    };
    const before = await keysFor(files, 'count-adds');
    const after = await keysFor({ ...files, 'card.md': CARD('\n  export type Suit = string;') }, 'count-adds');
    expect(after.test).not.toBe(before.test);
    expect(after.impl).toBe(before.impl);
  });
});

