import React from 'react';

export type SelectionAction = 'cut' | 'reroute';

// Edge-drag ('left'/'right'/'top'/'bottom') resizes one axis; corner-drag
// (e.g. 'top-left') resizes both independently, no aspect lock.
export type NodeResizeHandle =
  'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const InteractionContext = React.createContext<{
  hoveredNetKey?: string;
  setHovered: (netKey?: string, immediate?: boolean) => void;
  // The specific edge instance currently hovered (its Reroute/Cut controls are
  // visible), distinct from hoveredNetKey — several edges (a fanout) can share
  // one net key, so only this id unambiguously identifies the r/c shortcut
  // target for a solo (non-multi-selected) hover.
  hoveredEdgeId?: string;
  setHoveredEdgeId: React.Dispatch<React.SetStateAction<string | undefined>>;
  // Set while the pointer is over a selected wire's hover zone, so every other
  // selected wire can reveal its own Cut/Reroute controls too (multi-select
  // batch actions) instead of only the one actually under the cursor.
  selectionHoverActive: boolean;
  setSelectionHoverActive: (active: boolean) => void;
  // Which control is currently hovered within the (possibly multi-wire) controls
  // popup, so every selected wire can preview the pending batch action.
  pendingSelectionAction?: SelectionAction;
  setPendingSelectionAction: (action?: SelectionAction) => void;
  // Portal target for floating controls (selection toolbar, cut-stub Reroute)
  // that must paint above node bodies. Kept outside react-flow's own
  // ViewportPortal so the generate-region overlay — which shares that portal
  // and must stay beneath nodes — isn't forced into the same stacking tier.
  // See NodeSelectionToolbar for the full rationale.
  overlayPortalNode: HTMLDivElement | null;
  // Starts a grow-only block resize drag (instance/register nodes), mirroring
  // GenerateRegionOverlay's pointer-drag pattern one level up in main.tsx —
  // HdlNode only renders the handle hit-zones, the drag state machine lives
  // in DiagramApp alongside the node/region state it has to update together.
  startNodeResize: (event: React.PointerEvent, nodeId: string, handle: NodeResizeHandle) => void;
  // True when this document is an ephemeral "SVSCH Partial Diagram" pane
  // (issue #403) rather than the main diagram — set from the `partial` flag
  // on the host's `graph` message. Gates which affordances render: the
  // partial swaps a cut end's Tie/Revert controls for the "extend" arrow,
  // and hides actions its host deliberately ignores (net cuts, renames).
  partialDiagram: boolean;
}>({
  setHovered: () => {},
  setHoveredEdgeId: () => {},
  selectionHoverActive: false,
  setSelectionHoverActive: () => {},
  setPendingSelectionAction: () => {},
  overlayPortalNode: null,
  startNodeResize: () => {},
  partialDiagram: false,
});
