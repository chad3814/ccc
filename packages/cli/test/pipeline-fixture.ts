import { configSchema, type Config } from '../src/config.js';
import { collectExports } from '../src/interfaces.js';
import type { Generator } from '../src/llm.js';
import { loadProject } from '../src/load.js';
import type { GenerateContext } from '../src/testgen.js';
import type { FakeRequest, FakeResponder } from './fake-generator.js';
import { writeProject } from './helpers.js';

// Four concepts covering functions, a class with a dependency, an entity, and
// a sync. Levels: card, counter → hand → count-adds.
export const PIPELINE_FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "type": "module" }\n',
  'concepts/card.md': [
    '---',
    'kind: value',
    'interface: |',
    '  export interface Card {',
    '    readonly rank: string;',
    '    readonly suit: string;',
    '  }',
    '  export function card(rank: string, suit: string): Card;',
    '  export function sameCard(a: Card, b: Card): boolean;',
    '---',
    '## Intent',
    'A playing card.',
    '',
    '## Examples',
    '- card("A", "♠") → { rank: "A", suit: "♠" }',
    '- sameCard(card("A", "♠"), card("A", "♠")) → true',
    '',
  ].join('\n'),
  'concepts/hand.md': [
    '---',
    'kind: collection',
    'of: card',
    'interface: |',
    '  export class DuplicateCard extends Error {}',
    '  export class Hand {',
    '    constructor(cards?: readonly Card[]);',
    '    add(card: Card): void;',
    '    size(): number;',
    '  }',
    '---',
    '## Intent',
    'The cards a player holds.',
    '',
    '## Rules',
    '- A hand never holds the same card twice.',
    '',
    '## Examples',
    '- given an empty hand, add(A♠) → size is 1',
    '- given hand [A♠], add(A♠) → throws DuplicateCard',
    '',
  ].join('\n'),
  'concepts/counter.md': [
    '---',
    'kind: entity',
    'interface: |',
    '  export class Counter {',
    '    increment(): void;',
    '    value(): number;',
    '  }',
    '---',
    '## Intent',
    'Counts events.',
    '',
    '## Examples',
    '- new Counter().value() → 0',
    '- after increment(), value() → 1',
    '',
  ].join('\n'),
  'concepts/count-adds.md': [
    '---',
    'kind: sync',
    'when: hand#add',
    'then: [counter#increment]',
    '---',
    '## Intent',
    'Count every card added to a hand.',
    '',
    '## Examples',
    '- given a hand and a counter at 0, adding a card → counter is 1',
    '',
  ].join('\n'),
};

export const CANNED_TESTS: Readonly<Record<string, string>> = {
  card: [
    "import { card, sameCard } from './card.js';",
    '',
    "describe('card', () => {",
    "  it('[ex 1] builds a card', () => {",
    "    expect(card('A', '♠')).toEqual({ rank: 'A', suit: '♠' });",
    '  });',
    "  it('[ex 2] compares cards by rank and suit', () => {",
    "    expect(sameCard(card('A', '♠'), card('A', '♠'))).toBe(true);",
    '  });',
    '});',
    '',
  ].join('\n'),
  hand: [
    "import { card } from './card.js';",
    "import { DuplicateCard, Hand } from './hand.js';",
    '',
    "describe('Hand', () => {",
    "  it('[ex 1] adds a card to an empty hand', () => {",
    '    const hand = new Hand();',
    "    hand.add(card('A', '♠'));",
    '    expect(hand.size()).toBe(1);',
    '  });',
    "  it('[ex 2] rejects a duplicate card', () => {",
    "    const hand = new Hand([card('A', '♠')]);",
    "    expect(() => hand.add(card('A', '♠'))).toThrow(DuplicateCard);",
    '  });',
    '});',
    '',
  ].join('\n'),
  counter: [
    "import { Counter } from './counter.js';",
    '',
    "describe('Counter', () => {",
    "  it('[ex 1] starts at zero', () => {",
    '    expect(new Counter().value()).toBe(0);',
    '  });',
    "  it('[ex 2] counts increments', () => {",
    '    const counter = new Counter();',
    '    counter.increment();',
    '    expect(counter.value()).toBe(1);',
    '  });',
    '});',
    '',
  ].join('\n'),
  'count-adds': [
    "import { card } from './card.js';",
    "import { Counter } from './counter.js';",
    "import { Hand } from './hand.js';",
    "import { handle } from './count-adds.js';",
    '',
    "describe('count-adds', () => {",
    "  it('[ex 1] increments the counter when a card is added', async () => {",
    '    const hand = new Hand();',
    '    const counter = new Counter();',
    "    await handle({ target: hand, args: [card('A', '♠')], result: undefined }, { counter });",
    '    expect(counter.value()).toBe(1);',
    '  });',
    '});',
    '',
  ].join('\n'),
};

export const CANNED_IMPL: Readonly<Record<string, string>> = {
  card: [
    'export interface Card {',
    '  readonly rank: string;',
    '  readonly suit: string;',
    '}',
    '',
    'export function card(rank: string, suit: string): Card {',
    '  return { rank, suit };',
    '}',
    '',
    'export function sameCard(a: Card, b: Card): boolean {',
    '  return a.rank === b.rank && a.suit === b.suit;',
    '}',
    '',
  ].join('\n'),
  hand: [
    "import { sameCard, type Card } from './card.js';",
    '',
    'export class DuplicateCard extends Error {}',
    '',
    'export class Hand {',
    '  readonly #cards: Card[];',
    '',
    '  constructor(cards: readonly Card[] = []) {',
    '    this.#cards = [...cards];',
    '  }',
    '',
    '  add(card: Card): void {',
    '    if (this.#cards.some((held) => sameCard(held, card))) {',
    '      throw new DuplicateCard(`${card.rank}${card.suit} is already in the hand`);',
    '    }',
    '    this.#cards.push(card);',
    '  }',
    '',
    '  size(): number {',
    '    return this.#cards.length;',
    '  }',
    '}',
    '',
  ].join('\n'),
  counter: [
    'export class Counter {',
    '  #count = 0;',
    '',
    '  increment(): void {',
    '    this.#count += 1;',
    '  }',
    '',
    '  value(): number {',
    '    return this.#count;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'count-adds': [
    "import type { Counter } from './counter.js';",
    "import type { Hand } from './hand.js';",
    '',
    'export interface SyncEvent {',
    '  readonly target: Hand;',
    "  readonly args: Parameters<Hand['add']>;",
    "  readonly result: Awaited<ReturnType<Hand['add']>>;",
    '}',
    '',
    'export interface SyncTargets {',
    '  readonly counter: Counter;',
    '}',
    '',
    'export async function handle(_event: SyncEvent, targets: SyncTargets): Promise<void> {',
    '  targets.counter.increment();',
    '}',
    '',
  ].join('\n'),
};

export function conceptOf(request: FakeRequest): string {
  return /concept `([^`]+)`/.exec(request.messages[0] ?? '')?.[1] ?? '';
}

export function artifactOf(request: FakeRequest): 'tests' | 'impl' {
  return request.system.startsWith('You are the test writer') ? 'tests' : 'impl';
}

export type Overrides = Readonly<Record<string, (attempt: number) => string | null>>;

// Answers with the canned source for the concept unless an override for
// `<artifact>:<id>` exists; overrides get the attempt number (1-based).
export function pipelineResponder(overrides: Overrides = {}): FakeResponder {
  return (request) => {
    const id = conceptOf(request);
    const artifact = artifactOf(request);
    const override = overrides[`${artifact}:${id}`];
    if (override !== undefined) {
      return override(request.messages.length);
    }
    return (artifact === 'tests' ? CANNED_TESTS : CANNED_IMPL)[id] ?? null;
  };
}

export async function createPipelineProject(): Promise<string> {
  return writeProject({ ...PIPELINE_FILES });
}

export async function pipelineContext(root: string, generator: Generator, config: Partial<Config> = {}): Promise<GenerateContext> {
  const { project } = await loadProject(root);
  return {
    root,
    project,
    exportsByConcept: collectExports(project),
    generator,
    config: { ...configSchema.parse({}), ...config },
    now: Date.now,
  };
}
