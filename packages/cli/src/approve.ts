import { readFileOrNull } from './fsutil.js';
import { sha256 } from './hash.js';
import type { ConceptId } from './ids.js';
import { testPath } from './layout.js';
import type { Manifest } from './manifest.js';

export interface PendingApproval {
  id: ConceptId;
  file: string;
  source: string;
  edited: boolean;
}

export async function pendingApprovals(root: string, manifest: Manifest, only?: ConceptId): Promise<PendingApproval[]> {
  const pending: PendingApproval[] = [];
  for (const [id, entry] of Object.entries(manifest.concepts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if ((only !== undefined && id !== only) || entry.testFileHash === null || entry.approvedTestHash === entry.testFileHash) {
      continue;
    }
    const file = testPath(id);
    const source = (await readFileOrNull(root, file)) ?? '';
    pending.push({ id, file, source, edited: (await sha256(source)) !== entry.testFileHash });
  }
  return pending;
}

// Approval pins the generated test file's hash; a file edited since
// generation is never approved (regenerate it instead).
export function approve(manifest: Manifest, pending: readonly PendingApproval[]): void {
  for (const item of pending) {
    const entry = manifest.concepts[item.id];
    if (entry !== undefined && !item.edited) {
      entry.approvedTestHash = entry.testFileHash;
    }
  }
}
