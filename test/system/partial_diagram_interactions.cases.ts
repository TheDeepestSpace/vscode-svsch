// ---------------------------------------------------------------------------
// Registry of "does this interaction still behave the same way inside a
// partial diagram?" cases (issue #408 review thread, option 3). Each entry's
// `title` must match, verbatim, the title of a `@partial-parity`-tagged
// scenario in test/features/diagram_interaction.feature — that tag is the
// single source of truth for *which* interactions need partial-diagram
// coverage, and partial_diagram_interactions.coverage.test.ts (a plain
// vitest test, no VS Code needed) fails loudly if the two ever drift apart
// in either direction. See that file's header comment for the full rundown.
//
// Deliberately a plain data file with no Playwright/vscode-test-playwright
// imports: partial_diagram_interactions.spec.ts turns each entry into a
// `test.fixme(...)`, and the coverage test imports this same array without
// ever loading a Playwright test file as a module (importing one .spec.ts
// from another risks double-registering its tests with the runner).
//
// Generate-region interactions (resizing/moving/overlap-warnings for
// generate arms and blocks) are intentionally NOT tracked here: partial v1
// strips `generateRegions` entirely before a partial diagram is built (see
// stripGenerateRegions in src/layout/partialDiagram.ts), so those 7
// scenarios don't apply yet. Restoring them is filed as a v2 follow-up
// (issue #427) rather than duplicated into this registry ahead of that work.
// ---------------------------------------------------------------------------

export interface PartialInteractionCase {
  /** Must exactly match a `@partial-parity` scenario title in diagram_interaction.feature. */
  title: string;
  /** What to verify, and any partial-diagram-specific wrinkle worth calling out. */
  notes: string;
}

export const PARTIAL_INTERACTION_CASES: PartialInteractionCase[] = [
  {
    title: 'Moving a single block',
    notes: 'Drag a node inside the partial pane; its position updates like on the main diagram.',
  },
  {
    title: 'Resetting the layout',
    notes: 'Move a node, reset the layout, and confirm it returns to its original position.',
  },
  {
    title: "Resetting the layout also resets a resized block's size",
    notes: 'Resize a block in the partial pane, then confirm Reset Layout reverts its size too.',
  },
  {
    title: 'Revert Size resets every resized block in the selection',
    notes:
      'Resize two blocks, multi-select them, and confirm Revert Size reverts both in the pane.',
  },
  {
    title: 'Rerouting a single connection without affecting other routes or positions',
    notes: 'Reroute one connection in the partial pane; confirm an unrelated route/position holds.',
  },
  {
    title: 'Rerouting without moving blocks',
    notes: '"Reroute All" in the partial toolbar changes routes without moving any node.',
  },
  {
    title: 'Auto Layout All re-places every block using current positions as hints',
    notes:
      'Implemented in the spec file (issue #408 follow-up): "Rebuilding a whole FSM..." in ' +
      'partial_diagram.feature only exercises Auto Layout All after every cut net has already ' +
      'been extended, so it never actually covers a cut end surviving the relayout — this case ' +
      'adds two blocks with their ports left out of the partial (so their nets render as cut ' +
      "ends), runs Auto Layout All, and confirms a cut label doesn't land on top of the other " +
      'block, with before/after screenshots.',
  },
  {
    title: 'Resetting the layout reapplies both automatic cut heuristics',
    notes: 'Tie back an auto-cut net, reset the layout, confirm the cut reappears in the pane.',
  },
  {
    title: 'Resizing a <block_kind> block',
    notes: 'Resize a register/instance/stacked-register/stacked-instance block in the pane.',
  },
  {
    title: 'Drag-selecting a connection highlights the wire itself',
    notes: 'Drag-select two connected nodes in the pane; confirm the wire shows as selected.',
  },
  {
    title: "Hovering one wire in a multi-wire selection reveals every selected wire's controls",
    notes: 'With two wires selected in the pane, hovering either reveals both sets of controls.',
  },
  {
    title: 'Rerouting one wire in a multi-wire selection reroutes every selected wire',
    notes: 'Rerouting one wire in a multi-wire selection reroutes every selected wire in the pane.',
  },
  {
    title: 'The Auto Layout control only appears once multiple blocks are selected',
    notes:
      'The partial toolbar mirrors the main one (see partial.steps.ts) — confirm the gating holds.',
  },
  {
    title: 'Expanding an instance in place inlines its child module, and Collapse restores it',
    notes: 'The one case implemented here — see the spec file for the reasoning behind the choice.',
  },
  {
    title: 'The Expand button is not offered for a stacked instance array',
    notes: 'A stacked instance added to the pane still hides the Expand button.',
  },
  {
    title: 'Moving an expanded instance moves its entire spliced content',
    notes:
      'Expand an instance in the pane, move it, and confirm its boundary ports/content move too.',
  },
  {
    title: 'An instance nested inside an already-expanded instance cannot be expanded directly',
    notes: 'Nested-expand gating still holds for an instance only present via the partial pane.',
  },
];

export const PARTIAL_INTERACTION_CASE_TITLES = new Set(
  PARTIAL_INTERACTION_CASES.map((c) => c.title),
);
