import ts from '@typescript/typescript6';

// One `[ex N]` test, reduced to what a reviewer needs: the claims it makes
// (its expect statements) and a formatting-independent form of its code.
export interface TestCase {
  example: number;
  // Each expect statement on one line; empty when the test asserts some
  // other way (a helper, a thrown error), in which case review shows `body`.
  assertions: string[];
  body: string;
  // The test function printed without comments or formatting, and without
  // its title, so a reworded title or reflowed code compares equal.
  code: string;
}

const TAG = /^\[ex (\d+)\]/;
const TEST_FUNCTIONS = new Set(['it', 'test']);
// Bookkeeping calls on expect itself, not claims about behavior.
const EXPECT_BOOKKEEPING = new Set(['assertions', 'hasAssertions']);

const printer = ts.createPrinter({ removeComments: true });

function isTestCall(call: ts.CallExpression): boolean {
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : call.expression;
  return ts.isIdentifier(callee) && TEST_FUNCTIONS.has(callee.text);
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
// trailing commas that line breaks introduced inside parentheses.
function oneLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
    .replace(/\(\s+/g, '(')
    .replace(/,?\s+\)/g, ')');
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
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const example = tagOf(node);
      const fn = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (example !== null && fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        cases.push({
          example,
          assertions: assertionsIn(fn, file),
          body: bodyText(fn, file),
          code: printer.printNode(ts.EmitHint.Unspecified, fn, file),
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return cases;
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
