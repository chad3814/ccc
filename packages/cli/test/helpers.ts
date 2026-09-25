import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasErrors, formatDiagnostic } from '../src/diagnostics.js';
import { pathToId } from '../src/ids.js';
import type { Project } from '../src/load.js';
import { parseConcept, type Concept } from '../src/parse.js';

export const DEFAULT_BODY = '## Intent\nTest concept.\n\n## Examples\n- example one\n';

export function concept(frontmatter: string, body: string = DEFAULT_BODY): string {
  return `---\n${frontmatter.trim()}\n---\n${body}`;
}

export async function writeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ccc-test-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  return root;
}

export function projectFrom(files: Record<string, string>): Project {
  const concepts = new Map<string, Concept>();
  for (const [rel, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const id = pathToId(rel);
    const result = parseConcept(id, `concepts/${rel}`, text);
    if (result.concept === null || hasErrors(result.diagnostics)) {
      throw new Error(`fixture ${rel} failed to parse:\n${result.diagnostics.map(formatDiagnostic).join('\n')}`);
    }
    concepts.set(id, result.concept);
  }
  return { root: '/virtual', concepts };
}

const requireFromTests = createRequire(import.meta.url);

// Generated code in temp projects imports packages (the runtime, hono, zod);
// link the CLI's installed copies instead of installing.
export async function linkPackages(root: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const target = path.dirname(requireFromTests.resolve(`${name}/package.json`));
    const link = path.join(root, 'node_modules', name);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, 'dir');
  }
}
