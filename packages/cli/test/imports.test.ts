import { describe, expect, it } from 'vitest';
import {
  PACKAGES_BY_KIND,
  checkImports,
  moduleImportsFor,
  packageName,
  scanImports,
  testImportsFor,
  transitiveDependencies,
} from '../src/imports.js';
import { concept, projectFrom } from './helpers.js';

describe('scanImports', () => {
  it('finds static, type-only, re-export, dynamic, and require imports with lines', () => {
    const source = [
      "import { a } from './a.js';",
      "import type { B } from '../b.js';",
      "export * from './c.js';",
      "const d = await import('./d.js');",
      "const e = require('e');",
      "import f = require('f');",
    ].join('\n');
    expect(scanImports(source)).toEqual([
      { specifier: './a.js', line: 1, dynamic: false },
      { specifier: '../b.js', line: 2, dynamic: false },
      { specifier: './c.js', line: 3, dynamic: false },
      { specifier: './d.js', line: 4, dynamic: true },
      { specifier: 'e', line: 5, dynamic: true },
      { specifier: 'f', line: 6, dynamic: true },
    ]);
  });
});

describe('packageName', () => {
  it('strips subpaths', () => {
    expect(packageName('hono/cors')).toBe('hono');
    expect(packageName('@ccc/runtime/errors')).toBe('@ccc/runtime');
    expect(packageName('node:fs')).toBe('node:fs');
  });
});

describe('checkImports', () => {
  const allowed = new Set(['./card.js']);
  it('accepts allowed modules and packages', () => {
    expect(checkImports("import { card } from './card.js';\nimport { Hono } from 'hono/tiny';", allowed, ['hono'])).toEqual([]);
  });
  it('reports undeclared modules, disallowed packages, and dynamic imports', () => {
    const source = "import { x } from './secret.js';\nimport fs from 'node:fs';\nconst m = await import('./card.js');";
    expect(checkImports(source, allowed, PACKAGES_BY_KIND.value)).toEqual([
      "line 1: './secret.js' is not a dependency of this concept (allowed: ./card.js)",
      "line 2: package 'node:fs' is not allowed here (allowed: @ccc/runtime)",
      'line 3: dynamic import() and require() are not allowed',
    ]);
  });
});

describe('allowed imports per concept', () => {
  const project = projectFrom({
    'card.md': concept('kind: value\ninterface: |\n  export interface Card { readonly rank: string }'),
    'hand.md': concept('kind: collection\nof: card\ninterface: |\n  export class Hand {\n    add(card: Card): void;\n  }'),
    'counter.md': concept('kind: entity\ninterface: |\n  export class Counter {\n    increment(): void;\n  }'),
    'count-adds.md': concept('kind: sync\nwhen: hand#add\nthen: [counter#increment]'),
  });
  const get = (id: string) => {
    const found = project.concepts.get(id);
    if (found === undefined) throw new Error('fixture');
    return found;
  };

  it('lets modules import their direct dependencies', () => {
    expect([...moduleImportsFor(get('hand'), project)]).toEqual(['./card.js']);
    expect([...moduleImportsFor(get('count-adds'), project)]).toEqual(['./counter.js', './hand.js']);
  });

  it('lets tests import the module under test and all transitive dependencies', () => {
    expect(transitiveDependencies(get('count-adds'), project)).toEqual(['card', 'counter', 'hand']);
    expect([...testImportsFor(get('count-adds'), project)].sort()).toEqual([
      './card.js',
      './count-adds.js',
      './counter.js',
      './hand.js',
    ]);
  });
});
