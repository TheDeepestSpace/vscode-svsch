import { describe, it, expect } from 'vitest';
import path from 'path';
import { scenarioTitlesWithTag } from './support/partialParityTags';
import { PARTIAL_INTERACTION_CASE_TITLES } from './partial_diagram_interactions.cases';

// ---------------------------------------------------------------------------
// Guards the manifest in partial_diagram_interactions.spec.ts against drift
// from test/features/diagram_interaction.feature: every scenario tagged
// `@partial-parity` there is expected to have a matching case here, and every
// case here is expected to still be tagged. This is the automated version of
// the "easy to miss adding the corresponding case down the road" concern
// raised on issue #408 — instead of relying on someone remembering to look,
// this fails a plain `npm test` run (no VS Code/Playwright needed) the
// moment the two lists disagree.
// ---------------------------------------------------------------------------

const FEATURE_PATH = path.resolve(__dirname, '../features/diagram_interaction.feature');
const PARTIAL_PARITY_TAG = '@partial-parity';

describe('partial diagram interaction parity coverage', () => {
  const taggedTitles = scenarioTitlesWithTag(FEATURE_PATH, PARTIAL_PARITY_TAG);

  it(`finds at least one ${PARTIAL_PARITY_TAG} scenario to track`, () => {
    expect(taggedTitles.length).toBeGreaterThan(0);
  });

  it('has a partial-context case for every @partial-parity scenario', () => {
    const missing = taggedTitles.filter((title) => !PARTIAL_INTERACTION_CASE_TITLES.has(title));
    expect(
      missing,
      missing.length === 0
        ? undefined
        : `diagram_interaction.feature tags these scenarios ${PARTIAL_PARITY_TAG}, but ` +
            `PARTIAL_INTERACTION_CASES (test/system/partial_diagram_interactions.cases.ts) has no ` +
            `matching entry for:\n  - ${missing.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('has no stale case for a scenario that is no longer tagged @partial-parity', () => {
    const taggedSet = new Set(taggedTitles);
    const stale = [...PARTIAL_INTERACTION_CASE_TITLES].filter((title) => !taggedSet.has(title));
    expect(
      stale,
      stale.length === 0
        ? undefined
        : `PARTIAL_INTERACTION_CASES has entries with no matching ${PARTIAL_PARITY_TAG} scenario in ` +
            `diagram_interaction.feature (renamed scenario, or the tag was removed?):\n  - ${stale.join('\n  - ')}`,
    ).toEqual([]);
  });
});
