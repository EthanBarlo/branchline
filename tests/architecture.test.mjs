import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();

for (const [name, filePath, source] of [
  ['renderer cannot import Node', 'src/features/reviews/BoundaryProbe.ts', "import { readFile } from 'node:fs/promises';"],
  ['renderer cannot import desktop services', 'src/features/reviews/BoundaryProbe.ts', "import { ReviewService } from '../../../electron/reviews/review-service';"],
  ['shared UI cannot import features', 'src/ui/BoundaryProbe.tsx', "import { SettingsView } from '../features/settings/SettingsView';"],
  ['shared contracts cannot import renderer modules', 'shared/BoundaryProbe.ts', "import { router } from '../src/router';"],
  ['shared contracts cannot access browser globals', 'shared/BoundaryProbe.ts', 'export const currentURL = window.location.href;'],
  ['desktop cannot import renderer modules', 'electron/application/BoundaryProbe.ts', "import { applyTheme } from '../../src/theme/theme';"],
]) {
  test(name, async () => {
    const [result] = await eslint.lintText(source, { filePath });
    assert.ok(result.messages.some((message) => message.ruleId?.startsWith('no-restricted-')), JSON.stringify(result.messages));
  });
}

test('features can use shared contracts, UI, and theme modules', async () => {
  const [result] = await eslint.lintText(
    "import type { Review } from '../../../shared/types';\nimport { Button } from '../../ui/Button';\nimport { colors } from '../../theme/tokens.stylex';",
    { filePath: 'src/features/reviews/BoundaryProbe.tsx' },
  );
  assert.deepEqual(result.messages, []);
});
