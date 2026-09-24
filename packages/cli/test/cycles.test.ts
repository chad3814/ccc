import { describe, expect, it } from 'vitest';
import { findCycles } from '../src/cycles.js';

describe('findCycles', () => {
  it('returns nothing for a DAG', () => {
    expect(findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', []]]))).toEqual([]);
  });
  it('finds a self-loop', () => {
    expect(findCycles(new Map([['a', ['a']]]))).toEqual([['a', 'a']]);
  });
  it('finds a longer cycle as a closed path', () => {
    expect(findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual([['a', 'b', 'c', 'a']]);
  });
  it('handles edges to nodes that are not keys', () => {
    expect(findCycles(new Map([['a', ['missing']]]))).toEqual([]);
  });
});
