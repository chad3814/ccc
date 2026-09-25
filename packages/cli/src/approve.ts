import { readFileOrNull } from './fsutil.js';
import { sha256 } from './hash.js';
import type { ConceptId } from './ids.js';
import { testPath } from './layout.js';
import { loadProject } from './load.js';
import type { Manifest } from './manifest.js';
import { sharedCode, testCases, type TestCase } from './testsummary.js';

export interface PendingApproval {
  id: ConceptId;
  file: string;
  source: string;
  edited: boolean;
  // The concept's examples, or null when the concept no longer exists.
  examples: readonly string[] | null;
  // What the previous approval recorded per test ({} if none).
  approved: Readonly<Record<string, string>>;
}

export type ReviewStatus = 'unchanged' | 'changed' | 'new';

export interface ReviewedTest {
  example: number;
  text: string;
  // unchanged: same example and same code as when approved; changed: same
  // example, different code; new: an example that was never approved.
  status: ReviewStatus;
  test: TestCase | null;
}

// Whitespace inside an example doesn't change what it says.
async function exampleHash(text: string): Promise<string> {
  return sha256(text.replace(/\s+/g, ' ').trim());
}

// What an approval records per test: example text hash → test code hash.
// Keyed by text, not number, so inserting a bullet doesn't unapprove the
// tests after it.
// The shared code outside the tests is recorded under SHARED_KEY, which
// can't collide with a hex hash.
const SHARED_KEY = 'shared';

export async function approvedTestsOf(examples: readonly string[], source: string): Promise<Record<string, string>> {
  const approved: Record<string, string> = { [SHARED_KEY]: await sha256(sharedCode(source)) };
  for (const test of testCases(source)) {
    const text = examples[test.example - 1];
    if (text !== undefined) {
      approved[await exampleHash(text)] = await sha256(test.code);
    }
  }
  return approved;
}

export async function reviewTests(
  examples: readonly string[],
  source: string,
  approved: Readonly<Record<string, string>>,
): Promise<ReviewedTest[]> {
  const byExample = new Map(testCases(source).map((test) => [test.example, test]));
  return Promise.all(
    examples.map(async (text, index): Promise<ReviewedTest> => {
      const example = index + 1;
      const test = byExample.get(example) ?? null;
      const approvedCode = approved[await exampleHash(text)];
      let status: ReviewStatus = 'new';
      if (approvedCode !== undefined && test !== null) {
        status = approvedCode === (await sha256(test.code)) ? 'unchanged' : 'changed';
      }
      return { example, text, status, test };
    }),
  );
}

export interface KeptTest {
  example: number;
  // The test's tag in the approved file.
  was: number;
}

// Which examples still have their approved test in `source` (the approved
// file), and under which tag, so regeneration can keep those tests.
export async function keptTests(
  examples: readonly string[],
  source: string,
  approved: Readonly<Record<string, string>>,
): Promise<KeptTest[]> {
  const tagByCode = new Map<string, number>();
  for (const test of testCases(source)) {
    tagByCode.set(await sha256(test.code), test.example);
  }
  const kept: KeptTest[] = [];
  for (const [index, text] of examples.entries()) {
    const code = approved[await exampleHash(text)];
    const was = code === undefined ? undefined : tagByCode.get(code);
    if (was !== undefined) {
      kept.push({ example: index + 1, was });
    }
  }
  return kept;
}

// True when an approval recorded the shared code and it has changed since.
export async function sharedCodeChanged(source: string, approved: Readonly<Record<string, string>>): Promise<boolean> {
  const recorded = approved[SHARED_KEY];
  return recorded !== undefined && recorded !== (await sha256(sharedCode(source)));
}

export async function pendingApprovals(root: string, manifest: Manifest, only?: ConceptId): Promise<PendingApproval[]> {
  const { project } = await loadProject(root);
  const pending: PendingApproval[] = [];
  for (const [id, entry] of Object.entries(manifest.concepts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if ((only !== undefined && id !== only) || entry.testFileHash === null || entry.approvedTestHash === entry.testFileHash) {
      continue;
    }
    const file = testPath(id);
    const source = (await readFileOrNull(root, file)) ?? '';
    pending.push({
      id,
      file,
      source,
      edited: (await sha256(source)) !== entry.testFileHash,
      examples: project.concepts.get(id)?.examples ?? null,
      approved: entry.approvedTests,
    });
  }
  return pending;
}

// Approval pins the generated test file's hash and records each test
// against its example; a file edited since generation is never approved
// (regenerate it instead).
export async function approve(manifest: Manifest, pending: readonly PendingApproval[]): Promise<void> {
  for (const item of pending) {
    const entry = manifest.concepts[item.id];
    if (entry !== undefined && !item.edited) {
      entry.approvedTestHash = entry.testFileHash;
      entry.approvedTests = item.examples === null ? {} : await approvedTestsOf(item.examples, item.source);
    }
  }
}
