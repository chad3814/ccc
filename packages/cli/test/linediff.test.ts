import { describe, expect, it } from 'vitest';
import { lineDiff } from '../src/linediff.js';

describe('lineDiff', () => {
  it('counts added and removed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual({ added: 2, removed: 1 });
    expect(lineDiff('', 'a')).toEqual({ added: 1, removed: 1 });
  });
});
