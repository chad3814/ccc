import type { Concept } from './parse.js';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => compareKeys(a, b)))
      : inner,
  );
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(digest).toString('hex');
}

// Canonical form for cache keys: formatting-only edits (key order, section
// order, trailing whitespace, line endings) don't change it.
export function normalizeConcept(concept: Concept): string {
  const frontmatter: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(concept.frontmatter)) {
    if (value !== undefined) {
      frontmatter[key] = value;
    }
  }
  const sections = [...concept.sections.values()]
    .map((section): [string, string] => [section.heading, section.lines.map((line) => line.trimEnd()).join('\n').trim()])
    .sort(([a], [b]) => compareKeys(a, b));
  return stableStringify({ id: concept.id, frontmatter, sections });
}
