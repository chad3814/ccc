import { describe, expect, it } from 'vitest';
import { error, formatDiagnostic, hasErrors, sortDiagnostics, warning } from '../src/diagnostics.js';

describe('diagnostics', () => {
  it('formats with line and hint', () => {
    const d = error('concepts/card.md', 'bad thing', { line: 3, hint: 'fix it' });
    expect(formatDiagnostic(d)).toBe('concepts/card.md:3: error: bad thing\n  hint: fix it');
  });
  it('formats without line or hint', () => {
    expect(formatDiagnostic(warning('concepts/card.md', 'meh'))).toBe('concepts/card.md: warning: meh');
  });
  it('detects errors', () => {
    expect(hasErrors([warning('a', 'x')])).toBe(false);
    expect(hasErrors([warning('a', 'x'), error('a', 'y')])).toBe(true);
  });
  it('sorts by file, then line, then message', () => {
    const sorted = sortDiagnostics([
      error('b.md', 'z', { line: 1 }),
      error('a.md', 'y', { line: 9 }),
      error('a.md', 'x', { line: 2 }),
      error('a.md', 'w'),
    ]);
    expect(sorted.map((d) => `${d.file}:${d.line ?? 0}:${d.message}`)).toEqual([
      'a.md:0:w',
      'a.md:2:x',
      'a.md:9:y',
      'b.md:1:z',
    ]);
  });
});
