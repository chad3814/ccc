import type { KeptTest } from './approve.js';
import { dependenciesOf } from './graph.js';
import { parseActionRef, type ConceptId } from './ids.js';
import { PACKAGES_BY_KIND, transitiveDependencies } from './imports.js';
import { interfaceTextOf, type ExportsByConcept } from './keys.js';
import { modulePath, ownModuleSpecifier, relativeImport, testPath } from './layout.js';
import type { Project } from './load.js';
import type { Concept } from './parse.js';
import { isAdapterKind } from './schema.js';
import { primaryClassName } from './syncs.js';

export interface DependencyView {
  id: ConceptId;
  specifier: string;
  declarations: string;
}

export function dependencyViews(
  concept: Concept,
  project: Project,
  exportsByConcept: ExportsByConcept,
  ids?: readonly ConceptId[],
): DependencyView[] {
  return (ids ?? dependenciesOf(concept, project)).flatMap((id) => {
    const dep = project.concepts.get(id);
    return dep === undefined
      ? []
      : [{ id, specifier: relativeImport(concept.id, id), declarations: interfaceTextOf(dep, exportsByConcept).trim() }];
  });
}

function fence(code: string): string {
  return ['```ts', code.trimEnd(), '```'].join('\n');
}

function dependencySection(views: readonly DependencyView[]): string[] {
  if (views.length === 0) {
    return ['## Dependencies', 'None.'];
  }
  return [
    '## Dependencies you may import',
    ...views.flatMap((view) => ['', `### ${view.id}: import from '${view.specifier}'`, fence(view.declarations)]),
  ];
}

function usesAdapters(concept: Concept, project: Project): boolean {
  return (
    isAdapterKind(concept.frontmatter.kind) ||
    transitiveDependencies(concept, project).some((id) => {
      const kind = project.concepts.get(id)?.frontmatter.kind;
      return kind !== undefined && isAdapterKind(kind);
    })
  );
}

function testSupportSection(concept: Concept, project: Project): string[] {
  if (!usesAdapters(concept, project)) {
    return [];
  }
  const lines = [
    '## Test support',
    `Create a database with \`pgliteDatabase()\` from '@ccc/runtime/pglite', then run \`await db.exec(schemaSql)\` with \`schemaSql\` from '${relativeImport(concept.id, 'schema')}'.`,
  ];
  if (concept.frontmatter.kind === 'endpoint') {
    lines.push(
      `Build the app with \`const app = await createApp(db, { endpoints: ['${concept.id}'] })\` from '${relativeImport(concept.id, 'server')}' and send requests with \`await app(new Request('http://test/<path>', { method, headers, body }))\`.`,
      "Loading the app activates sync wiring: call a sync's trigger methods only inside `withScope({ '<concept id>': instance }, async () => { ... })` from '@ccc/runtime', or set up state through HTTP requests.",
    );
  }
  return [...lines, ''];
}

function syncsSection(concept: Concept, project: Project, exportsByConcept: ExportsByConcept): string[] {
  if (concept.frontmatter.kind !== 'endpoint') {
    return [];
  }
  const reachable = new Set(transitiveDependencies(concept, project));
  const lines: string[] = [];
  for (const sync of [...project.concepts.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const fm = sync.frontmatter;
    if (fm.kind !== 'sync' || !reachable.has(parseActionRef(fm.when).conceptId)) {
      continue;
    }
    const scoped = [...new Set(fm.then.map((ref) => parseActionRef(ref).conceptId))].filter((id) => {
      const target = project.concepts.get(id);
      const info = exportsByConcept.get(id);
      return target !== undefined && !isAdapterKind(target.frontmatter.kind) && info?.classMethods.has(primaryClassName(id)) === true;
    });
    lines.push(`- ${sync.id}: after ${fm.when}; bind in scope: ${scoped.length === 0 ? 'nothing' : scoped.join(', ')}`);
  }
  return lines.length === 0 ? [] : ['## Syncs that may fire', ...lines, ''];
}

// The test writer sees the whole concept (the same specification the
// implementer gets), but never an implementation (spec §4.4).
// The approved test file, when regenerating over one, and which of its
// tests still match an unchanged example.
export interface PreviousTests {
  source: string;
  kept: readonly KeptTest[];
}

function approvedTestsSection(concept: Concept, previous: PreviousTests): string[] {
  const keptExamples = new Set(previous.kept.map((k) => k.example));
  const others = concept.examples.map((_, index) => index + 1).filter((n) => !keptExamples.has(n));
  const plan =
    previous.kept.length === 0
      ? ['- Reuse the test for every example that is unchanged, exactly as written.']
      : [
          `- Copy these tests exactly, changing only their tags: ${previous.kept.map((k) => `[ex ${k.example}] (was [ex ${k.was}])`).join(', ')}.`,
          ...(others.length === 0 ? [] : [`- Write the other tests new: ${others.map((n) => `[ex ${n}]`).join(', ')}.`]),
        ];
  return [
    '## Approved tests',
    'A person reviewed and approved the current test file for this concept (below). Keep what they approved:',
    ...plan,
    '- Keep the shared setup (imports, helpers) unless a new test needs something different.',
    'If a change to the Rules means a kept test no longer holds, change that test; it will be reviewed again.',
    fence(previous.source),
    '',
  ];
}

export function testRequest(
  concept: Concept,
  project: Project,
  exportsByConcept: ExportsByConcept,
  testDependencies: readonly ConceptId[],
  previous?: PreviousTests,
): string {
  return [
    `Write the Vitest test file for concept \`${concept.id}\` (${concept.frontmatter.kind}).`,
    '',
    `Test file: ${testPath(concept.id)}`,
    `Import the module under test from '${ownModuleSpecifier(concept.id)}'.`,
    'Vitest globals (describe, it, expect, vi) are available; do not import vitest.',
    '',
    '## Interface of the module under test',
    fence(interfaceTextOf(concept, exportsByConcept)),
    '',
    '## Intent',
    concept.sections.get('Intent')?.body ?? '',
    ...['Rules', 'Decisions', 'Schema'].flatMap((name) => {
      const section = concept.sections.get(name);
      return section === undefined ? [] : ['', `## ${name}`, section.body];
    }),
    '',
    '## Examples',
    'Write exactly one test per example. Start each test name with its tag.',
    'Use the rest of the concept (Rules, Decisions, Schema) as context for setting up and checking each example, but assert only what the example states.',
    ...concept.examples.map((example, index) => `[ex ${index + 1}] ${example}`),
    '',
    ...(previous === undefined ? [] : approvedTestsSection(concept, previous)),
    ...testSupportSection(concept, project),
    ...dependencySection(dependencyViews(concept, project, exportsByConcept, testDependencies)),
    '',
  ].join('\n');
}

export function implRequest(concept: Concept, project: Project, exportsByConcept: ExportsByConcept, testSource: string): string {
  const sections = ['Intent', 'Rules', 'Examples', 'Decisions', 'Schema'].flatMap((name) => {
    const section = concept.sections.get(name);
    return section === undefined ? [] : ['', `## ${name}`, section.body];
  });
  return [
    `Write the implementation module for concept \`${concept.id}\` (${concept.frontmatter.kind}).`,
    '',
    `Module: ${modulePath(concept.id)}`,
    'Export exactly the declarations in the interface below: no more, no fewer.',
    `Allowed packages: ${PACKAGES_BY_KIND[concept.frontmatter.kind].join(', ')}.`,
    '',
    '## Interface',
    fence(interfaceTextOf(concept, exportsByConcept)),
    ...sections,
    '',
    ...syncsSection(concept, project, exportsByConcept),
    ...dependencySection(dependencyViews(concept, project, exportsByConcept)),
    '',
    `## Tests your module must pass (${testPath(concept.id)})`,
    fence(testSource),
    '',
  ].join('\n');
}

export const MAX_FEEDBACK_PROBLEMS = 50;

export function feedbackMessage(problems: readonly string[]): string {
  const shown = problems
    .slice(0, MAX_FEEDBACK_PROBLEMS)
    .map((problem) => `- ${problem.length > 2000 ? `${problem.slice(0, 2000)}…` : problem}`);
  const more = problems.length > MAX_FEEDBACK_PROBLEMS ? [`- …and ${problems.length - MAX_FEEDBACK_PROBLEMS} more`] : [];
  return [
    'Your module failed these checks. Fix every problem and call write_module again with the complete file.',
    '',
    ...shown,
    ...more,
  ].join('\n');
}
