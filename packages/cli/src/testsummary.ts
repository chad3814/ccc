import ts from '@typescript/typescript6';

// One `[ex N]` test, reduced to what a reviewer needs: the claims it makes
// (its expect statements) and a formatting-independent form of its code.
export interface TestCase {
  example: number;
  // Each expect statement on one line; empty when the test asserts some
  // other way (a helper, a thrown error), in which case review shows `body`.
  assertions: string[];
  body: string;
  // What the test runs, for comparing against an approved version: the
  // enclosing describe blocks, then every argument after the title (options
  // and the test function), printed without comments. The title is left out,
  // so rewording it compares equal.
  code: string;
}

const TAG = /^\[ex (\d+)\]/;
const TEST_FUNCTIONS = new Set(['it', 'test']);
const SUITE_FUNCTIONS = new Set(['describe', 'suite']);
// Options that stop a test from running as written.
const DISABLING_OPTIONS = new Set(['skip', 'only', 'todo', 'fails']);
// Bookkeeping calls on expect itself, not claims about behavior.
const EXPECT_BOOKKEEPING = new Set(['assertions', 'hasAssertions']);

const printer = ts.createPrinter({ removeComments: true });

function calleeName(call: ts.CallExpression): string | null {
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : call.expression;
  return ts.isIdentifier(callee) ? callee.text : null;
}

function isTestCall(call: ts.CallExpression): boolean {
  return TEST_FUNCTIONS.has(calleeName(call) ?? '');
}

function isSuiteCall(call: ts.CallExpression): boolean {
  return SUITE_FUNCTIONS.has(calleeName(call) ?? '');
}

function isFunction(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function tagOf(call: ts.CallExpression): number | null {
  const title = call.arguments[0];
  if (title === undefined || !(ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
    return null;
  }
  const match = TAG.exec(title.text);
  return match === null ? null : Number(match[1]);
}

function isExpectStatement(statement: ts.ExpressionStatement): boolean {
  let node: ts.Expression = ts.isAwaitExpression(statement.expression) ? statement.expression.expression : statement.expression;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'expect' &&
    EXPECT_BOOKKEEPING.has(node.expression.name.text)
  ) {
    return false;
  }
  while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  return ts.isIdentifier(node) && node.text === 'expect';
}

// Joins a multi-line statement into one line, dropping the whitespace and
// trailing commas that line breaks introduced inside parentheses and brackets.
function oneLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
    .replace(/([([])\s+/g, '$1')
    .replace(/,?\s+([)\]])/g, '$1')
    .replace(/\{\s+/g, '{ ')
    .replace(/,?\s+\}/g, ' }');
}

function dedent(text: string): string {
  const lines = text.split('\n');
  const indents = lines.slice(1).filter((line) => line.trim() !== '').map((line) => /^ */.exec(line)?.[0].length ?? 0);
  const strip = indents.length === 0 ? 0 : Math.min(...indents);
  return [lines[0] ?? '', ...lines.slice(1).map((line) => line.slice(strip))].join('\n');
}

function bodyText(fn: ts.ArrowFunction | ts.FunctionExpression, file: ts.SourceFile): string {
  const body = fn.body;
  if (!ts.isBlock(body)) {
    return body.getText(file);
  }
  return dedent(body.statements.map((statement) => statement.getFullText(file)).join('').replace(/^\s*\n/, '').trimEnd()).trim();
}

function assertionsIn(fn: ts.Node, file: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && isExpectStatement(node)) {
      found.push(oneLine(node.getText(file)));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

export function testCases(source: string): TestCase[] {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cases: TestCase[] = [];
  const print = (node: ts.Node): string => printer.printNode(ts.EmitHint.Unspecified, node, file);
  const visit = (node: ts.Node, suites: readonly string[]): void => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const example = tagOf(node);
      const fn = node.arguments.find(isFunction);
      if (example !== null && fn !== undefined) {
        cases.push({
          example,
          assertions: assertionsIn(fn, file),
          body: bodyText(fn, file),
          code: [...suites, ...node.arguments.slice(1).map(print)].join('\n'),
        });
        return;
      }
    }
    if (ts.isCallExpression(node) && isSuiteCall(node)) {
      // A suite's title and options (not its body) identify the setup a
      // test inherits; moving a test to another suite changes its code.
      const signature = `${print(node.expression)}(${node.arguments.filter((arg) => !isFunction(arg)).map(print).join(', ')})`;
      ts.forEachChild(node, (child) => visit(child, [...suites, signature]));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, suites));
  };
  visit(file, []);
  return cases;
}

// Options objects can disable a test as surely as `.skip` can.
export function optionProblems(source: string): string[] {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (isTestCall(node) || isSuiteCall(node))) {
      for (const arg of node.arguments.filter(ts.isObjectLiteralExpression)) {
        for (const property of arg.properties) {
          const name = property.name !== undefined && ts.isIdentifier(property.name) ? property.name.text : null;
          if (name !== null && DISABLING_OPTIONS.has(name)) {
            found.add(name);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const names = [...found].sort();
  return names.length === 0 ? [] : [`tests must not set ${names.join(', ')} in their options (every example must run)`];
}

// Everything in the file outside the tagged tests (imports, helpers,
// beforeEach), printed without comments or formatting. A change here can
// change what every test does even when no test's own code changed.
export function sharedCode(source: string): string {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cuts: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node) && tagOf(node) !== null) {
      cuts.push([node.getStart(file), node.getEnd()]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  let rest = source;
  for (const [start, end] of cuts.reverse()) {
    rest = `${rest.slice(0, start)}${rest.slice(end)}`;
  }
  const remaining = ts.createSourceFile('shared.ts', rest, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return printer.printFile(remaining);
}
