import { describe, expect, it } from 'vitest';
import { AnthropicGenerator } from '../src/anthropic.js';
import { runBuild } from '../src/build.js';
import { readFileOrNull } from '../src/fsutil.js';
import { writeProject } from '../test/helpers.js';
import { PIPELINE_FILES } from '../test/pipeline-fixture.js';

// Spends real money: builds the card concept with Claude. Run only with
// `pnpm --filter @chchco/cli test:live`, credentials supplied by the SDK
// (ANTHROPIC_API_KEY, e.g. via `op run`, or an `ant auth login` profile).
describe('live build', () => {
  it('builds a real concept with Claude', async () => {
    const root = await writeProject({
      'package.json': PIPELINE_FILES['package.json'] ?? '',
      'concepts/card.md': PIPELINE_FILES['concepts/card.md'] ?? '',
    });
    const result = await runBuild({ root, generator: new AnthropicGenerator(), log: (line) => console.log(line) });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(await readFileOrNull(root, '.ccc/gen/card.ts')).toContain('export function card');
  });
});
