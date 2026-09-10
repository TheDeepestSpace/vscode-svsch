import { buildFixtureView, type VisualLayoutMode } from './helper';
import { elkNodeForDiagramNode, elkRoutingNodeForDiagramNode } from '../../src/layout/mergeLayout';
import { visualHandleGeometry } from '../../src/diagram/visualHandleGeometry';
import { diagramNodeDimensions } from '../../src/diagram/nodeSizing';
import { nodeIsArrayNode, structRole } from '../../src/ir/nodeMetadata';
import type { DiagramNode, DiagramViewModel, PositionedNode } from '../../src/ir/types';

// Shared "one node of every diagram kind" grid, used by both the ELK geometry
// overlay test and the selection-styles grid test.

export const GRID = 24;
export const COLUMNS = 5;
export const COLUMN_GAP = GRID * 3;
export const ROW_GAP = GRID * 4;

export interface NodePick {
  label: string;
  match: (node: DiagramNode) => boolean;
}

export interface FixtureSelection {
  fixture: string;
  module?: string;
  layoutMode?: VisualLayoutMode;
  picks: NodePick[];
}

export const selections: FixtureSelection[] = [
  {
    fixture: 'register_async_reset.sv',
    picks: [
      {
        label: 'port: input',
        match: (n) => n.kind === 'port' && n.ports[0]?.direction === 'input',
      },
      {
        label: 'port: output',
        match: (n) => n.kind === 'port' && n.ports[0]?.direction === 'output',
      },
      { label: 'register: async reset', match: (n) => n.kind === 'register' },
    ],
  },
  {
    fixture: 'register_file.sv',
    picks: [
      { label: 'port: wide input', match: (n) => n.kind === 'port' && n.label === 'addr' },
      {
        label: 'register: stacked (wide)',
        match: (n) => n.kind === 'register' && nodeIsArrayNode(n),
      },
    ],
  },
  {
    fixture: 'array_port_register.sv',
    picks: [
      {
        label: 'port: stacked input (wide)',
        match: (n) => n.kind === 'port' && nodeIsArrayNode(n) && n.ports[0]?.direction === 'input',
      },
      {
        label: 'port: stacked output (wide)',
        match: (n) => n.kind === 'port' && nodeIsArrayNode(n) && n.ports[0]?.direction === 'output',
      },
    ],
  },
  {
    fixture: 'array_port_register_bit.sv',
    picks: [
      {
        label: 'port: stacked input (1-bit)',
        match: (n) => n.kind === 'port' && nodeIsArrayNode(n) && n.ports[0]?.direction === 'input',
      },
      {
        label: 'port: stacked output (1-bit)',
        match: (n) => n.kind === 'port' && nodeIsArrayNode(n) && n.ports[0]?.direction === 'output',
      },
      {
        label: 'register: stacked (1-bit)',
        match: (n) => n.kind === 'register' && nodeIsArrayNode(n),
      },
    ],
  },
  { fixture: 'mux_three_inputs.sv', picks: [{ label: 'mux', match: (n) => n.kind === 'mux' }] },
  {
    fixture: 'array_register.sv',
    picks: [
      {
        label: 'mux: stacked write address',
        match: (n) => n.kind === 'mux' && nodeIsArrayNode(n) && n.label === 'write address',
      },
      {
        label: 'mux: stacked write enable',
        match: (n) => n.kind === 'mux' && nodeIsArrayNode(n) && n.label === 'if write_en',
      },
    ],
  },
  { fixture: 'alu_connected.sv', picks: [{ label: 'alu', match: (n) => n.kind === 'alu' }] },
  {
    fixture: 'inverter_expr.sv',
    picks: [{ label: 'inverter', match: (n) => n.kind === 'inverter' }],
  },
  {
    fixture: 'comb_assigns.sv',
    module: 'assign_generic',
    picks: [{ label: 'comb', match: (n) => n.kind === 'comb' }],
  },
  {
    fixture: 'comb_assigns.sv',
    module: 'assign_and',
    picks: [{ label: 'gate: and', match: (n) => n.kind === 'gate' }],
  },
  {
    fixture: 'comb_assigns.sv',
    module: 'assign_or',
    picks: [{ label: 'gate: or', match: (n) => n.kind === 'gate' }],
  },
  {
    fixture: 'comb_assigns.sv',
    module: 'assign_xor',
    picks: [{ label: 'gate: xor', match: (n) => n.kind === 'gate' }],
  },
  {
    fixture: 'comb_assigns.sv',
    module: 'assign_nand',
    picks: [{ label: 'gate: nand', match: (n) => n.kind === 'gate' }],
  },
  {
    fixture: 'comb_assigns.sv',
    module: 'assign_nor',
    picks: [{ label: 'gate: nor', match: (n) => n.kind === 'gate' }],
  },
  {
    fixture: 'comb_assigns.sv',
    module: 'assign_xnor',
    picks: [{ label: 'gate: xnor', match: (n) => n.kind === 'gate' }],
  },
  {
    fixture: 'alu_case_arms.sv',
    picks: [
      { label: 'comparator', match: (n) => n.kind === 'comparator' },
      { label: 'zext', match: (n) => n.kind === 'zext' },
    ],
  },
  { fixture: 'var_bit_select.sv', picks: [{ label: 'select', match: (n) => n.kind === 'select' }] },
  {
    fixture: 'bus_two_taps.sv',
    picks: [{ label: 'bus: breakout', match: (n) => n.kind === 'bus' }],
  },
  {
    fixture: 'bus_composition.sv',
    picks: [{ label: 'bus: composition', match: (n) => n.kind === 'bus' }],
  },
  {
    fixture: 'array_stack_breakout.sv',
    picks: [
      { label: 'bus: stacked breakout', match: (n) => n.kind === 'bus' && nodeIsArrayNode(n) },
    ],
  },
  {
    fixture: 'array_stack_composition_elements.sv',
    picks: [
      { label: 'bus: stacked composition', match: (n) => n.kind === 'bus' && nodeIsArrayNode(n) },
    ],
  },
  {
    fixture: 'array_stack_composition_literal.sv',
    picks: [{ label: 'literal', match: (n) => n.kind === 'literal' }],
  },
  {
    fixture: 'struct_breakout.sv',
    picks: [{ label: 'struct: breakout', match: (n) => n.kind === 'struct' }],
  },
  {
    fixture: 'struct_composition.sv',
    picks: [{ label: 'struct: composition', match: (n) => n.kind === 'struct' }],
  },
  {
    fixture: 'interface_modport.sv',
    picks: [{ label: 'interface: instance', match: (n) => n.kind === 'interface' }],
  },
  {
    fixture: 'interface_modport.sv',
    module: 'consumer',
    picks: [
      {
        label: 'interface: modport',
        match: (n) => n.kind === 'interface' && structRole(n) === 'modport',
      },
    ],
  },
  {
    fixture: 'interface_modport_arrangements.sv',
    module: 'interface_all_left_modports',
    picks: [
      {
        label: 'interface: modports one side',
        match: (n) => n.kind === 'interface' && structRole(n) !== 'modport',
      },
    ],
  },
  {
    fixture: 'interface_modport_arrangements.sv',
    module: 'interface_uneven_modport',
    picks: [
      {
        label: 'interface: uneven modports',
        match: (n) => n.kind === 'interface' && structRole(n) !== 'modport',
      },
    ],
  },
  {
    fixture: 'interface_multi_modport.sv',
    picks: [
      {
        label: 'interface: multi modport + clk/rst',
        match: (n) => n.kind === 'interface' && structRole(n) !== 'modport',
      },
    ],
  },
  {
    fixture: 'interface_caps_only.sv',
    picks: [
      {
        label: 'interface: scalar caps only',
        match: (n) => n.kind === 'interface' && structRole(n) !== 'modport',
      },
    ],
  },
  {
    fixture: 'typed_instance_ports.sv',
    picks: [{ label: 'instance', match: (n) => n.kind === 'instance' }],
  },
  {
    fixture: 'instance_array.sv',
    picks: [
      { label: 'instance: stacked', match: (n) => n.kind === 'instance' && nodeIsArrayNode(n) },
    ],
  },
  {
    fixture: 'function_call.sv',
    picks: [{ label: 'funcCall', match: (n) => n.kind === 'funcCall' }],
  },
  {
    fixture: 'task_call.sv',
    picks: [{ label: 'taskCall', match: (n) => n.kind === 'taskCall' }],
  },
  {
    fixture: 'unknown.sv',
    picks: [{ label: 'unknown', match: (n) => n.kind === 'unknown' }],
  },
  {
    fixture: 'replication_expr.sv',
    picks: [{ label: 'replicate', match: (n) => n.kind === 'replicate' }],
  },
  { fixture: 'loop_logic.sv', picks: [{ label: 'loop', match: (n) => n.kind === 'loop' }] },
  { fixture: 'latch_simple.sv', picks: [{ label: 'latch', match: (n) => n.kind === 'latch' }] },
  {
    fixture: 'cut_net_simple.sv',
    layoutMode: 'cutNet',
    picks: [
      {
        label: 'netLabel: cut source end',
        match: (n) => n.kind === 'netLabel' && n.metadata?.cutNet?.role === 'source',
      },
      {
        label: 'netLabel: cut sink end',
        match: (n) => n.kind === 'netLabel' && n.metadata?.cutNet?.role === 'sink',
      },
      // Same fixture, but picking the *real* port each label hangs off of —
      // the green dashed box is that port's ELK bounding box inflated by
      // netCutPortMargins (see mergeLayout.ts): the label is never its own
      // ELK graph node, but its footprint still has to keep the layered
      // algorithm from packing a neighbor on top of it.
      {
        label: 'port: source (+ cut margin)',
        match: (n) => n.kind === 'port' && n.ports[0]?.direction === 'input',
      },
      {
        label: 'port: sink (+ cut margin)',
        match: (n) => n.kind === 'port' && n.ports[0]?.direction === 'output',
      },
    ],
  },
];

// Auto-detects, for a picked node, whichever of its own ports has a dangling
// cut-net end attached in this same view (found by walking the synthetic
// cut-stub edges), and the size that end's label would reserve. Mirrors
// netCutPortMargins in mergeLayout.ts, but read back from a built view
// instead of a SavedLayout, since these are hand-picked visual fixtures.
export function netCutMarginsForNode(
  view: DiagramViewModel,
  node: DiagramNode,
): Map<string, { width: number; height: number }> | undefined {
  const margins = new Map<string, { width: number; height: number }>();
  for (const edge of view.edges) {
    if (!edge.metadata?.cutStub) continue;
    if (edge.source !== node.id && edge.target !== node.id) continue;
    const labelId = edge.source === node.id ? edge.target : edge.source;
    const portId = edge.source === node.id ? edge.sourcePort : edge.targetPort;
    const label = view.nodes.find((candidate) => candidate.id === labelId);
    if (!label || label.kind !== 'netLabel' || !portId) continue;
    margins.set(portId, diagramNodeDimensions(label));
  }
  return margins.size > 0 ? margins : undefined;
}

export function snapFullGrid(value: number): number {
  return Math.round(value / GRID) * GRID;
}

export function snapForKind(value: number, node: DiagramNode): number {
  const halfGrid =
    node.kind === 'port' ||
    node.kind === 'literal' ||
    (node.kind === 'interface' && structRole(node) === 'port');
  if (halfGrid) {
    return Math.round((value - GRID / 2) / GRID) * GRID + GRID / 2;
  }
  return snapFullGrid(value);
}

export interface CollectedNode {
  label: string;
  node: DiagramNode;
  extraPortMargins?: Map<string, { width: number; height: number }>;
}

export async function collectNodes(): Promise<CollectedNode[]> {
  const collected: CollectedNode[] = [];
  for (const selection of selections) {
    const view = await buildFixtureView(
      selection.fixture,
      selection.layoutMode ?? 'auto',
      selection.module,
    );
    for (const pick of selection.picks) {
      const node = view.nodes.find((candidate) => pick.match(candidate));
      if (!node) {
        throw new Error(
          `No node matching "${pick.label}" in ${selection.fixture}${selection.module ? ` (module ${selection.module})` : ''}`,
        );
      }
      collected.push({
        label: pick.label,
        node,
        extraPortMargins: netCutMarginsForNode(view, node),
      });
    }
  }
  const ids = new Set<string>();
  for (const { node } of collected) {
    if (ids.has(node.id)) {
      throw new Error(`Duplicate node id across fixtures: ${node.id}`);
    }
    ids.add(node.id);
  }
  return collected;
}

export interface OverlayPort {
  anchor: { x: number; y: number };
  surface: { x: number; y: number };
}

export interface OverlayEntry {
  label: string;
  placementRect: { x: number; y: number; width: number; height: number };
  routingRect: { x: number; y: number; width: number; height: number };
  /** The same node's ELK box with its active net-cut margin(s) folded in —
   * only present for a port picked from a `cutNet` fixture selection. */
  marginRect?: { x: number; y: number; width: number; height: number };
  ports: OverlayPort[];
}

export function buildGridView(collected: CollectedNode[]): {
  view: DiagramViewModel;
  overlay: OverlayEntry[];
} {
  const positioned: PositionedNode[] = [];
  const overlay: OverlayEntry[] = [];

  let rowStart = 0;
  let y = 0;
  while (rowStart < collected.length) {
    const row = collected.slice(rowStart, rowStart + COLUMNS);
    let x = 0;
    let rowHeight = 0;
    for (const { label, node, extraPortMargins } of row) {
      const withLeads = elkNodeForDiagramNode(node, true);
      const withRoutingMargins = elkRoutingNodeForDiagramNode(node, extraPortMargins);
      const bare = elkNodeForDiagramNode(node, false);
      // The margin-inflated box is for the overlay comparison only — the
      // node's own rendered position still comes from the plain lead offset,
      // exactly like it does in the real diagram (see makeCutLabelNode).
      const withMargins = extraPortMargins
        ? elkNodeForDiagramNode(node, true, extraPortMargins)
        : undefined;
      const offset = withLeads.layoutOffset;
      // A cut-net margin on the west/north side grows the offset beyond the
      // plain lead's — shift the node rightward/downward within its cell by
      // exactly that much so the inflated box's leading edge lands on the
      // cell's nominal start instead of bleeding into the previous cell/row.
      const extraLeft = Math.max(0, (withMargins?.layoutOffset.x ?? 0) - offset.x);
      const extraTop = Math.max(0, (withMargins?.layoutOffset.y ?? 0) - offset.y);

      const position = {
        x: snapFullGrid(x + offset.x + extraLeft),
        y: snapForKind(y + offset.y + extraTop, node),
      };
      positioned.push({ ...node, position, fixed: true });

      const placementRect = {
        x: position.x - offset.x,
        y: position.y - offset.y,
        width: withLeads.width,
        height: withLeads.height,
      };
      const routingRect = {
        x: position.x - withRoutingMargins.layoutOffset.x,
        y: position.y - withRoutingMargins.layoutOffset.y,
        width: withRoutingMargins.width,
        height: withRoutingMargins.height,
      };
      const marginRect = withMargins
        ? {
            x: position.x - withMargins.layoutOffset.x,
            y: position.y - withMargins.layoutOffset.y,
            width: withMargins.width,
            height: withMargins.height,
          }
        : undefined;
      const barePortsById = new Map(bare.ports.map((port) => [port.id, port]));
      const ports = withLeads.ports.map((port) => {
        const barePort = barePortsById.get(port.id);
        if (!barePort) {
          throw new Error(`Port ${port.id} missing from bare elk node`);
        }
        // Prefer the rendered handle position (differs from the raw ELK port
        // where the visual attach point sits inside the box, e.g. interface
        // hats and array diagonal exits). Elk port ids are `${nodeId}:${portId}`.
        const rawPortId = port.id.slice(node.id.length + 1);
        const visual = visualHandleGeometry(node, rawPortId);
        // The bare call still applies its own margins (arrayLayerPad on
        // stacked nodes), so strip its layoutOffset to get the raw on-node
        // port position before re-basing onto the rendered node origin.
        return {
          anchor: { x: placementRect.x + port.x, y: placementRect.y + port.y },
          surface: visual
            ? {
                x: placementRect.x + offset.x + visual.offset.x,
                y: placementRect.y + offset.y + visual.offset.y,
              }
            : {
                x: placementRect.x + offset.x + barePort.x - bare.layoutOffset.x,
                y: placementRect.y + offset.y + barePort.y - bare.layoutOffset.y,
              },
        };
      });
      overlay.push({ label, placementRect, routingRect, marginRect, ports });

      const cellWidth = Math.max(
        extraLeft + withLeads.width,
        marginRect?.width ?? 0,
        withRoutingMargins.width,
      );
      const cellHeight = Math.max(
        extraTop + withLeads.height,
        marginRect?.height ?? 0,
        withRoutingMargins.height,
      );
      x += Math.ceil(cellWidth / GRID) * GRID + COLUMN_GAP;
      rowHeight = Math.max(rowHeight, cellHeight);
    }
    y += Math.ceil(rowHeight / GRID) * GRID + ROW_GAP;
    rowStart += COLUMNS;
  }

  const view: DiagramViewModel = {
    moduleName: 'elk_geometry_grid',
    nodes: positioned,
    edges: [],
    diagnostics: [],
  };
  return { view, overlay };
}
