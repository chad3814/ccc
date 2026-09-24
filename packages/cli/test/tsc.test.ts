import { describe, expect, it } from 'vitest';
import { parseTscLines } from '../src/tsc.js';

describe('parseTscLines', () => {
  it('parses error lines', () => {
    expect(parseTscLines("a.d.ts(4,20): error TS2304: Cannot find name 'Nope'.\n")).toEqual({
      messages: [{ file: 'a.d.ts', line: 4, column: 20, code: 'TS2304', message: "Cannot find name 'Nope'." }],
      other: [],
    });
  });

  it('appends indented continuation lines to the previous message', () => {
    const out = [
      "a.ts(4,7): error TS2322: Type 'A' is not assignable to type 'B'.",
      "  The types of 'x.y' are incompatible between these types.",
      "    Type 'number' is not assignable to type 'string'.",
      "b.ts(1,1): error TS2304: Cannot find name 'C'.",
      '',
    ].join('\n');
    const { messages, other } = parseTscLines(out);
    expect(other).toEqual([]);
    expect(messages.map((m) => `${m.file}: ${m.message}`)).toEqual([
      "a.ts: Type 'A' is not assignable to type 'B'.\nThe types of 'x.y' are incompatible between these types.\nType 'number' is not assignable to type 'string'.",
      "b.ts: Cannot find name 'C'.",
    ]);
  });

  it('keeps unrecognized lines separately', () => {
    expect(parseTscLines('error TS5023: Unknown compiler option.\n').other).toEqual([
      'error TS5023: Unknown compiler option.',
    ]);
  });
});
