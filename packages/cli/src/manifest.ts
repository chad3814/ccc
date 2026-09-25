import { z } from 'zod';
import { error, type Diagnostic } from './diagnostics.js';
import { fileHash, listFilesUnder, readFileOrNull, writeFileAtomic } from './fsutil.js';
import { stableStringify } from './hash.js';
import type { ConceptId } from './ids.js';
import { CONFORMANCE_DIR, GEN_DIR, INTERFACES_DIR, MANIFEST_FILE } from './layout.js';

const generationSchema = z.strictObject({
  artifact: z.enum(['tests', 'impl']),
  at: z.string(),
  model: z.string(),
  attempts: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().nullable(),
  durationMs: z.number(),
  outcome: z.enum(['passed', 'failed']),
  // Ladder steps climbed; records written before escalation existed have none.
  escalations: z.number().int().default(0),
});

const entrySchema = z.strictObject({
  testKey: z.string().nullable(),
  testFileHash: z.string().nullable(),
  approvedTestHash: z.string().nullable(),
  implKey: z.string().nullable(),
  history: z.array(generationSchema),
});

export const manifestSchema = z.strictObject({
  version: z.literal(1),
  concepts: z.record(z.string(), entrySchema),
  files: z.record(z.string(), z.string()),
});

export type Generation = z.output<typeof generationSchema>;
export type ManifestEntry = z.output<typeof entrySchema>;
export type Manifest = z.output<typeof manifestSchema>;

const manifestJson = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not valid JSON' });
      return z.NEVER;
    }
  })
  .pipe(manifestSchema);

export function emptyManifest(): Manifest {
  return { version: 1, concepts: {}, files: {} };
}

export function entryFor(manifest: Manifest, id: ConceptId): ManifestEntry {
  const existing = manifest.concepts[id];
  if (existing !== undefined) {
    return existing;
  }
  const created: ManifestEntry = { testKey: null, testFileHash: null, approvedTestHash: null, implKey: null, history: [] };
  manifest.concepts[id] = created;
  return created;
}

export async function readManifest(root: string): Promise<{ manifest: Manifest; diagnostics: Diagnostic[] }> {
  const text = await readFileOrNull(root, MANIFEST_FILE);
  if (text === null) {
    return { manifest: emptyManifest(), diagnostics: [] };
  }
  const parsed = manifestJson.safeParse(text);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'unknown problem';
    return {
      manifest: emptyManifest(),
      diagnostics: [
        error(MANIFEST_FILE, `invalid manifest: ${message}`, {
          hint: 'restore it from git, or delete it to rebuild everything',
        }),
      ],
    };
  }
  return { manifest: parsed.data, diagnostics: [] };
}

export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const sorted = JSON.parse(stableStringify(manifest));
  await writeFileAtomic(root, MANIFEST_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

export async function listCccFiles(root: string): Promise<string[]> {
  const trees = await Promise.all([GEN_DIR, INTERFACES_DIR, CONFORMANCE_DIR].map((dir) => listFilesUnder(root, dir)));
  const extras = await Promise.all(
    ['.ccc/package.json', '.ccc/.gitignore'].map(async (file) => ((await readFileOrNull(root, file)) === null ? null : file)),
  );
  return [...trees.flat(), ...extras.filter((file): file is string => file !== null)].sort();
}

export async function hashFiles(root: string, files: readonly string[]): Promise<Record<string, string>> {
  const hashes = await Promise.all(files.map(async (file) => [file, await fileHash(root, file)] as const));
  const result: Record<string, string> = {};
  for (const [file, hash] of hashes) {
    if (hash !== null) {
      result[file] = hash;
    }
  }
  return result;
}
