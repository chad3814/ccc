export type ConceptId = string;

const SEGMENT_SOURCE = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const ID_SOURCE = `${SEGMENT_SOURCE}(?:\\.${SEGMENT_SOURCE})*`;
const SEGMENT = new RegExp(`^${SEGMENT_SOURCE}$`);

export const ID_PATTERN = new RegExp(`^${ID_SOURCE}$`);
export const ACTION_PATTERN = new RegExp(`^${ID_SOURCE}#[A-Za-z_$][A-Za-z0-9_$]*$`);

export function isValidSegment(segment: string): boolean {
  return SEGMENT.test(segment);
}

export function pathToId(relPath: string): ConceptId {
  if (!relPath.endsWith('.md')) {
    throw new Error(`not a concept file: ${relPath}`);
  }
  return relPath.slice(0, -'.md'.length).split('/').join('.');
}

export function idToPath(id: ConceptId): string {
  return `${id.split('.').join('/')}.md`;
}

export function parentOf(id: ConceptId): ConceptId | null {
  const index = id.lastIndexOf('.');
  return index === -1 ? null : id.slice(0, index);
}

export function ancestorsOf(id: ConceptId): ConceptId[] {
  const ancestors: ConceptId[] = [];
  let current = parentOf(id);
  while (current !== null) {
    ancestors.push(current);
    current = parentOf(current);
  }
  return ancestors;
}

// Lexical visibility (spec §2.4): ancestors, own children, siblings, and
// siblings of ancestors. Equivalently: the target is an ancestor, or the
// target's parent is `from`, one of `from`'s ancestors, or the root.
export function isVisible(from: ConceptId, target: ConceptId): boolean {
  if (from === target) {
    return false;
  }
  const ancestors = ancestorsOf(from);
  if (ancestors.includes(target)) {
    return true;
  }
  const targetParent = parentOf(target);
  return targetParent === null || targetParent === from || ancestors.includes(targetParent);
}

export function parseActionRef(ref: string): { conceptId: ConceptId; member: string } {
  const index = ref.indexOf('#');
  return { conceptId: ref.slice(0, index), member: ref.slice(index + 1) };
}
