import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { error, warning, type Diagnostic } from './diagnostics.js';
import { idToPath, isValidSegment, parentOf, pathToId, type ConceptId } from './ids.js';
import { parseConcept, type Concept } from './parse.js';

export interface Project {
  root: string;
  concepts: ReadonlyMap<ConceptId, Concept>;
}

export interface LoadResult {
  project: Project;
  diagnostics: Diagnostic[];
}

interface Candidate {
  id: ConceptId;
  file: string;
  full: string;
}

async function listFiles(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
  } catch {
    return null;
  }
}

export async function loadProject(root: string): Promise<LoadResult> {
  const conceptsDir = path.join(root, 'concepts');
  const files = await listFiles(conceptsDir);
  if (files === null) {
    return { project: { root, concepts: new Map() }, diagnostics: [error('concepts/', `no concepts/ directory in ${root}`)] };
  }
  const diagnostics: Diagnostic[] = [];
  const candidates: Candidate[] = [];
  const knownIds = new Set<ConceptId>();
  for (const rel of files) {
    const segments = rel.split('/');
    if (segments.some((segment) => segment.startsWith('.'))) {
      continue;
    }
    const file = `concepts/${rel}`;
    if (!rel.endsWith('.md')) {
      diagnostics.push(warning(file, 'ignored: not a .md concept file'));
      continue;
    }
    const names = [...segments.slice(0, -1), (segments.at(-1) ?? '').slice(0, -'.md'.length)];
    const bad = names.find((name) => !isValidSegment(name));
    if (bad !== undefined) {
      diagnostics.push(error(file, `invalid name '${bad}': use lowercase kebab-case (e.g. game-store)`));
      continue;
    }
    const id = pathToId(rel);
    knownIds.add(id);
    candidates.push({ id, file, full: path.join(conceptsDir, rel) });
  }
  const texts = await Promise.all(candidates.map((candidate) => readFile(candidate.full, 'utf8')));
  const concepts = new Map<ConceptId, Concept>();
  candidates.forEach((candidate, index) => {
    const result = parseConcept(candidate.id, candidate.file, texts[index] ?? '');
    diagnostics.push(...result.diagnostics);
    if (result.concept !== null) {
      concepts.set(candidate.id, result.concept);
    }
  });
  for (const candidate of candidates) {
    const parent = parentOf(candidate.id);
    if (parent !== null && !knownIds.has(parent)) {
      const parentFile = idToPath(parent);
      diagnostics.push(
        error(candidate.file, `no parent concept: expected concepts/${parentFile}`, {
          hint: `files in concepts/${parentFile.slice(0, -'.md'.length)}/ are contained by concept ${parent}; create its concept file`,
        }),
      );
    }
  }
  return { project: { root, concepts }, diagnostics };
}
