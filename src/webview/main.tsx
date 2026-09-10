import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  type Edge,
  useReactFlow,
  useEdgesState,
  useNodesState,
  useStore,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './diagram.css';
import './webview-chrome.css';
import { diagramSizing } from '../diagram/constants';
import {
  diagramNodeDimensions,
  instanceParameterRows,
  resolvedNodeDimensions,
} from '../diagram/nodeSizing';
import {
  annotateGenerateRegionWarnings,
  findExternalBlockIds,
  GENERATE_REGION_EXTERNAL_BLOCK_WARNING,
} from '../layout/generateRegionValidation';
import { OrthogonalEdge, type RouteChange } from './orthogonal';
import { LineJumpProvider } from './react-flow-line-jumps';
import { Tooltip } from './Tooltip';
import type {
  DesignModule,
  DiagramViewModel,
  DiagramEdge,
  DiagramPort,
  PositionedGenerateRegion,
  PositionedNode,
} from '../ir/types';
import { edgeNetKey } from '../ir/edgeNet';
import { compareEdgePaintOrder } from '../diagram/edgePaintOrder';
import { nodeIsArrayNode } from '../ir/nodeMetadata';
import { edgeIsThick } from '../ir/edgeStyle';
import { HdlNode } from './nodes/HdlNode';
import { MiniMapNode } from './nodes/MiniMapNode';
import {
  InteractionContext,
  type NodeResizeHandle,
  type SelectionAction,
} from './nodes/shared/context';
import { ModuleParameterTable } from './nodes/shared/labels';
import type { HdlFlowNode, ArrayStackConnection } from './nodes/types';
import {
  childNamespace,
  isExpandNamespacedId,
  namespacedId,
  spliceExpandedInstance,
  type ExpandSpliceLayout,
  type SpliceInput,
} from './expand/splice';
import {
  absorbSplicedEdgeRouteChanges,
  applyActiveSplices,
  EXPAND_GHOST_CLASS,
  removeSpliceAndDescendants,
  syncSpliceCache,
  type ActiveSplice,
} from './expand/expandOverlay';

interface GraphMessage {
  type: 'graph';
  view: DiagramViewModel;
  modules: string[];
  expandedInstanceIds?: string[];
  expandedFunctionCallIds?: string[];
  expandedTaskCallIds?: string[];
}

interface StatusMessage {
  type: 'status';
  status: 'idle' | 'rebuilding';
}

// Mirrors ExpandInstancePayload in diagramPanel.ts (not imported directly —
// that file pulls in the `vscode` module and lives outside the webview
// tsconfig project, same reason GraphMessage/StatusMessage above are their
// own local declarations rather than shared imports).
interface ExpandInstancePayload {
  instanceId: string;
  childModuleName: string;
  module: DesignModule;
  spliceLayout?: ExpandSpliceLayout;
}

interface ExpandInstanceDataMessage {
  type: 'expandInstanceData';
  moduleName: string;
  payload: ExpandInstancePayload;
}

interface ExpandFunctionCallPayload {
  callId: string;
  functionId: string;
  module: DesignModule;
  spliceLayout?: ExpandSpliceLayout;
}

interface ExpandFunctionCallDataMessage {
  type: 'expandFunctionCallData';
  moduleName: string;
  payload: ExpandFunctionCallPayload;
}

interface ExpandTaskCallPayload {
  callId: string;
  taskId: string;
  module: DesignModule;
  spliceLayout?: ExpandSpliceLayout;
}

interface ExpandTaskCallDataMessage {
  type: 'expandTaskCallData';
  moduleName: string;
  payload: ExpandTaskCallPayload;
}

interface PendingExpandRequest {
  expansionKind: 'instance' | 'funcCall' | 'taskCall';
  namespace: string;
  parentRegionId?: string;
  parentModuleName: string;
  localInstanceId: string;
  topLevel: boolean;
  flowInstanceId: string;
  instanceLabel: string;
  instancePosition: { x: number; y: number };
  instanceSize: { width: number; height: number };
  instanceParamRows: number;
  instancePorts: DiagramPort[];
}

import { getVscodeApi } from './vscodeApi';

const vscode = getVscodeApi();

const EDGE_Z_INDEX = 1;
const ARRAY_NODE_Z_INDEX = 2;
const BLOCK_NODE_Z_INDEX = 2;
// A cut net's stub wire is always short and runs from a node straight out to
// its own dangling end, so it never has a real edge's usual clearance from
// node interiors — draw it (and its hover-only Reroute control) above nodes
// so it stays visible, and clickable, when it lands close to one.
const CUT_STUB_EDGE_Z_INDEX = 3;
const GENERATE_REGION_MIN_CONTENT_PADDING = diagramSizing.gridSize * 2;

function generateStateClass(state?: string, prefix = 'generate'): string | undefined {
  if (state === 'active') return `${prefix}-active`;
  if (state === 'inactive') return `${prefix}-inactive`;
  return undefined;
}

interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

// The React Flow MiniMap has no slot for extra SVG content, so we inject a group of
// generate/arm region outlines directly into its <svg>. The minimap svg's viewBox is in
// flow coordinates, so region bounds map straight in and track node moves automatically.
function MiniMapRegionOutlines({ regions }: { regions: PositionedGenerateRegion[] }): null {
  useEffect(() => {
    const svg = document.querySelector('.svsch-minimap .react-flow__minimap-svg');
    if (!svg) return;
    const ns = 'http://www.w3.org/2000/svg';
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('class', 'svsch-minimap-regions');
    for (const region of regions) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(region.bounds.x));
      rect.setAttribute('y', String(region.bounds.y));
      rect.setAttribute('width', String(region.bounds.width));
      rect.setAttribute('height', String(region.bounds.height));
      rect.setAttribute(
        'class',
        [
          'svsch-minimap-region',
          region.isGenerateBlock ? 'svsch-minimap-region-block' : 'svsch-minimap-region-arm',
          region.invalid ? 'svsch-minimap-region-invalid' : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
      group.appendChild(rect);
    }
    svg.appendChild(group);
    return () => {
      group.parentNode?.removeChild(group);
    };
  }, [regions]);
  return null;
}

function App(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <DiagramApp />
    </ReactFlowProvider>
  );
}

function DiagramApp(): React.ReactElement {
  const [view, setView] = useState<DiagramViewModel | undefined>();
  const [modules, setModules] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'rebuilding'>('idle');
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<HdlFlowNode>([]);
  const [regions, setRegions] = useState<PositionedGenerateRegion[]>([]);
  const regionsRef = useRef<PositionedGenerateRegion[]>([]);
  const dynamicCutLabelIdsByOwnerRef = useRef<Map<string, string[]>>(new Map());
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  // Portal target for floating controls that must paint above node bodies —
  // see InteractionContext.overlayPortalNode for why this is kept separate
  // from react-flow's own ViewportPortal.
  const [overlayPortalNode, setOverlayPortalNode] = useState<HTMLDivElement | null>(null);
  const groupDragRef = useRef<{
    startPos: { x: number; y: number };
    originalRoutes: Map<string, Array<{ x: number; y: number }>>;
    // Region bounds at drag start, so marquee-selected regions can translate with
    // the dragged selection instead of merely stretching around their nodes.
    startRegions: PositionedGenerateRegion[];
  } | null>(null);
  // "Expand instance in place" (issue #232) — every currently-expanded
  // instance's spliced-in content, keyed by its expand namespace (see
  // webview/expand/splice.ts). Kept as a ref (not React state) independent
  // of the server-driven `view`, so an unrelated view refresh — the common
  // case, e.g. dragging some other node — doesn't need to re-fetch or
  // re-run ELK for content that hasn't changed; `applyActiveSplices` reattaches
  // the cached splice to the freshly-rebuilt base nodes/edges/regions every
  // time either changes (see the view-rebuild effect and requestExpand below).
  const spliceMapRef = useRef<Map<string, ActiveSplice>>(new Map());
  // Bumped to force a re-render (and re-application of spliceMapRef's
  // contents) whenever the ref's contents change outside of a `view` update
  // — e.g. right after a new splice is computed, or on collapse.
  const [spliceVersion, setSpliceVersion] = useState(0);
  // The module name spliceMapRef's current contents were computed against —
  // see the "graph" message handler below, which clears the whole cache on a
  // real navigation to a different module (not just an unrelated refresh of
  // the same one).
  const spliceMapModuleNameRef = useRef<string | undefined>(undefined);
  const pendingSpliceRequestsRef = useRef<Map<string, PendingExpandRequest>>(new Map());
  const onNodesChange = useCallback(
    (changes: any[]) => {
      const adjusted = changes.map((change) => {
        if (change.type === 'position' && change.position) {
          const node = nodes.find((candidate) => candidate.id === change.id);
          const kind = node?.data?.node?.kind;
          const role = node?.data?.node?.metadata?.role;
          const isHalfGrid =
            kind === 'port' || kind === 'literal' || (kind === 'interface' && role === 'port');
          if (kind === 'netLabel') {
            return {
              ...change,
              position: {
                x: Math.round(change.position.x / 24) * 24,
                y: Math.round(change.position.y / 24) * 24,
              },
            };
          }
          if (isHalfGrid) {
            return {
              ...change,
              position: {
                x: Math.round(change.position.x / 24) * 24,
                y: Math.round((change.position.y - 12) / 24) * 24 + 12,
              },
            };
          }
        }
        return change;
      });

      // Dynamic cut labels are derived from their owning port and are not
      // persisted as fixed nodes. If a dragged owner would run into its stale
      // local label position, carry the label by the same delta so the node and
      // stub stay clear until the next extension-host rebuild. Labels that are
      // already clear remain untouched (and outside unrelated selections).
      const changedIds = new Set(adjusted.map((change) => change.id));
      const followers = new Map<string, any>();
      for (const change of adjusted) {
        if (change.type !== 'position' || !change.position) continue;
        const owner = nodes.find((node) => node.id === change.id);
        if (!owner || owner.data.node.kind === 'netLabel') continue;

        for (const labelId of dynamicCutLabelIdsByOwnerRef.current.get(owner.id) ?? []) {
          if (changedIds.has(labelId) || followers.has(labelId)) continue;

          const label = nodes.find((node) => node.id === labelId);
          if (!label || label.data.node.kind !== 'netLabel' || label.data.node.fixed) continue;
          const ownerSize = resolvedNodeDimensions(owner.data.node);
          const labelSize = diagramNodeDimensions(label.data.node);
          const ownerBounds = {
            x: change.position.x - diagramSizing.gridSize,
            y: change.position.y - diagramSizing.gridSize,
            width: ownerSize.width + diagramSizing.gridSize * 2,
            height: ownerSize.height + diagramSizing.gridSize * 2,
          };
          const labelBounds = {
            x: label.position.x,
            y: label.position.y,
            width: labelSize.width,
            height: labelSize.height,
          };
          const wouldOverlap =
            ownerBounds.x < labelBounds.x + labelBounds.width &&
            labelBounds.x < ownerBounds.x + ownerBounds.width &&
            ownerBounds.y < labelBounds.y + labelBounds.height &&
            labelBounds.y < ownerBounds.y + ownerBounds.height;
          if (!wouldOverlap) continue;
          followers.set(labelId, {
            type: 'position',
            id: labelId,
            position: {
              x: label.position.x + change.position.x - owner.position.x,
              y: label.position.y + change.position.y - owner.position.y,
            },
            dragging: change.dragging,
          });
        }
      }

      // Dragging an expanded instance's dimmed node carries its entire spliced
      // subtree with it — the node's own border IS the expanded frame (there's
      // no separate region outline to drag), so moving it must move the
      // unfolded content live, not just re-anchor it after the drop. Processed
      // as a queue because a carried member can itself be a (nested) expanded
      // instance whose own members then need the same delta.
      const spliceFollowers = new Map<string, any>();
      const carryQueue = [...adjusted];
      while (carryQueue.length > 0) {
        const change = carryQueue.shift();
        if (change.type !== 'position' || !change.position) continue;
        const splice = [...spliceMapRef.current.values()].find(
          (s) => s.flowInstanceId === change.id,
        );
        if (!splice) continue;
        const owner = nodes.find((node) => node.id === change.id);
        if (!owner) continue;
        const dx = change.position.x - owner.position.x;
        const dy = change.position.y - owner.position.y;
        if (dx === 0 && dy === 0) continue;
        for (const memberId of splice.region.nodeIds) {
          if (changedIds.has(memberId) || spliceFollowers.has(memberId)) continue;
          const member = nodes.find((node) => node.id === memberId);
          if (!member) continue;
          const memberChange = {
            type: 'position',
            id: memberId,
            position: { x: member.position.x + dx, y: member.position.y + dy },
            dragging: change.dragging,
          };
          spliceFollowers.set(memberId, memberChange);
          carryQueue.push(memberChange);
        }
      }

      onNodesChangeRaw([...adjusted, ...followers.values(), ...spliceFollowers.values()]);
    },
    [nodes, onNodesChangeRaw],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const reactFlow = useReactFlow();
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const userSelectionRect = useStore((state) => state.userSelectionRect);
  const [selectedRegionIds, setSelectedRegionIds] = useState<Set<string>>(new Set());
  const selectionStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const fittedModuleNameRef = useRef<string | undefined>(undefined);
  // Node ids to re-select in the very next view rebuild — set right before
  // posting an "Auto Layout" request, consumed (and cleared) the next time
  // the nodes array is rebuilt from an incoming view, so the just-relaid-out
  // blocks stay selected instead of losing selection on the round-trip.
  const pendingReselectIdsRef = useRef<Set<string> | null>(null);

  // Marquee (drag) selection also selects generate regions. A region is selected
  // when its bounds are fully inside the selection rectangle — full containment, so
  // an arm can be selected without always dragging in its surrounding generate block
  // (whose bounds any marquee over the arm would partially overlap).
  useEffect(() => {
    if (!userSelectionRect) return;
    const zoom = Math.max(viewport.zoom || 1, 0.01);
    const rect = {
      x: (userSelectionRect.x - viewport.x) / zoom,
      y: (userSelectionRect.y - viewport.y) / zoom,
      width: userSelectionRect.width / zoom,
      height: userSelectionRect.height / zoom,
    };
    const inside = new Set(
      regions
        // Expand regions render no frame of their own (the expanded instance's
        // node is the frame) — a marquee selects that node instead.
        .filter((region) => region.kind !== 'expand')
        .filter(
          (region) =>
            region.bounds.x >= rect.x &&
            region.bounds.y >= rect.y &&
            region.bounds.x + region.bounds.width <= rect.x + rect.width &&
            region.bounds.y + region.bounds.height <= rect.y + rect.height,
        )
        .map((region) => region.id),
    );
    setSelectedRegionIds((current) => {
      if (current.size === inside.size && [...inside].every((id) => current.has(id)))
        return current;
      return inside;
    });

    // Marquee selection is scoped to the top-level diagram: nodes and wires
    // spliced inside an expanded instance (issue #232) belong to a separate
    // sub-diagram and are exempt — the marquee selects the expanded
    // instance's own (outer) node instead. Individual click-selection of
    // spliced nodes is untouched (needed e.g. for nested Expand). Applied
    // live while the rect is dragged out; handleSelectionEnd repeats the
    // sweep once React Flow applies its final selection.
    deselectSplicedContent(setNodes, setEdges);
  }, [userSelectionRect, regions, viewport, setNodes, setEdges]);

  const handleSelectionStart = useCallback((event: React.MouseEvent) => {
    selectionStartPointRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const handleSelectionEnd = useCallback(
    (event: React.MouseEvent) => {
      const start = selectionStartPointRef.current;
      selectionStartPointRef.current = null;
      if (!start) return;

      const startFlow = reactFlow.screenToFlowPosition(start);
      const endFlow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const rect = {
        x: Math.min(startFlow.x, endFlow.x),
        y: Math.min(startFlow.y, endFlow.y),
        width: Math.abs(endFlow.x - startFlow.x),
        height: Math.abs(endFlow.y - startFlow.y),
      };

      // React Flow's lasso can omit synthetic cut-label nodes even when their
      // measured boxes are visibly inside the rectangle. Apply the same partial
      // intersection rule explicitly so the rendered selection matches the box
      // the user drew. Labels outside the lasso remain unselected.
      setNodes((current) => {
        let changed = false;
        const next = current.map((node) => {
          if (node.data.node.kind !== 'netLabel') return node;
          const size = diagramNodeDimensions(node.data.node);
          const selected =
            node.position.x < rect.x + rect.width &&
            rect.x < node.position.x + size.width &&
            node.position.y < rect.y + rect.height &&
            rect.y < node.position.y + size.height;
          if (Boolean(node.selected) === selected) return node;
          changed = true;
          return { ...node, selected };
        });
        return changed ? next : current;
      });

      // The marquee never selects content spliced inside an expanded
      // instance — see the userSelectionRect effect above; this repeats the
      // sweep after React Flow has applied its own final selection.
      deselectSplicedContent(setNodes, setEdges);
    },
    [reactFlow, setNodes, setEdges],
  );

  const clearRegionSelection = useCallback(() => {
    setSelectedRegionIds((current) => (current.size === 0 ? current : new Set()));
  }, []);

  // Single-click/drag selection of a region, mirroring node click behavior: the
  // clicked region becomes the sole selection and any selected nodes are dropped.
  const selectRegion = useCallback(
    (regionId: string) => {
      setSelectedRegionIds(new Set([regionId]));
      setNodes((current) => {
        let changed = false;
        const next = current.map((node) => {
          if (!node.selected) return node;
          changed = true;
          return { ...node, selected: false };
        });
        return changed ? next : current;
      });
    },
    [setNodes],
  );

  // React Flow's built-in double-click zoom fires for any double-click inside the
  // pane, including ones that navigate to source (nodes, edges, generate region
  // titles). It is disabled and re-implemented here for empty-canvas double-clicks
  // only, keeping d3's behavior: zoom ×2 centered on the cursor, shift to zoom out.
  const handleCanvasDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest('.react-flow__pane')) return;
      if (target.closest('.react-flow__node, .react-flow__edge, .generate-region')) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const current = reactFlow.getViewport();
      const zoom = Math.min(maxZoom, Math.max(minZoom, current.zoom * (event.shiftKey ? 0.5 : 2)));
      if (zoom === current.zoom) return;
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      const scale = zoom / current.zoom;
      void reactFlow.setViewport(
        {
          x: pointerX - (pointerX - current.x) * scale,
          y: pointerY - (pointerY - current.y) * scale,
          zoom,
        },
        { duration: 250 },
      );
    },
    [reactFlow, minZoom, maxZoom],
  );
  const [hoveredNetKey, setHoveredNetKey] = useState<string | undefined>();
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | undefined>();
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const externalOverlapNodeIdsRef = useRef<Set<string>>(new Set());
  const [selectionHoverActive, setSelectionHoverActive] = useState(false);
  const [pendingSelectionAction, setPendingSelectionAction] = useState<
    SelectionAction | undefined
  >();

  const setHovered = useCallback((netKey?: string, immediate = false) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = undefined;
    }

    if (netKey || immediate) {
      setHoveredNetKey(netKey);
    } else {
      hoverTimeoutRef.current = setTimeout(() => {
        setHoveredNetKey(undefined);
        hoverTimeoutRef.current = undefined;
      }, 500);
    }
  }, []);

  useEffect(() => {
    regionsRef.current = regions;
  }, [regions]);

  // Flag blocks that overlap a generate arm they don't belong to (or are marked
  // invalid by the view) so React Flow renders the shared error outline on them.
  useEffect(() => {
    const invalidIds = findExternalBlockIds(regions, flowNodesToPositioned(nodes, new Set()));
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const dynamicExternalIds = externalOverlapNodeIdsRef.current;
        const isExternalOverlap = invalidIds.has(node.id);
        const hadExternalOverlapWarning = dynamicExternalIds.has(node.id);
        const keepExistingInvalid = Boolean(node.data.node.invalid) && !hadExternalOverlapWarning;
        const wantInvalid = keepExistingInvalid || isExternalOverlap;
        const warningNote = isExternalOverlap
          ? GENERATE_REGION_EXTERNAL_BLOCK_WARNING
          : hadExternalOverlapWarning
            ? undefined
            : node.data.node.warningNote;
        if (isExternalOverlap) {
          dynamicExternalIds.add(node.id);
        } else {
          dynamicExternalIds.delete(node.id);
        }
        const base = generateStateClass(
          node.data.node.metadata?.generateActiveState,
          'generate-node',
        );
        // Preserve the "Expand instance in place" dimming class (see
        // expandOverlay's dimAsExpandGhost) — this effect otherwise rebuilds
        // className from scratch and would silently strip it every time
        // regions/nodes change.
        const isExpandGhost = node.className?.split(' ').includes(EXPAND_GHOST_CLASS) ?? false;
        const className =
          [base, wantInvalid ? 'svsch-node-invalid' : '', isExpandGhost ? EXPAND_GHOST_CLASS : '']
            .filter(Boolean)
            .join(' ') || undefined;
        const invalid = wantInvalid || undefined;
        const dataNode =
          node.data.node.invalid === invalid && node.data.node.warningNote === warningNote
            ? node.data.node
            : { ...node.data.node, invalid, warningNote };
        if ((node.className || undefined) === className && dataNode === node.data.node) return node;
        changed = true;
        return { ...node, className, data: { ...node.data, node: dataNode } };
      });
      return changed ? next : current;
    });
  }, [regions, nodes, setNodes]);

  const handleRouteChange = useCallback(
    (changes: RouteChange[], commit: boolean) => {
      const changeMap = new Map(changes.map((c) => [c.edgeId, c.routePoints]));

      setEdges((currentEdges: Edge[]) =>
        currentEdges.map((edge: Edge) => {
          const routePoints = changeMap.get(edge.id);
          if (routePoints) {
            return { ...edge, data: { ...edge.data, routePoints } };
          }
          return edge;
        }),
      );

      if (commit && view) {
        // Routes of wires spliced in by "Expand instance in place" belong to
        // the webview's own splice cache (the host knows nothing about those
        // edges) — absorb them there so a dragged internal wire survives the
        // next splice reattachment, and only tell the host about its own.
        const hostChanges = absorbSplicedEdgeRouteChanges(spliceMapRef.current, changes);
        if (hostChanges.length === 0) return;
        const flowNodes = reactFlow.getNodes() as HdlFlowNode[];
        vscode.postMessage({
          type: 'edgeRoutesChanged',
          moduleName: view.moduleName,
          changes: hostChanges,
          nodes: stripExpandSplices(
            flowNodesToPositioned(flowNodes, new Set(flowNodes.map((node) => node.id))),
            spliceMapRef.current,
          ),
        });
      }
    },
    [reactFlow, setEdges, view],
  );

  const onEdgeMouseEnter = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      const diagramEdge = edge.data?.edge as DiagramEdge | undefined;
      const netKey = diagramEdge ? edgeNetKey(diagramEdge) : undefined;
      setHovered(netKey);
    },
    [setHovered],
  );

  const onEdgeMouseLeave = useCallback(() => {
    setHovered(undefined);
  }, [setHovered]);

  const [expandedInstanceIds, setExpandedInstanceIds] = useState<string[]>([]);
  const [expandedFunctionCallIds, setExpandedFunctionCallIds] = useState<string[]>([]);
  const [expandedTaskCallIds, setExpandedTaskCallIds] = useState<string[]>([]);

  useEffect(() => {
    const listener = (
      event: MessageEvent<
        | GraphMessage
        | StatusMessage
        | ExpandInstanceDataMessage
        | ExpandFunctionCallDataMessage
        | ExpandTaskCallDataMessage
      >,
    ) => {
      if (event.data.type === 'graph') {
        const view = event.data.view;
        // An expanded instance's spliced content must always reflect the
        // child module's *current* standalone layout (see the product
        // decision in issue #232's PR review) — a splice cached from before
        // this navigation may be stale if the user just edited that child
        // module's own layout directly (e.g. double-clicked into it, moved a
        // node, and navigated back). Since this app has a single diagram
        // panel, "navigated back" is exactly a graph message whose
        // moduleName differs from the one spliceMapRef's contents were last
        // computed against — clear the whole cache so every expanded
        // instance re-fetches fresh (cheap: one host round-trip each,
        // reusing already-in-memory layout data) rather than silently
        // reattaching outdated content. An unrelated refresh of the *same*
        // module (e.g. another edit) must NOT clear it, or every such splice
        // would re-fetch on every keystroke.
        if (
          spliceMapModuleNameRef.current !== undefined &&
          spliceMapModuleNameRef.current !== view.moduleName &&
          spliceMapRef.current.size > 0
        ) {
          spliceMapRef.current.clear();
          setSpliceVersion((v) => v + 1);
        }
        spliceMapModuleNameRef.current = view.moduleName;
        setView(view);
        setModules(event.data.modules);
        setExpandedInstanceIds(event.data.expandedInstanceIds ?? []);
        setExpandedFunctionCallIds(event.data.expandedFunctionCallIds ?? []);
        setExpandedTaskCallIds(event.data.expandedTaskCallIds ?? []);
        setHovered(undefined, true);
        setHoveredEdgeId(undefined);
      } else if (event.data.type === 'status') {
        setStatus(event.data.status);
      } else if (
        event.data.type === 'expandInstanceData' ||
        event.data.type === 'expandFunctionCallData' ||
        event.data.type === 'expandTaskCallData'
      ) {
        const { moduleName } = event.data;
        const payload = event.data.payload;
        const expansionKind =
          event.data.type === 'expandFunctionCallData'
            ? ('funcCall' as const)
            : event.data.type === 'expandTaskCallData'
              ? ('taskCall' as const)
              : ('instance' as const);
        const localId =
          event.data.type === 'expandFunctionCallData' || event.data.type === 'expandTaskCallData'
            ? event.data.payload.callId
            : event.data.payload.instanceId;
        const childModuleName =
          event.data.type === 'expandFunctionCallData'
            ? event.data.payload.functionId
            : event.data.type === 'expandTaskCallData'
              ? event.data.payload.taskId
              : event.data.payload.childModuleName;
        // Keyed by namespace (globally unique — see requestExpand), not by
        // (moduleName, instanceId): two different sibling instances of the
        // *same* child module type share that pair (moduleName here is the
        // shared child module's own name), so two concurrent requests for
        // "the same-named nested instance under two different parents" would
        // otherwise collide on one dedup entry and silently drop the second.
        // The host's response only carries (moduleName, instanceId) back, so
        // match the oldest still-pending request for that pair.
        let pendingKey: string | undefined;
        for (const [key, candidate] of pendingSpliceRequestsRef.current) {
          if (
            candidate.parentModuleName === moduleName &&
            candidate.localInstanceId === localId &&
            candidate.expansionKind === expansionKind
          ) {
            pendingKey = key;
            break;
          }
        }
        const pending = pendingKey ? pendingSpliceRequestsRef.current.get(pendingKey) : undefined;
        if (pendingKey) pendingSpliceRequestsRef.current.delete(pendingKey);
        if (!pending) return;
        const spliceInput: SpliceInput = {
          expansionKind,
          namespace: pending.namespace,
          parentRegionId: pending.parentRegionId,
          parentModuleName: pending.parentModuleName,
          instanceId: localId,
          instanceLabel: pending.instanceLabel,
          instancePosition: pending.instancePosition,
          instanceSize: pending.instanceSize,
          instanceParamRows: pending.instanceParamRows,
          instancePorts: pending.instancePorts,
          childModule: payload.module,
          hostLayout: payload.spliceLayout,
        };
        void spliceExpandedInstance(spliceInput).then((result) => {
          spliceMapRef.current.set(pending.namespace, {
            ...result,
            namespace: pending.namespace,
            flowInstanceId: pending.flowInstanceId,
            parentModuleName: pending.parentModuleName,
            instanceId: localId,
            childModuleName,
            expansionKind,
            topLevel: pending.topLevel,
            anchorInstancePosition: pending.instancePosition,
          });
          setSpliceVersion((v) => v + 1);
        });
      }
    };
    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [setHovered]);

  // Sends a requestExpandInstance message and remembers enough context (the
  // instance's current geometry, its namespace/parentRegionId in the splice
  // tree) to build a SpliceInput once the host responds — see the
  // `expandInstanceData` branch above. A no-op if this instance already has
  // (or is already fetching) a splice. Both callers (the toolbar's Expand
  // button and the auto-restore effect below) only ever pass a top-level
  // instance of the currently open module as of #233 — nested expand is no
  // longer reachable from the UI — but the enclosing-splice lookup is kept
  // so this still resolves correctly if that ever changes.
  const requestExpand = useCallback(
    (instanceNode: HdlFlowNode) => {
      if (!view) return;
      const expansionKind = instanceNode.data.node.kind;
      if (
        expansionKind !== 'instance' &&
        expansionKind !== 'funcCall' &&
        expansionKind !== 'taskCall'
      ) {
        return;
      }
      let parentNamespace: string | undefined;
      let enclosing: ActiveSplice | undefined;
      for (const splice of spliceMapRef.current.values()) {
        if (splice.region.nodeIds.includes(instanceNode.id)) {
          enclosing = splice;
          parentNamespace = splice.namespace;
          break;
        }
      }
      const localInstanceId = enclosing
        ? instanceNode.id.slice(namespacedId(enclosing.namespace, '').length)
        : instanceNode.id;
      const namespace = parentNamespace
        ? childNamespace(parentNamespace, localInstanceId)
        : localInstanceId;
      const parentModuleName = enclosing ? enclosing.childModuleName : view.moduleName;
      const parentRegionId = enclosing?.region.id;
      const topLevel = enclosing === undefined;

      const node = instanceNode.data.node;
      // Keyed by namespace, not (parentModuleName, localInstanceId) — two
      // sibling instances of the same child module type share that pair (see
      // the expandInstanceData handler above for why), but namespaces are
      // always globally unique.
      if (spliceMapRef.current.has(namespace) || pendingSpliceRequestsRef.current.has(namespace)) {
        return;
      }
      pendingSpliceRequestsRef.current.set(namespace, {
        expansionKind,
        namespace,
        parentRegionId,
        parentModuleName,
        localInstanceId,
        topLevel,
        flowInstanceId: instanceNode.id,
        instanceLabel: node.label,
        instancePosition: instanceNode.position,
        instanceSize: resolvedNodeDimensions(node),
        instanceParamRows: expansionKind === 'instance' ? instanceParameterRows(node) : 0,
        instancePorts: node.ports,
      });
      if (expansionKind === 'funcCall') {
        vscode.postMessage({
          type: 'requestExpandFunctionCall',
          moduleName: parentModuleName,
          callId: localInstanceId,
          topLevel,
          callSize: resolvedNodeDimensions(node),
        });
      } else if (expansionKind === 'taskCall') {
        vscode.postMessage({
          type: 'requestExpandTaskCall',
          moduleName: parentModuleName,
          callId: localInstanceId,
          topLevel,
          callSize: resolvedNodeDimensions(node),
        });
      } else {
        vscode.postMessage({
          type: 'requestExpandInstance',
          moduleName: parentModuleName,
          instanceId: localInstanceId,
          topLevel,
          // The live rendered geometry — the host sizes the expanded frame
          // with these (grow-only), keeping the border and boundary-port rows
          // exactly where the collapsed node's are on screen right now.
          instanceSize: resolvedNodeDimensions(node),
          instanceParamRows: instanceParameterRows(node),
        });
      }
    },
    [view],
  );

  // Auto-restore: on module (re)open, re-request a splice for every
  // top-level instance the host has flagged expanded (see
  // SavedModuleLayout.expanded) that isn't already cached — a previously
  // expanded instance stays expanded across a reload without the user
  // re-clicking Expand. Nested expands are never persisted (see
  // diagramPanel.ts's `topLevel` guard) and, as of #233, can't be created at
  // all — expand/collapse on a nested instance only happens from that
  // instance's own module view — so there's nothing nested to restore here.
  useEffect(() => {
    if (!view) return;
    for (const instanceId of expandedInstanceIds) {
      if (spliceMapRef.current.has(instanceId)) continue;
      const instanceNode = nodes.find((node) => node.id === instanceId);
      if (!instanceNode || instanceNode.data.node.kind !== 'instance') continue;
      requestExpand(instanceNode);
    }
  }, [view, expandedInstanceIds, nodes, requestExpand]);

  useEffect(() => {
    if (!view) return;
    for (const callId of expandedFunctionCallIds) {
      if (spliceMapRef.current.has(callId)) continue;
      const callNode = nodes.find((node) => node.id === callId);
      if (!callNode || callNode.data.node.kind !== 'funcCall') continue;
      requestExpand(callNode);
    }
  }, [view, expandedFunctionCallIds, nodes, requestExpand]);

  useEffect(() => {
    if (!view) return;
    for (const callId of expandedTaskCallIds) {
      if (spliceMapRef.current.has(callId)) continue;
      const callNode = nodes.find((node) => node.id === callId);
      if (!callNode || callNode.data.node.kind !== 'taskCall') continue;
      requestExpand(callNode);
    }
  }, [view, expandedTaskCallIds, nodes, requestExpand]);

  // Keeps the host's DiagramPanel.expandedFrameSizesByModule in sync with
  // every top-level "Expand instance in place" frame's real on-screen size
  // — otherwise the host's own libavoid routing pass (which runs on *every*
  // view rebuild, not just an explicit Auto Layout) only ever sees the
  // collapsed instance's saved size, so an unrelated wire whose route
  // happens to pass near the instance can end up cutting straight through
  // the expanded frame instead of routing around it. Keyed on spliceVersion
  // alone (not `view`) so a routine view refresh doesn't re-send this and
  // re-trigger a host-side postView in a loop; spliceMapModuleNameRef tracks
  // the module these sizes belong to without adding `view` as a dependency.
  useEffect(() => {
    const sizesModuleName = spliceMapModuleNameRef.current;
    if (!sizesModuleName) return;
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const splice of spliceMapRef.current.values()) {
      if (isExpandNamespacedId(splice.flowInstanceId)) continue;
      sizes[splice.flowInstanceId] = {
        width: Math.ceil(splice.expandedSize.width / diagramSizing.gridSize),
        height: Math.ceil(splice.expandedSize.height / diagramSizing.gridSize),
      };
    }
    vscode.postMessage({
      type: 'expandedFrameSizesChanged',
      moduleName: sizesModuleName,
      sizes,
    });
  }, [spliceVersion]);

  const collapseInstance = useCallback((namespace: string) => {
    const splice = spliceMapRef.current.get(namespace);
    if (!splice) return;
    removeSpliceAndDescendants(spliceMapRef.current, namespace);
    if (splice.topLevel) {
      // Drop the id from the local expanded list too: the host persists the
      // collapse but doesn't push a fresh graph message, so the auto-restore
      // effect above would still see the stale flag on the very next nodes
      // rebuild (triggered by the spliceVersion bump below) and immediately
      // re-expand the instance the user just collapsed.
      if (splice.expansionKind === 'funcCall') {
        setExpandedFunctionCallIds((ids) => ids.filter((id) => id !== splice.instanceId));
        vscode.postMessage({
          type: 'collapseFunctionCall',
          moduleName: splice.parentModuleName,
          callId: splice.instanceId,
          topLevel: true,
        });
      } else if (splice.expansionKind === 'taskCall') {
        setExpandedTaskCallIds((ids) => ids.filter((id) => id !== splice.instanceId));
        vscode.postMessage({
          type: 'collapseTaskCall',
          moduleName: splice.parentModuleName,
          callId: splice.instanceId,
          topLevel: true,
        });
      } else {
        setExpandedInstanceIds((ids) => ids.filter((id) => id !== splice.instanceId));
        vscode.postMessage({
          type: 'collapseInstance',
          moduleName: splice.parentModuleName,
          instanceId: splice.instanceId,
          topLevel: true,
        });
      }
    }
    setSpliceVersion((v) => v + 1);
  }, []);

  // GenerateRegionOverlay only knows region ids, not expand namespaces —
  // resolve one from the other via the cached splice map.
  const handleCollapseRegion = useCallback(
    (regionId: string) => {
      for (const [namespace, splice] of spliceMapRef.current) {
        if (splice.region.id === regionId) {
          collapseInstance(namespace);
          return;
        }
      }
    },
    [collapseInstance],
  );

  // r/t/c shortcuts for the Reroute/Cut/Tie controls, plus `c` for the
  // block-selection toolbar's Cut out button (see their badges next to the
  // button labels). Each mirrors exactly what clicking the button would
  // post, so it only fires when the same hover/selection state that reveals
  // the button is present — never globally, since with nothing hovered or
  // selected the target would be ambiguous.
  useEffect(() => {
    const isCuttable = (edge: Edge): boolean => {
      const diagramEdge = (edge.data as { edge?: DiagramEdge } | undefined)?.edge;
      return diagramEdge !== undefined && diagramEdge.metadata?.cutStub === undefined;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key !== 'r' && key !== 't' && key !== 'c') return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!view) return;

      // `nodes`/`edges` are rebuilt from `view` in a separate effect one render
      // behind this one, so a new graph message can leave this handler holding a
      // fresh `view` alongside stale node/edge ids from the previous graph.
      // Bail until the local state has actually caught up, so a shortcut never
      // combines a new moduleName with ids that belong to the old graph.
      const viewNodeIds = new Set(view.nodes.map((node) => node.id));
      const viewEdgeIds = new Set(view.edges.map((edge) => edge.id));
      const graphInSync =
        nodes.length === view.nodes.length &&
        edges.length === view.edges.length &&
        nodes.every(
          (node) => node.data.moduleName === view.moduleName && viewNodeIds.has(node.id),
        ) &&
        edges.every(
          (edge) => edge.data?.moduleName === view.moduleName && viewEdgeIds.has(edge.id),
        );
      if (!graphInSync) return;

      if (key === 't') {
        const netLabelNode = nodes.find((node) => {
          const cutNet = node.data.node.metadata?.cutNet;
          if (!cutNet) return false;
          return (
            node.selected === true ||
            (hoveredNetKey !== undefined && hoveredNetKey === cutNet.netKey)
          );
        });
        const cutNet = netLabelNode?.data.node.metadata?.cutNet;
        if (!cutNet) return;
        event.preventDefault();
        vscode.postMessage({ type: 'tieNet', moduleName: view.moduleName, netKey: cutNet.netKey });
        return;
      }

      // Selection wins over hover (matches the batch-Cut/Reroute controls, which
      // take over the moment more than one cuttable wire is selected); a solo
      // hover only ever targets the one specific edge under the pointer.
      const selectedEdges = edges.filter((edge) => edge.selected === true && isCuttable(edge));
      let targetEdges =
        selectedEdges.length > 0
          ? selectedEdges
          : edges.filter((edge) => edge.id === hoveredEdgeId && isCuttable(edge));
      // `c` also mirrors the block-selection toolbar's "Cut out" button: with
      // no wire selected or hovered to disambiguate, fall back to every
      // cuttable edge touching the selected block(s), if any.
      if (key === 'c' && targetEdges.length === 0) {
        targetEdges = cutOutEdgesForSelection(nodes, edges);
      }
      if (targetEdges.length === 0) return;
      event.preventDefault();

      // Matches positionedNodesFromFlowNodes in OrthogonalEdge.tsx: cutting/
      // rerouting freezes every real block in place, but a net-cut label that's
      // still tracking its port dynamically must not be forced fixed just
      // because it happened to be on screen.
      const positioned = stripExpandSplices(
        nodes.map((node) => ({
          ...node.data.node,
          position: node.position,
          fixed: node.data.node.kind === 'netLabel' ? node.data.node.fixed : true,
        })),
        spliceMapRef.current,
      );

      if (key === 'r') {
        if (targetEdges.length === 1) {
          vscode.postMessage({
            type: 'rerouteEdge',
            moduleName: view.moduleName,
            edgeId: targetEdges[0].id,
            nodes: positioned,
          });
        } else {
          vscode.postMessage({
            type: 'rerouteEdges',
            moduleName: view.moduleName,
            edgeIds: targetEdges.map((edge) => edge.id),
            nodes: positioned,
          });
        }
        return;
      }

      const diagramEdges = targetEdges
        .map((edge) => (edge.data as { edge?: DiagramEdge } | undefined)?.edge)
        .filter((edge): edge is DiagramEdge => edge !== undefined);
      if (diagramEdges.length === 1) {
        vscode.postMessage({
          type: 'cutNet',
          moduleName: view.moduleName,
          edge: diagramEdges[0],
          nodes: positioned,
        });
      } else {
        vscode.postMessage({
          type: 'cutNets',
          moduleName: view.moduleName,
          edges: diagramEdges,
          nodes: positioned,
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nodes, edges, view, hoveredNetKey, hoveredEdgeId]);

  useEffect(() => {
    if (!view) {
      dynamicCutLabelIdsByOwnerRef.current = new Map();
      return;
    }
    const nodeById = new Map(view.nodes.map((node) => [node.id, node]));
    const arrayConnectionsByNode = new Map<string, ArrayStackConnection[]>();
    const dynamicCutLabelIdsByOwner = new Map<string, string[]>();
    const addArrayConnection = (nodeId: string, connection: ArrayStackConnection) => {
      const list = arrayConnectionsByNode.get(nodeId) ?? [];
      if (
        !list.some(
          (existing) => existing.portId === connection.portId && existing.role === connection.role,
        )
      ) {
        list.push(connection);
      }
      arrayConnectionsByNode.set(nodeId, list);
    };
    const addDynamicCutLabel = (ownerId: string, labelId: string) => {
      const label = nodeById.get(labelId);
      if (label?.kind !== 'netLabel' || label.fixed) return;
      const labelIds = dynamicCutLabelIdsByOwner.get(ownerId) ?? [];
      if (!labelIds.includes(labelId)) labelIds.push(labelId);
      dynamicCutLabelIdsByOwner.set(ownerId, labelIds);
    };

    view.edges.forEach((edge) => {
      const cutStub = edge.metadata?.cutStub;
      if (cutStub?.role === 'source') {
        addDynamicCutLabel(edge.source, edge.target);
      } else if (cutStub?.role === 'sink') {
        addDynamicCutLabel(edge.target, edge.source);
      }
      if (!edge.isStacked) {
        return;
      }
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      const sourceIsArray = sourceNode ? nodeIsArrayNode(sourceNode) : false;
      const targetIsArray = targetNode ? nodeIsArrayNode(targetNode) : false;
      // Ports synthesized from procedural code (register/mux ports built from
      // always_ff/case blocks) don't always carry a reliable width of their
      // own, so thickness is derived from the edge (both endpoints) rather
      // than the local port alone.
      const thick = edgeIsThick(edge, sourceNode, targetNode);
      if (sourceIsArray) {
        addArrayConnection(edge.source, { portId: edge.sourcePort, role: 'source', thick });
        addArrayConnection(edge.target, { portId: edge.targetPort, role: 'target', thick });
      }
      if (targetIsArray) {
        addArrayConnection(edge.target, { portId: edge.targetPort, role: 'target', thick });
      }
    });
    dynamicCutLabelIdsByOwnerRef.current = dynamicCutLabelIdsByOwner;

    const reselectIds = pendingReselectIdsRef.current;
    pendingReselectIdsRef.current = null;
    const baseNodes: HdlFlowNode[] = view.nodes.map((node) => ({
      id: node.id,
      type: 'hdl',
      position: node.position,
      selected: reselectIds?.has(node.id) ?? undefined,
      className: generateStateClass(node.metadata?.generateActiveState, 'generate-node'),
      zIndex: nodeIsArrayNode(node) ? ARRAY_NODE_Z_INDEX : BLOCK_NODE_Z_INDEX,
      data: {
        node,
        moduleName: view.moduleName,
        arrayConnections: arrayConnectionsByNode.get(node.id) ?? [],
      },
    }));
    const baseRegions = view.generateRegions ?? [];

    const netToLeader = new Map<string, string>();
    const edgesByNet = new Map<string, string[]>();

    view.edges.forEach((edge) => {
      const netKey = edgeNetKey(edge);
      const list = edgesByNet.get(netKey) || [];
      list.push(edge.id);
      edgesByNet.set(netKey, list);
    });

    edgesByNet.forEach((ids, netKey) => {
      netToLeader.set(netKey, ids.sort()[0]);
    });

    const sortedEdges = [...view.edges].sort(compareEdgePaintOrder);
    const baseEdges: Edge[] = sortedEdges.map((edge) => {
      const netKey = edgeNetKey(edge);
      const isNetLeader = netToLeader.get(netKey) === edge.id;
      const netEdgeIds = Array.from(edgesByNet.get(netKey) || []);

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        label: edge.label,
        type: 'svsch',
        className: generateStateClass(edge.metadata?.generateActiveState, 'generate-edge'),
        zIndex: edge.metadata?.cutStub ? CUT_STUB_EDGE_Z_INDEX : EDGE_Z_INDEX,
        data: {
          waypoint: edge.waypoint,
          routePoints: edge.routePoints,
          onRouteChange: handleRouteChange,
          edge,
          moduleName: view.moduleName,
          isNetLeader,
          netEdgeIds,
        },
      };
    });

    // Reattach every currently-expanded instance's spliced content on top of
    // the freshly-rebuilt base — see spliceMapRef's declaration for why this
    // is a cheap reattach (translate + merge) rather than a re-fetch/re-layout.
    const merged = applyActiveSplices(
      baseNodes,
      baseEdges,
      baseRegions,
      spliceMapRef.current,
      view.moduleName,
    );
    setNodes(merged.nodes);
    setRegions(merged.regions);
    setEdges(merged.edges);
  }, [handleRouteChange, setEdges, view, spliceVersion]);

  const updateNodeInternals = useStore((s) => s.updateNodeInternals);

  // React Flow only learns a node's handle positions (and therefore whether an edge
  // can be drawn at all) from a ResizeObserver callback that fires on its own,
  // browser-scheduled timing after the node's DOM mounts. Under a busy/CPU-starved
  // renderer that callback can be delayed well beyond a single frame, during which
  // no `.react-flow__edge` element exists even though our node/edge data is already
  // complete. Since node/handle geometry is already valid the instant the DOM commits
  // (layout doesn't require a paint), measure it ourselves synchronously in a layout
  // effect — calling the same internal update the ResizeObserver would — instead of
  // waiting for that observer to get a turn.
  useLayoutEffect(() => {
    if (nodes.length === 0) return;
    const nodeElems = document.querySelectorAll('.react-flow__node');
    if (nodeElems.length === 0) return;
    const elementById = new Map<string, Element>();
    nodeElems.forEach((el) => {
      const id = el.getAttribute('data-id');
      if (id) elementById.set(id, el);
    });
    const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: boolean }>();
    nodes.forEach((node) => {
      const el = elementById.get(node.id);
      if (el) updates.set(node.id, { id: node.id, nodeElement: el as HTMLDivElement, force: true });
    });
    if (updates.size > 0) {
      updateNodeInternals(updates);
    }
  }, [nodes, updateNodeInternals]);

  useEffect(() => {
    if (!view || nodes.length === 0) {
      return;
    }

    const nodesMatchView =
      nodes.length === view.nodes.length &&
      nodes.every((node) => node.data?.moduleName === view.moduleName);

    if (!nodesMatchView || fittedModuleNameRef.current === view.moduleName) {
      return;
    }

    const timeout = window.setTimeout(() => {
      reactFlow.fitView({ padding: 0.2 });
      fittedModuleNameRef.current = view.moduleName;
    }, 0);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [nodes, reactFlow, view]);

  const onNodeDragStart = useCallback(
    (_: React.MouseEvent, dragged: HdlFlowNode, allNodes: HdlFlowNode[]) => {
      // Dragging an unselected node drops the node selection (React Flow behavior);
      // drop the region selection with it.
      if (!dragged.selected) clearRegionSelection();
      const movedIds = new Set(allNodes.map((n) => n.id));
      // Dragging an expanded instance's dimmed node carries its whole spliced
      // subtree (see onNodesChange's spliceFollowers) — count those members
      // as moved too, so their internal wires' saved routes translate rigidly
      // with the drag exactly like a multi-select group's do. Fixpoint loop:
      // a carried member can itself be a nested expanded instance.
      let grew = true;
      while (grew) {
        grew = false;
        for (const splice of spliceMapRef.current.values()) {
          if (!movedIds.has(splice.flowInstanceId)) continue;
          for (const memberId of splice.region.nodeIds) {
            if (!movedIds.has(memberId)) {
              movedIds.add(memberId);
              grew = true;
            }
          }
        }
      }
      if (movedIds.size < 2 && !(dragged.selected && selectedRegionIds.size > 0)) return;
      const originalRoutes = new Map<string, Array<{ x: number; y: number }>>();
      for (const e of edges) {
        const pts = e.data?.routePoints as Array<{ x: number; y: number }> | undefined;
        if (movedIds.has(e.source) && movedIds.has(e.target) && pts && pts.length > 0) {
          originalRoutes.set(
            e.id,
            pts.map((pt) => ({ ...pt })),
          );
        }
      }
      groupDragRef.current = {
        startPos: { x: dragged.position.x, y: dragged.position.y },
        originalRoutes,
        startRegions: regionsRef.current.map((region) => ({
          ...region,
          bounds: { ...region.bounds },
        })),
      };
    },
    [edges, clearRegionSelection, selectedRegionIds],
  );

  const onNodeDrag = useCallback(
    (_: React.MouseEvent, dragged: HdlFlowNode, allNodes: HdlFlowNode[] = [dragged]) => {
      const movedNodes = allNodes.length > 0 ? allNodes : [dragged];
      const allFlowNodes = mergeDraggedFlowNodes(reactFlow.getNodes() as HdlFlowNode[], movedNodes);
      const positioned = flowNodesToPositioned(
        allFlowNodes,
        new Set(movedNodes.map((node) => node.id)),
      );
      const state = groupDragRef.current;
      const dx = state ? dragged.position.x - state.startPos.x : 0;
      const dy = state ? dragged.position.y - state.startPos.y : 0;
      setRegions((current) => {
        const base =
          state && dragged.selected && selectedRegionIds.size > 0
            ? translateRegions(state.startRegions, selectedRegionIds, dx, dy)
            : current;
        return expandRegionsForNodes(base, positioned);
      });

      if (!state || state.originalRoutes.size === 0) return;
      const changes = Array.from(state.originalRoutes.entries()).map(([edgeId, pts]) => ({
        edgeId,
        routePoints: pts.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
      }));
      handleRouteChange(changes, false);
    },
    [handleRouteChange, reactFlow, selectedRegionIds],
  );

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, dragged: HdlFlowNode, allNodes: HdlFlowNode[]) => {
      if (!view) {
        return;
      }
      const movedNodes = allNodes.length > 0 ? allNodes : [dragged];
      const allFlowNodes = mergeDraggedFlowNodes(reactFlow.getNodes() as HdlFlowNode[], movedNodes);
      const fixedIds = new Set(movedNodes.map((node) => node.id));
      fixedIds.add(dragged.id);
      const positioned = flowNodesToPositioned(allFlowNodes, fixedIds);
      const state = groupDragRef.current;
      groupDragRef.current = null;
      const dx = state ? dragged.position.x - state.startPos.x : 0;
      const dy = state ? dragged.position.y - state.startPos.y : 0;
      const translatesRegions = Boolean(state) && dragged.selected && selectedRegionIds.size > 0;
      const baseRegions =
        translatesRegions && state
          ? translateRegions(state.startRegions, selectedRegionIds, dx, dy)
          : regionsRef.current;
      const expandedRegions = expandRegionsForNodes(baseRegions, positioned).map((region) =>
        translatesRegions && selectedRegionIds.has(region.id) ? { ...region, fixed: true } : region,
      );
      setRegions(expandedRegions);
      vscode.postMessage({
        type: 'layoutChanged',
        moduleName: view.moduleName,
        nodes: stripExpandSplices(positioned, spliceMapRef.current),
        regions: stripExpandRegions(expandedRegions),
      });
      if (spliceMapRef.current.size > 0) {
        syncSpliceCache(spliceMapRef.current, allFlowNodes, expandedRegions, reactFlow.getEdges());
      }

      if (!state || state.originalRoutes.size === 0) return;

      if (dx === 0 && dy === 0) return;

      const changes = Array.from(state.originalRoutes.entries()).map(([edgeId, pts]) => ({
        edgeId,
        routePoints: pts.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
      }));
      handleRouteChange(changes, true);
    },
    [view, handleRouteChange, reactFlow, selectedRegionIds],
  );

  // Grow-only block resize (instance/register nodes) — same custom
  // pointer-drag pattern as GenerateRegionOverlay's region resize below, just
  // scoped to one node's size instead of a region's bounds. Lives here rather
  // than inside HdlNode because a resize can grow the node past its
  // containing generate-region's current bounds, which needs the same
  // `regions` state (and `expandRegionsForFlowNodes`) node-drag already uses
  // for that live auto-grow. HdlNode only renders the handle hit-zones and
  // calls startNodeResize (via InteractionContext) on pointerdown.
  const nodeResizeDragRef = useRef<NodeResizeDragState | null>(null);

  const startNodeResize = useCallback(
    (event: React.PointerEvent, nodeId: string, handle: NodeResizeHandle) => {
      event.preventDefault();
      event.stopPropagation();
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const canonical = diagramNodeDimensions(node.data.node);
      const resolved = resolvedNodeDimensions(node.data.node);
      nodeResizeDragRef.current = {
        nodeId,
        handle,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPosition: { ...node.position },
        startWidth: resolved.width,
        startHeight: resolved.height,
        canonicalWidth: canonical.width,
        canonicalHeight: canonical.height,
        startNodes: nodes.map((n) => ({
          ...n,
          position: { ...n.position },
          data: { ...n.data, node: { ...n.data.node } },
        })),
        startRegions: regionsRef.current.map((region) => ({
          ...region,
          bounds: { ...region.bounds },
        })),
      };
    },
    [nodes],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = nodeResizeDragRef.current;
      if (!drag) return;
      const update = applyNodeResizeDrag(drag, event.clientX, event.clientY, viewport.zoom || 1);
      setNodes(update.nodes);
      setRegions(update.regions);
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = nodeResizeDragRef.current;
      if (!drag) return;
      nodeResizeDragRef.current = null;
      const update = applyNodeResizeDrag(drag, event.clientX, event.clientY, viewport.zoom || 1);
      setNodes(update.nodes);
      setRegions(update.regions);

      // A zero-delta drag is just a click on a handle — don't pin the node
      // (and its size) fixed for a no-op, same rule GenerateRegionOverlay
      // applies to region resize.
      const zoom = Math.max(viewport.zoom || 1, 0.01);
      const dx = snapDelta((event.clientX - drag.startClientX) / zoom);
      const dy = snapDelta((event.clientY - drag.startClientY) / zoom);
      if (dx === 0 && dy === 0) return;

      if (!view) return;

      // This commit can never be resizing an expanded instance's frame —
      // HdlNode doesn't render resize handles for one (see
      // NodeResizeControls's call site) — so it's always a plain top-level
      // instance/register resize; syncSpliceCache below only re-syncs any
      // *other* active splices' bookkeeping (region bounds etc.) that this
      // node's own regrow may have shifted.
      const positioned = flowNodesToPositioned(update.nodes, new Set([drag.nodeId]));
      vscode.postMessage({
        type: 'layoutChanged',
        moduleName: view.moduleName,
        nodes: stripExpandSplices(positioned, spliceMapRef.current),
        regions: stripExpandRegions(update.regions),
      });
      if (spliceMapRef.current.size > 0) {
        syncSpliceCache(spliceMapRef.current, update.nodes, update.regions);
      }

      // React Flow's own dimension tracking (node.measured, read by
      // OrthogonalEdge for handle geometry) is normally kept in sync by the
      // updateNodeInternals layout effect above, which re-fires on every one
      // of the many setNodes calls a multi-step drag produces. Under that
      // flurry of back-to-back forced updates for the same element, React
      // Flow's internal store can drop the very last one and leave
      // node.measured on a stale pre-resize size indefinitely — more likely
      // the slower a node is to render (e.g. a stacked/array instance with
      // extra port/parameter layers), which widens the window for calls to
      // overlap. Requesting one more update once the drag's call flurry has
      // drained (and the DOM has already settled on its final size) gives
      // the store an uncontested chance to catch up.
      requestAnimationFrame(() => {
        const el = document.querySelector(`.react-flow__node[data-id="${drag.nodeId}"]`);
        if (el) {
          updateNodeInternals(
            new Map([
              [drag.nodeId, { id: drag.nodeId, nodeElement: el as HTMLDivElement, force: true }],
            ]),
          );
        }
      });
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [setNodes, setEdges, setRegions, view, viewport.zoom, updateNodeInternals]);

  const rerouteLayout = useCallback(() => {
    if (!view) {
      return;
    }
    const positioned = stripExpandSplices(
      nodes.map((node) => ({
        ...node.data.node,
        position: node.position,
        // "Reroute All" freezes every real block in place — a net-cut label
        // that's still tracking its port dynamically must not be forced fixed
        // just because it happened to be on screen.
        fixed: node.data.node.kind === 'netLabel' ? node.data.node.fixed : true,
      })),
      spliceMapRef.current,
    );
    vscode.postMessage({ type: 'rerouteLayout', moduleName: view.moduleName, nodes: positioned });
  }, [nodes, view]);

  // Equivalent to marquee-selecting every block and clicking the floating
  // selection toolbar's "Auto Layout" — releases every real block (net-cut
  // labels excluded, same filter the selection toolbar applies) for one ELK
  // pass using current positions as placement hints.
  const autoLayoutAll = useCallback(() => {
    if (!view) {
      return;
    }
    const releasedIds = new Set(
      nodes.filter((node) => node.data.node.kind !== 'netLabel').map((node) => node.id),
    );
    const positioned = buildRelayoutPositionedNodes(nodes, releasedIds);
    vscode.postMessage({
      type: 'relayoutSelection',
      moduleName: view.moduleName,
      nodeIds: [...releasedIds],
      nodes: positioned,
    });
  }, [nodes, view]);

  const nodeTypes = useMemo(() => ({ hdl: HdlNode }), []);
  const edgeTypes = useMemo(() => ({ svsch: OrthogonalEdge }), []);
  const diagramStyle = useMemo(
    () =>
      ({
        '--svsch-grid': `${diagramSizing.gridSize}px`,
        '--svsch-node-width': `${diagramSizing.nodeWidth}px`,
        '--svsch-node-height': `${diagramSizing.nodeHeight}px`,
        '--svsch-node-header-height': `${diagramSizing.nodeHeaderHeight}px`,
        '--svsch-port-width': `${diagramSizing.portWidth}px`,
        '--svsch-port-height': `${diagramSizing.portHeight}px`,
        '--svsch-port-skin-height': `${diagramSizing.portSkinHeight}px`,
        '--svsch-port-nose-length': `${diagramSizing.portNoseLength}px`,
        '--svsch-handle-offset': '-7px',
      }) as React.CSSProperties,
    [],
  );

  const interactionValue = useMemo(
    () => ({
      hoveredNetKey,
      setHovered,
      hoveredEdgeId,
      setHoveredEdgeId,
      selectionHoverActive,
      setSelectionHoverActive,
      pendingSelectionAction,
      setPendingSelectionAction,
      overlayPortalNode,
      startNodeResize,
    }),
    [
      hoveredNetKey,
      setHovered,
      hoveredEdgeId,
      selectionHoverActive,
      pendingSelectionAction,
      overlayPortalNode,
      startNodeResize,
    ],
  );

  if (!view) {
    return <div className="empty">Building diagram...</div>;
  }

  return (
    <div className="shell" style={diagramStyle}>
      <header className="toolbar">
        <select
          className="vscode-control vscode-select"
          aria-label="Module"
          value={view.moduleName}
          onChange={(event) =>
            vscode.postMessage({ type: 'openModule', moduleName: event.target.value })
          }
        >
          {modules.map((moduleName) => (
            <option key={moduleName} value={moduleName}>
              {moduleName}
            </option>
          ))}
        </select>
        <button
          className="vscode-control vscode-button vscode-button-secondary"
          onClick={() => vscode.postMessage({ type: 'exportSvg' })}
        >
          Export SVG
        </button>
        <button
          className="vscode-control vscode-button vscode-button-secondary"
          onClick={rerouteLayout}
        >
          Reroute All
        </button>
        <button
          className="vscode-control vscode-button vscode-button-secondary"
          onClick={autoLayoutAll}
        >
          Auto Layout All
        </button>
        <button
          className="vscode-control vscode-button"
          onClick={() => vscode.postMessage({ type: 'resetLayout', moduleName: view.moduleName })}
        >
          Reset Layout
        </button>
        <div className="status-indicator">
          {status === 'rebuilding' ? (
            <div className="busy-indicator" role="status" aria-live="polite">
              <span />
              Updating
            </div>
          ) : view.diagnostics.length > 0 ? (
            <div className="diagnostics-indicator" role="status">
              <span aria-hidden="true">⚠</span>
              {view.diagnostics.length} warning{view.diagnostics.length === 1 ? '' : 's'}
            </div>
          ) : null}
        </div>
      </header>
      <main className="canvas" key={view.moduleName}>
        <ModuleParameterTable moduleName={view.moduleName} parameters={view.parameters} />
        <InteractionContext.Provider value={interactionValue}>
          <LineJumpProvider>
            <ReactFlow<HdlFlowNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onSelectionDragStart={(event: React.MouseEvent, dragNodes: HdlFlowNode[]) => {
                if (dragNodes.length > 0) onNodeDragStart(event, dragNodes[0], dragNodes);
              }}
              onSelectionDrag={(event: React.MouseEvent, dragNodes: HdlFlowNode[]) => {
                if (dragNodes.length > 0) onNodeDrag(event, dragNodes[0], dragNodes);
              }}
              onSelectionDragStop={(event: React.MouseEvent, dragNodes: HdlFlowNode[]) => {
                if (dragNodes.length > 0) onNodeDragStop(event, dragNodes[0], dragNodes);
              }}
              onSelectionStart={handleSelectionStart}
              onSelectionEnd={handleSelectionEnd}
              onEdgeMouseEnter={onEdgeMouseEnter}
              onEdgeMouseLeave={onEdgeMouseLeave}
              onEdgeClick={(event: React.MouseEvent, _edge: Edge) => {
                event.stopPropagation();
              }}
              onEdgeDoubleClick={(event: React.MouseEvent, edge: Edge) => {
                if (edge.data?.edge) {
                  const msg = { type: 'navigateToSignal', edge: edge.data.edge };
                  console.log('NAVIGATE:', JSON.stringify(msg));
                  vscode.postMessage(msg);
                }
              }}
              onInit={(instance: any) => {
                (window as any).reactFlowInstance = instance;
                setViewport(instance.getViewport?.() ?? { x: 0, y: 0, zoom: 1 });
              }}
              onMove={(_: unknown, nextViewport: FlowViewport) => setViewport(nextViewport)}
              nodesConnectable={false}
              deleteKeyCode={null}
              selectionOnDrag
              panOnDrag={[1, 2]}
              zoomOnDoubleClick={false}
              onDoubleClick={handleCanvasDoubleClick}
              onPaneClick={clearRegionSelection}
              onNodeClick={clearRegionSelection}
              selectionMode="partial"
              snapToGrid
              snapGrid={[diagramSizing.gridSize, diagramSizing.gridSize]}
              zIndexMode="manual"
              proOptions={{ hideAttribution: true }}
              minZoom={0.05}
            >
              <Background gap={diagramSizing.gridSize} />
              <ViewportPortal>
                <GenerateRegionOverlay
                  moduleName={view.moduleName}
                  regions={regions}
                  nodes={nodes}
                  edges={edges}
                  viewport={viewport}
                  setNodes={setNodes}
                  setRegions={setRegions}
                  onRouteChange={handleRouteChange}
                  selectedRegionIds={selectedRegionIds}
                  selectRegion={selectRegion}
                  spliceMapRef={spliceMapRef}
                />
              </ViewportPortal>
              {/* Rendered as a plain react-flow child (like MiniMap/Controls below), not
                    through ViewportPortal — that portal is shared with GenerateRegionOverlay
                    above, which must stay beneath node bodies, while floating controls like
                    the selection toolbar need to paint above them. Its own inline transform
                    (see the style prop) reproduces react-flow's pan/zoom so flow-space
                    coordinates still work for anything portaled into it. */}
              <div
                ref={setOverlayPortalNode}
                className="svsch-overlay-portal-root"
                style={{
                  transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                }}
              />
              <NodeSelectionToolbar
                moduleName={view.moduleName}
                nodes={nodes}
                edges={edges}
                pendingReselectIdsRef={pendingReselectIdsRef}
                zoom={viewport.zoom}
                onExpandInstance={requestExpand}
                onCollapseInstance={handleCollapseRegion}
                spliceMapRef={spliceMapRef}
              />
              <MiniMap pannable zoomable className="svsch-minimap" nodeComponent={MiniMapNode} />
              <MiniMapRegionOutlines regions={regions} />
              <Controls />
            </ReactFlow>
          </LineJumpProvider>
        </InteractionContext.Provider>
      </main>
    </div>
  );
}

type RegionDragSide = 'left' | 'right' | 'top' | 'bottom';

interface RegionDragState {
  kind: 'move' | 'resize';
  regionId: string;
  side?: RegionDragSide;
  startClientX: number;
  startClientY: number;
  startRegions: PositionedGenerateRegion[];
  startNodes: HdlFlowNode[];
  affectedRegionIds: Set<string>;
  affectedNodeIds: Set<string>;
  // Route waypoints of edges internal to the moved arm, captured at drag start so
  // they can be translated together with the blocks they connect.
  startRoutes: Map<string, Array<{ x: number; y: number }>>;
}

interface NodeResizeDragState {
  nodeId: string;
  handle: NodeResizeHandle;
  startClientX: number;
  startClientY: number;
  startPosition: { x: number; y: number };
  // Resolved (on-screen) size at drag start — the drag grows/shrinks from here.
  startWidth: number;
  startHeight: number;
  // Grow-only floor — this node's canonical auto-fit size, independent of any
  // override already in effect at drag start.
  canonicalWidth: number;
  canonicalHeight: number;
  startNodes: HdlFlowNode[];
  startRegions: PositionedGenerateRegion[];
}

// Pure geometry step for a node-resize drag: same shape as applyRegionDrag's
// 'resize' branch, but for exactly one node's position+size instead of a
// region's bounds. Recomputed from the drag-start snapshot each call (not
// incrementally) so pointermove and the final pointerup commit agree exactly.
function applyNodeResizeDrag(
  drag: NodeResizeDragState,
  clientX: number,
  clientY: number,
  zoom: number,
): { nodes: HdlFlowNode[]; regions: PositionedGenerateRegion[] } {
  const dx = snapDelta((clientX - drag.startClientX) / Math.max(zoom, 0.01));
  const dy = snapDelta((clientY - drag.startClientY) / Math.max(zoom, 0.01));
  const { position, width, height } = resizeNodeBounds(drag, dx, dy);
  const grid = diagramSizing.gridSize;

  const nodes = drag.startNodes.map((node) => {
    if (node.id !== drag.nodeId) return node;
    return {
      ...node,
      position,
      data: {
        ...node.data,
        node: {
          ...node.data.node,
          position,
          sizeOverride: { width: width / grid, height: height / grid },
        },
      },
    };
  });

  return {
    nodes,
    regions: expandRegionsForFlowNodes(drag.startRegions, nodes),
  };
}

function resizeNodeBounds(
  drag: NodeResizeDragState,
  dx: number,
  dy: number,
): { position: { x: number; y: number }; width: number; height: number } {
  const includesLeft = drag.handle.includes('left');
  const includesRight = drag.handle.includes('right');
  const includesTop = drag.handle.includes('top');
  const includesBottom = drag.handle.includes('bottom');

  let width = drag.startWidth;
  let height = drag.startHeight;
  let x = drag.startPosition.x;
  let y = drag.startPosition.y;

  if (includesRight) {
    width = Math.max(drag.canonicalWidth, drag.startWidth + dx);
  } else if (includesLeft) {
    width = Math.max(drag.canonicalWidth, drag.startWidth - dx);
    x = drag.startPosition.x + (drag.startWidth - width);
  }

  if (includesBottom) {
    height = Math.max(drag.canonicalHeight, drag.startHeight + dy);
  } else if (includesTop) {
    height = Math.max(drag.canonicalHeight, drag.startHeight - dy);
    y = drag.startPosition.y + (drag.startHeight - height);
  }

  return { position: { x, y }, width, height };
}

function GenerateRegionOverlay({
  moduleName,
  regions,
  nodes,
  edges,
  viewport,
  setNodes,
  setRegions,
  onRouteChange,
  selectedRegionIds,
  selectRegion,
  spliceMapRef,
}: {
  moduleName: string;
  regions: PositionedGenerateRegion[];
  nodes: HdlFlowNode[];
  edges: Edge[];
  viewport: FlowViewport;
  setNodes: (nodes: HdlFlowNode[] | ((nodes: HdlFlowNode[]) => HdlFlowNode[])) => void;
  setRegions: React.Dispatch<React.SetStateAction<PositionedGenerateRegion[]>>;
  onRouteChange: (changes: RouteChange[], commit: boolean) => void;
  selectedRegionIds: Set<string>;
  selectRegion: (regionId: string) => void;
  spliceMapRef: React.MutableRefObject<Map<string, ActiveSplice>>;
}): React.ReactElement | null {
  const dragRef = useRef<RegionDragState | null>(null);

  const startDrag = useCallback(
    (
      event: React.PointerEvent,
      region: PositionedGenerateRegion,
      kind: RegionDragState['kind'],
      side?: RegionDragSide,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      // Interacting with a selected region moves the whole selection; interacting with
      // an unselected one selects just it (mirrors React Flow's node behavior — a
      // click or drag highlights the region with the standard selection border).
      const moveRoots =
        kind === 'move' && selectedRegionIds.has(region.id) ? [...selectedRegionIds] : [region.id];
      if (!selectedRegionIds.has(region.id)) selectRegion(region.id);
      const affectedRegionIds =
        kind === 'move'
          ? new Set(moveRoots.flatMap((rootId) => [...descendantRegionIds(rootId, regions, true)]))
          : new Set([region.id]);
      const affectedNodeIds =
        kind === 'move' ? nodeIdsForRegions(affectedRegionIds, regions) : new Set<string>();
      // A moved region may contain an expanded instance's dimmed node — carry
      // that instance's entire spliced subtree along (its expand region has no
      // rendered frame of its own; the node is the frame). Fixpoint loop:
      // a carried member can itself be a nested expanded instance.
      if (kind === 'move') {
        let grew = true;
        while (grew) {
          grew = false;
          for (const splice of spliceMapRef.current.values()) {
            if (!affectedNodeIds.has(splice.flowInstanceId)) continue;
            for (const memberId of splice.region.nodeIds) {
              if (!affectedNodeIds.has(memberId)) {
                affectedNodeIds.add(memberId);
                grew = true;
              }
            }
          }
        }
      }
      const startRoutes = new Map<string, Array<{ x: number; y: number }>>();
      if (kind === 'move') {
        for (const edge of edges) {
          const pts = edge.data?.routePoints as Array<{ x: number; y: number }> | undefined;
          if (
            affectedNodeIds.has(edge.source) &&
            affectedNodeIds.has(edge.target) &&
            pts &&
            pts.length > 0
          ) {
            startRoutes.set(
              edge.id,
              pts.map((pt) => ({ ...pt })),
            );
          }
        }
      }
      dragRef.current = {
        kind,
        regionId: region.id,
        side,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRegions: regions.map((item) => ({ ...item, bounds: { ...item.bounds } })),
        startNodes: nodes.map((node) => ({
          ...node,
          position: { ...node.position },
          data: {
            ...node.data,
            node: { ...node.data.node, position: { ...node.data.node.position } },
          },
        })),
        affectedRegionIds,
        affectedNodeIds,
        startRoutes,
      };
    },
    [edges, nodes, regions, selectedRegionIds, selectRegion],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const update = applyRegionDrag(drag, event.clientX, event.clientY, viewport.zoom || 1);
      setRegions(update.regions);
      setNodes(update.nodes);
      applyRegionDragRoutes(
        drag,
        event.clientX,
        event.clientY,
        viewport.zoom || 1,
        onRouteChange,
        false,
      );
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      const zoom = Math.max(viewport.zoom || 1, 0.01);
      const update = applyRegionDrag(drag, event.clientX, event.clientY, viewport.zoom || 1);
      setRegions(update.regions);
      setNodes(update.nodes);

      // A zero-delta drag is just a (double-)click on the title or a handle — don't
      // commit it, or the region's auto-laid-out nodes would be pinned as fixed and
      // the rest of the diagram would reflow around them.
      const dx = snapDelta((event.clientX - drag.startClientX) / zoom);
      const dy = snapDelta((event.clientY - drag.startClientY) / zoom);
      if (dx === 0 && dy === 0) return;

      const fixedRegions = update.regions.map((region) => ({
        ...region,
        fixed: region.fixed || drag.affectedRegionIds.has(region.id),
      }));

      if (spliceMapRef.current.size > 0) {
        syncSpliceCache(spliceMapRef.current, update.nodes, fixedRegions);
      }

      if (drag.kind === 'resize') {
        vscode.postMessage({
          type: 'regionLayoutChanged',
          moduleName,
          regions: stripExpandRegions(fixedRegions),
        });
        return;
      }

      const positioned = flowNodesToPositioned(update.nodes, drag.affectedNodeIds);
      vscode.postMessage({
        type: 'layoutChanged',
        moduleName,
        nodes: stripExpandSplices(positioned, spliceMapRef.current),
        regions: stripExpandRegions(fixedRegions),
      });
      applyRegionDragRoutes(
        drag,
        event.clientX,
        event.clientY,
        viewport.zoom || 1,
        onRouteChange,
        true,
      );
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [moduleName, onRouteChange, setNodes, setRegions, viewport.zoom]);

  if (regions.length === 0) return null;

  return (
    <div className="generate-region-layer">
      {[...regions]
        // An "Expand instance in place" region is pure machinery (membership
        // for drag-carry and nesting) — the expanded instance's own enlarged
        // node is its visible frame, so it never renders an outline, label,
        // or resize handles of its own (see expandOverlay's dimAsExpandGhost).
        .filter((region) => region.kind !== 'expand')
        .sort((a, b) => (a.isGenerateBlock ? 0 : 1) - (b.isGenerateBlock ? 0 : 1))
        .map((region) => (
          <div
            key={region.id}
            className={[
              'generate-region',
              region.isGenerateBlock ? 'generate-block' : '',
              region.activeState === 'active' ? 'generate-region-active' : '',
              region.activeState === 'inactive' ? 'generate-region-inactive' : '',
              region.invalid ? 'generate-region-invalid' : '',
              selectedRegionIds.has(region.id) ? 'generate-region-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            data-region-id={region.id}
            data-region-kind={region.kind}
            data-warning-note={region.warningNote || undefined}
            style={{
              left: region.bounds.x,
              top: region.bounds.y,
              width: region.bounds.width,
              height: region.bounds.height,
            }}
          >
            <div className="generate-region-outline" />
            {region.warningNote && (
              <Tooltip content={region.warningNote}>
                {(trigger) => (
                  <span
                    {...trigger}
                    className="generate-region-warning"
                    role="img"
                    aria-label={region.warningNote}
                  >
                    ⚠
                  </span>
                )}
              </Tooltip>
            )}
            <button
              type="button"
              className="generate-region-title"
              onPointerDown={(event) => startDrag(event, region, 'move')}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={() => {
                const msg = {
                  type: 'navigateToRegion',
                  region: {
                    kind: region.kind,
                    isGenerateBlock: region.isGenerateBlock,
                    source: region.source,
                    bodySource: region.bodySource,
                  },
                } as const;
                console.log('NAVIGATE:', JSON.stringify(msg));
                vscode.postMessage(msg);
              }}
              title={region.label}
            >
              {region.label}
            </button>
            {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
              <button
                key={side}
                type="button"
                aria-label={`Resize ${region.label} ${side}`}
                className={`generate-region-resize generate-region-resize-${side}`}
                onPointerDown={(event) => startDrag(event, region, 'resize', side)}
                onClick={(event) => event.stopPropagation()}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

// Every non-cut-stub edge touching any selected non-netLabel block — shared
// by the block-selection toolbar's "Cut out" button and the `c` keyboard
// shortcut's block-selection fallback, since a cut stub's dangling end can't
// be cut again.
function cutOutEdgesForSelection(nodes: HdlFlowNode[], edges: Edge[]): Edge[] {
  // Spliced-in expand content (see webview/expand) isn't real module IR the
  // extension host knows about — Cut out (like Auto Layout/Revert Size
  // below) only applies to genuine blocks in the currently open module.
  const selectedIds = new Set(
    nodes
      .filter(
        (node) =>
          node.selected && node.data.node.kind !== 'netLabel' && !isExpandNamespacedId(node.id),
      )
      .map((node) => node.id),
  );
  if (selectedIds.size === 0) return [];
  return edges.filter((edge) => {
    if (!selectedIds.has(edge.source) && !selectedIds.has(edge.target)) return false;
    const diagramEdge = (edge.data as { edge?: DiagramEdge } | undefined)?.edge;
    return diagramEdge !== undefined && diagramEdge.metadata?.cutStub === undefined;
  });
}

// Floating toolbar shown above the bounding box of a block selection. "Auto
// Layout" only makes sense once there's more than one block to re-place, while
// "Revert Size" and "Cut out" can apply to a lone selected block.
//
// Auto Layout: releases just the selected blocks (and the routes of any edge
// touching one of them) back to ELK's auto-layout — using their current
// positions as placement hints, so they tend to settle nearby unless the area
// is genuinely congested — while every other block and edge in the diagram
// stays exactly where it is (they're sent back fixed, the same freezing
// mergeRerouteLayout already relies on for "Reroute All").
//
// Portals into overlayPortalNode rather than rendering inline: it needs to
// paint above node bodies, but it's positioned in flow-space (bounds.right/
// bottom), so it still needs the pan/zoom transform a raw fixed-position
// overlay wouldn't have. overlayPortalNode carries that transform itself
// (see main.tsx's render) instead of react-flow's ViewportPortal, which is
// reserved for GenerateRegionOverlay — that overlay's translucent region
// fill must stay beneath nodes, so it can't share a stacking tier with a
// control that needs the opposite.
function NodeSelectionToolbar({
  moduleName,
  nodes,
  edges,
  pendingReselectIdsRef,
  zoom,
  onExpandInstance,
  onCollapseInstance,
  spliceMapRef,
}: {
  moduleName: string;
  nodes: HdlFlowNode[];
  edges: Edge[];
  pendingReselectIdsRef: React.MutableRefObject<Set<string> | null>;
  zoom: number;
  onExpandInstance: (instanceNode: HdlFlowNode) => void;
  /**
   * Collapses an "Expand instance in place" region (see issue #232) — a
   * no-op for a real generate region id.
   */
  onCollapseInstance: (regionId: string) => void;
  spliceMapRef: React.MutableRefObject<Map<string, ActiveSplice>>;
}): React.ReactElement | null {
  const { overlayPortalNode } = useContext(InteractionContext);
  // overlayPortalNode carries react-flow's scale(zoom) (see main.tsx's render), so button
  // markup here needs a counter-scale to stay a constant screen size instead of zooming
  // with the canvas — the outer .svsch-selection-toolbar keeps its flow-space position.
  const counterScale = 1 / Math.max(zoom || 1, 0.01);

  // A cut net's dangling end is a synthetic `netLabel` node, not a real block —
  // selecting (or merely clicking through to) one shouldn't surface a toolbar
  // whose actions only make sense for actual block selections.
  const selectedBlocks = useMemo(
    () => nodes.filter((node) => node.selected && node.data.node.kind !== 'netLabel'),
    [nodes],
  );
  // Spliced-in expand content (see webview/expand) isn't real module IR the
  // extension host knows about — every action except Expand/Collapse only
  // applies to genuine blocks of the currently open module, so those actions
  // work off this narrowed set (see cutOutEdgesForSelection for the same
  // rule on the wire side).
  const selected = useMemo(
    () => selectedBlocks.filter((node) => !isExpandNamespacedId(node.id)),
    [selectedBlocks],
  );

  // Same exclusion `selectedCuttableEdges` in OrthogonalEdge applies for the
  // wire "Cut" control — see cutOutEdgesForSelection.
  const cutOutEdges = useMemo(() => cutOutEdgesForSelection(nodes, edges), [nodes, edges]);

  // An expanded instance's node carries the splice's computed expanded size
  // as an injected sizeOverride (see expandOverlay's dimAsExpandGhost) —
  // that's not a manual resize, so it must not surface "Revert Size".
  const resizedNodeIds = useMemo(() => {
    const ghostIds = new Set(
      [...spliceMapRef.current.values()].map((splice) => splice.flowInstanceId),
    );
    return selected
      .filter((node) => node.data.node.sizeOverride !== undefined && !ghostIds.has(node.id))
      .map((node) => node.id);
  }, [selected, spliceMapRef]);

  // "Expand instance in place" (issue #232 decision 8, revised in #233): only
  // for a single selected instance node, never a multi-select — and not for
  // array-of-instances nodes (decision 7; #169 tracks that separately). Also
  // excludes any instance living inside an already-expanded splice: nested
  // expand/collapse is only ever done from that instance's own module view,
  // never reached through an ancestor's — so a spliced-in (expand-namespaced)
  // node offers neither control here.
  const singleInstance =
    selectedBlocks.length === 1 &&
    ((selectedBlocks[0].data.node.kind === 'instance' &&
      !nodeIsArrayNode(selectedBlocks[0].data.node)) ||
      selectedBlocks[0].data.node.kind === 'funcCall' ||
      selectedBlocks[0].data.node.kind === 'taskCall') &&
    !isExpandNamespacedId(selectedBlocks[0].id)
      ? selectedBlocks[0]
      : undefined;

  // If the selected instance is already expanded, its splice is keyed by
  // this node's own (non-namespaced, top-level) id — `flowInstanceId` is
  // exactly this node's id in the current `nodes` array (see ActiveSplice's
  // doc).
  const activeSplice = singleInstance
    ? [...spliceMapRef.current.values()].find(
        (splice) => splice.flowInstanceId === singleInstance.id,
      )
    : undefined;
  const expandableInstance = activeSplice ? undefined : singleInstance;

  // Nothing to offer: a lone block with every net already cut and no resize
  // override gets no control, so skip rendering the (now empty) toolbar entirely.
  if (
    !overlayPortalNode ||
    selectedBlocks.length < 1 ||
    (selectedBlocks.length < 2 &&
      cutOutEdges.length === 0 &&
      resizedNodeIds.length === 0 &&
      !expandableInstance &&
      !activeSplice) ||
    (selected.length < 1 && !expandableInstance && !activeSplice)
  ) {
    return null;
  }

  const bounds = (selected.length > 0 ? selected : selectedBlocks).reduce(
    (acc, node) => {
      const size = resolvedNodeDimensions(node.data.node);
      return {
        x: Math.min(acc.x, node.position.x),
        y: Math.min(acc.y, node.position.y),
        right: Math.max(acc.right, node.position.x + size.width),
        bottom: Math.max(acc.bottom, node.position.y + size.height),
      };
    },
    { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
  );

  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    const selectedIds = new Set(selected.map((node) => node.id));
    // A cut net's dangling end is a `netLabel` node that ELK never places
    // directly — it's re-derived every render from the real block's current
    // port position. Releasing the block must release its dangling ends with
    // it, so pull every stub edge's netLabel endpoint into the release set
    // whenever the block on the stub's other end is selected — even when the
    // marquee never physically covered the label (or the stub wire) itself.
    // A netLabel whose block isn't selected is left alone.
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    // An expanded instance's stub edges no longer terminate on the instance
    // id the release set carries — applyActiveSplices rewires them onto the
    // frame's boundary-port nodes (expand-namespaced ids, never in
    // `selected`). Resolve a boundary endpoint back to the top-level
    // instance owning its splice so that instance's cut labels release with
    // it, same as a collapsed block's would.
    const boundaryOwner = new Map<string, string>();
    for (const splice of spliceMapRef.current.values()) {
      if (isExpandNamespacedId(splice.flowInstanceId)) continue;
      for (const boundaryId of splice.boundaryNodeIdByChildPortName.values()) {
        boundaryOwner.set(boundaryId, splice.flowInstanceId);
      }
    }
    for (const edge of edges) {
      const diagramEdge = (edge.data as { edge?: DiagramEdge } | undefined)?.edge;
      if (diagramEdge?.metadata?.cutStub === undefined) continue;
      const endpointIds = [edge.source, edge.target];
      const touchesSelectedBlock = endpointIds.some((endpointId) => {
        const resolvedId = boundaryOwner.get(endpointId) ?? endpointId;
        return (
          selectedIds.has(resolvedId) && nodesById.get(resolvedId)?.data.node.kind !== 'netLabel'
        );
      });
      if (!touchesSelectedBlock) continue;
      for (const endpointId of endpointIds) {
        if (nodesById.get(endpointId)?.data.node.kind === 'netLabel') {
          selectedIds.add(endpointId);
        }
      }
    }
    const positioned = buildRelayoutPositionedNodes(nodes, selectedIds);
    // Consumed (and cleared) the next time the nodes array is rebuilt from an
    // incoming view, so these blocks stay selected across the round-trip
    // instead of losing selection once ELK re-places them.
    pendingReselectIdsRef.current = selectedIds;
    // The host's ELK pass must place blocks against each expanded instance's
    // *frame* size, not the collapsed size the stripped nodes payload
    // carries (the expansion is a webview-only overlay the host's saved
    // layout deliberately never records as a resize) — hand the frame sizes
    // over as transient, layout-only overrides in sizeOverride grid units.
    const expandedSizes: Record<string, { width: number; height: number }> = {};
    for (const splice of spliceMapRef.current.values()) {
      // Nested splices live inside another splice, not in this module.
      if (isExpandNamespacedId(splice.flowInstanceId)) continue;
      expandedSizes[splice.flowInstanceId] = {
        width: Math.ceil(splice.expandedSize.width / diagramSizing.gridSize),
        height: Math.ceil(splice.expandedSize.height / diagramSizing.gridSize),
      };
    }
    vscode.postMessage({
      type: 'relayoutSelection',
      moduleName,
      nodeIds: [...selectedIds],
      nodes: stripExpandSplices(positioned, spliceMapRef.current),
      expandedSizes,
    });
  };

  // Cuts every wire touching any selected block in one action — the same
  // cutNet/cutNets message the wire "Cut" control posts, just with the edge
  // list assembled from the block selection instead of a wire selection.
  const handleCutOut = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (cutOutEdges.length === 0) return;
    const diagramEdges = cutOutEdges
      .map((edge) => (edge.data as { edge?: DiagramEdge } | undefined)?.edge)
      .filter((edge): edge is DiagramEdge => edge !== undefined);
    if (diagramEdges.length === 0) return;
    // Matches the wire "Cut" control's positionedNodesFromFlowNodes: every real
    // block is frozen in place, but a net-cut label keeps tracking its port
    // dynamically even if the marquee happened to select it too.
    const positioned = stripExpandSplices(
      nodes.map((node) => ({
        ...node.data.node,
        position: node.position,
        fixed: node.data.node.kind === 'netLabel' ? node.data.node.fixed : true,
      })),
      spliceMapRef.current,
    );
    // The cut instance and its newly-created cut-net-end stubs should stay
    // selected so the user can immediately drag the group — mirrors
    // handleClick's pendingReselectIdsRef handoff. Id format matches
    // cutLabelNodeId() in mergeLayout.ts, which is what actually creates
    // these nodes once the host processes the cut. Only the stub(s)
    // directly attached to a cut-out node belong in the group: a fanout
    // net's sink stub at some other, non-selected receiver stays put, so
    // adding it unconditionally (keyed only on netKey) would have swept in
    // ends that don't move with this drag.
    const selectedIds = new Set(selected.map((node) => node.id));
    const reselectIds = new Set(selectedIds);
    for (const edge of diagramEdges) {
      const netKey = edgeNetKey(edge);
      if (selectedIds.has(edge.source)) {
        reselectIds.add(`cut-label:${netKey}:source`);
      }
      if (selectedIds.has(edge.target)) {
        reselectIds.add(`cut-label:${netKey}:sink:${edge.id}`);
      }
    }
    pendingReselectIdsRef.current = reselectIds;
    if (diagramEdges.length === 1) {
      vscode.postMessage({ type: 'cutNet', moduleName, edge: diagramEdges[0], nodes: positioned });
      return;
    }
    vscode.postMessage({ type: 'cutNets', moduleName, edges: diagramEdges, nodes: positioned });
  };

  const handleRevertSize = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (resizedNodeIds.length === 0) return;
    vscode.postMessage({ type: 'revertNodeSizes', moduleName, nodeIds: resizedNodeIds });
  };

  return createPortal(
    <div className="svsch-selection-toolbar-layer">
      <div className="svsch-selection-toolbar" style={{ left: bounds.right, top: bounds.bottom }}>
        <div
          className="svsch-selection-toolbar-scale"
          style={{ transform: `scale(${counterScale})` }}
        >
          {selected.length >= 2 && (
            <button
              type="button"
              className="svsch-selection-relayout-control"
              title="Re-place and route the selected blocks; everything else stays put"
              onClick={handleClick}
              onDoubleClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              Auto Layout
            </button>
          )}
          {resizedNodeIds.length > 0 && (
            <button
              type="button"
              className="svsch-selection-revert-size-control"
              title={
                resizedNodeIds.length === 1
                  ? 'Revert the selected block to its canonical size'
                  : `Revert ${resizedNodeIds.length} selected blocks to their canonical sizes`
              }
              onClick={handleRevertSize}
              onDoubleClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              Revert Size
            </button>
          )}
          {cutOutEdges.length > 0 && (
            <button
              type="button"
              className="svsch-selection-cutout-control"
              title={`Cut ${cutOutEdges.length} connection(s) on the selected block(s)`}
              onClick={handleCutOut}
              onDoubleClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              Cut out
              <kbd className="svsch-shortcut-glyph" aria-hidden="true">
                <span className="svsch-shortcut-glyph-letter">C</span>
              </kbd>
            </button>
          )}
          {expandableInstance && (
            <button
              type="button"
              className="svsch-selection-expand-control"
              title={
                expandableInstance.data.node.kind === 'funcCall'
                  ? "Unfold this function's logic in place"
                  : expandableInstance.data.node.kind === 'taskCall'
                    ? "Unfold this task's logic in place"
                    : "Unfold this instance's diagram in place"
              }
              onClick={(event) => {
                event.stopPropagation();
                onExpandInstance(expandableInstance);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              Expand
            </button>
          )}
          {activeSplice && (
            <button
              type="button"
              className="svsch-selection-collapse-control"
              title={
                activeSplice.expansionKind === 'funcCall'
                  ? "Collapse this function's unfolded logic"
                  : activeSplice.expansionKind === 'taskCall'
                    ? "Collapse this task's unfolded logic"
                    : "Collapse this instance's unfolded diagram"
              }
              onClick={(event) => {
                event.stopPropagation();
                onCollapseInstance(activeSplice.region.id);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              Collapse
            </button>
          )}
        </div>
      </div>
    </div>,
    overlayPortalNode,
  );
}

// Translate the arm's internal edge routes by the same delta as the blocks so the
// wires move with them instead of staying put.
function applyRegionDragRoutes(
  drag: RegionDragState,
  clientX: number,
  clientY: number,
  zoom: number,
  onRouteChange: (changes: RouteChange[], commit: boolean) => void,
  commit: boolean,
): void {
  if (drag.kind !== 'move' || drag.startRoutes.size === 0) return;
  const dx = snapDelta((clientX - drag.startClientX) / Math.max(zoom, 0.01));
  const dy = snapDelta((clientY - drag.startClientY) / Math.max(zoom, 0.01));
  const changes: RouteChange[] = Array.from(drag.startRoutes.entries()).map(([edgeId, points]) => ({
    edgeId,
    routePoints: points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  }));
  onRouteChange(changes, commit);
}

function applyRegionDrag(
  drag: RegionDragState,
  clientX: number,
  clientY: number,
  zoom: number,
): { regions: PositionedGenerateRegion[]; nodes: HdlFlowNode[] } {
  const dx = snapDelta((clientX - drag.startClientX) / Math.max(zoom, 0.01));
  const dy = snapDelta((clientY - drag.startClientY) / Math.max(zoom, 0.01));

  if (drag.kind === 'resize') {
    const nodes = drag.startNodes;
    const regions = drag.startRegions.map((region) => {
      if (region.id !== drag.regionId) return region;
      return {
        ...region,
        bounds: resizeRegionBounds(region.bounds, drag.side!, dx, dy, drag),
      };
    });
    return {
      nodes,
      regions: expandRegionsForFlowNodes(regions, nodes),
    };
  }

  const nodes = drag.startNodes.map((node) => {
    if (!drag.affectedNodeIds.has(node.id)) return node;
    const position = {
      x: node.position.x + dx,
      y: node.position.y + dy,
    };
    return {
      ...node,
      position,
      data: {
        ...node.data,
        node: {
          ...node.data.node,
          position,
        },
      },
    };
  });
  const regions = drag.startRegions.map((region) => {
    if (!drag.affectedRegionIds.has(region.id)) return region;
    return {
      ...region,
      bounds: {
        ...region.bounds,
        x: region.bounds.x + dx,
        y: region.bounds.y + dy,
      },
    };
  });

  return {
    nodes,
    regions: expandRegionsForFlowNodes(regions, nodes),
  };
}

function resizeRegionBounds(
  bounds: PositionedGenerateRegion['bounds'],
  side: RegionDragSide,
  dx: number,
  dy: number,
  drag: RegionDragState,
): PositionedGenerateRegion['bounds'] {
  const minWidth = diagramSizing.gridSize * 8;
  const minHeight = diagramSizing.gridSize * 4;
  const inset = GENERATE_REGION_MIN_CONTENT_PADDING;
  const content = resizeContentBounds(drag.regionId, drag.startRegions, drag.startNodes);
  const next = { ...bounds };

  if (side === 'left') {
    const right = bounds.x + bounds.width;
    next.x = Math.min(bounds.x + dx, right - minWidth);
    if (content) next.x = Math.min(next.x, content.x - inset);
    next.width = right - next.x;
  } else if (side === 'right') {
    next.width = Math.max(minWidth, bounds.width + dx);
    if (content) next.width = Math.max(next.width, content.x + content.width + inset - bounds.x);
  } else if (side === 'top') {
    const bottom = bounds.y + bounds.height;
    next.y = Math.min(bounds.y + dy, bottom - minHeight);
    if (content) next.y = Math.min(next.y, content.y - inset);
    next.height = bottom - next.y;
  } else {
    next.height = Math.max(minHeight, bounds.height + dy);
    if (content) next.height = Math.max(next.height, content.y + content.height + inset - bounds.y);
  }

  return snapRegionBounds(next);
}

function resizeContentBounds(
  regionId: string,
  regions: PositionedGenerateRegion[],
  nodes: HdlFlowNode[],
): PositionedGenerateRegion['bounds'] | undefined {
  const descendantIds = descendantRegionIds(regionId, regions, false);
  const nodeIds = nodeIdsForRegions(new Set([regionId, ...descendantIds]), regions);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rects: PositionedGenerateRegion['bounds'][] = [];

  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const size = resolvedNodeDimensions(node.data.node);
    rects.push({ x: node.position.x, y: node.position.y, width: size.width, height: size.height });
  }
  for (const region of regions) {
    if (descendantIds.has(region.id)) rects.push(region.bounds);
  }
  return unionRegionBounds(rects);
}

function descendantRegionIds(
  regionId: string,
  regions: PositionedGenerateRegion[],
  includeSelf: boolean,
): Set<string> {
  const result = new Set<string>(includeSelf ? [regionId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const region of regions) {
      if (!region.parentRegionId || result.has(region.id)) continue;
      if (region.parentRegionId === regionId || result.has(region.parentRegionId)) {
        result.add(region.id);
        changed = true;
      }
    }
  }
  return result;
}

function nodeIdsForRegions(
  regionIds: Set<string>,
  regions: PositionedGenerateRegion[],
): Set<string> {
  const nodeIds = new Set<string>();
  for (const region of regions) {
    if (!regionIds.has(region.id)) continue;
    for (const nodeId of region.nodeIds) nodeIds.add(nodeId);
  }
  return nodeIds;
}

function flowNodesToPositioned(nodes: HdlFlowNode[], fixedIds: Set<string>): PositionedNode[] {
  return nodes.map((node) => ({
    ...node.data.node,
    position: node.position,
    fixed: node.data.node.fixed || node.selected || fixedIds.has(node.id),
  }));
}

// Shared by the floating selection toolbar's "Auto Layout" and the main
// toolbar's "Auto Layout All": released nodes go free; every other real block
// is frozen in place — but an unrelated net-cut label that's still tracking
// its port dynamically must not be forced fixed just because it's on screen.
function buildRelayoutPositionedNodes(
  nodes: HdlFlowNode[],
  releasedIds: Set<string>,
): PositionedNode[] {
  return flowNodesToPositioned(nodes, new Set()).map((node) => ({
    ...node,
    fixed: releasedIds.has(node.id) ? false : node.kind === 'netLabel' ? node.fixed : true,
  }));
}

// "Expand instance in place" splices synthetic nodes/regions (namespaced
// `expand:...` ids, see webview/expand/splice.ts) into the same flow
// nodes/regions state the rest of the app already reads. The extension host
// has never heard of these ids — every message that hands a `nodes`/
// `regions` payload back to it (layoutChanged, relayoutSelection, cutNet(s),
// edgeRoutesChanged, ...) must strip them first. Spliced content itself is
// never separately persisted (see splice.ts's SpliceResult doc) — it is
// always re-derived from the child module's own standalone layout.
function stripExpandSplices(
  nodes: PositionedNode[],
  splices: Map<string, ActiveSplice>,
): PositionedNode[] {
  const ghostOverrides = new Map(
    [...splices.values()].map(
      (splice) => [splice.flowInstanceId, splice.baseSizeOverride] as const,
    ),
  );
  return nodes
    .filter((node) => !isExpandNamespacedId(node.id))
    .map((node) =>
      // An expanded instance's node carries the splice's computed expanded
      // size as an injected sizeOverride (see expandOverlay's
      // dimAsExpandGhost) — restore the instance's own persisted override so
      // the expansion never saves as a manual resize.
      ghostOverrides.has(node.id) ? { ...node, sizeOverride: ghostOverrides.get(node.id) } : node,
    );
}

function stripExpandRegions(regions: PositionedGenerateRegion[]): PositionedGenerateRegion[] {
  return regions.filter((region) => region.kind !== 'expand');
}

// Drops any selection React Flow's marquee applied to nodes/wires spliced in
// by "Expand instance in place" (ids carrying the `expand:` namespace
// prefix): the sub-diagram inside an expanded instance is its own diagram,
// and drag-selection operates on the top-level one only — the marquee
// selects the expanded instance's own node instead. (Click-selection of
// spliced nodes doesn't pass through here and keeps working, e.g. for
// nested Expand.)
function deselectSplicedContent(
  setNodes: (updater: (nodes: HdlFlowNode[]) => HdlFlowNode[]) => void,
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void,
): void {
  setNodes((current) => {
    let changed = false;
    const next = current.map((node) => {
      if (!node.selected || !isExpandNamespacedId(node.id)) return node;
      changed = true;
      return { ...node, selected: false };
    });
    return changed ? next : current;
  });
  setEdges((current) => {
    let changed = false;
    const next = current.map((edge) => {
      if (!edge.selected || !isExpandNamespacedId(edge.id)) return edge;
      changed = true;
      return { ...edge, selected: false };
    });
    return changed ? next : current;
  });
}

function mergeDraggedFlowNodes(nodes: HdlFlowNode[], draggedNodes: HdlFlowNode[]): HdlFlowNode[] {
  const draggedById = new Map(draggedNodes.map((node) => [node.id, node]));
  const merged = nodes.map((node) => draggedById.get(node.id) ?? node);
  const seen = new Set(merged.map((node) => node.id));
  for (const dragged of draggedNodes) {
    if (!seen.has(dragged.id)) {
      merged.push(dragged);
    }
  }
  return merged;
}

// Expand (never shrink) each region to contain its moved/resized content, then annotate.
// Used while dragging an arm so its parent generate block grows to keep surrounding it.
function expandRegionsForFlowNodes(
  regions: PositionedGenerateRegion[],
  nodes: HdlFlowNode[],
): PositionedGenerateRegion[] {
  return expandRegionsForNodes(regions, flowNodesToPositioned(nodes, new Set()));
}

// Shift the selected regions' bounds by the drag delta; the following expansion pass
// reconciles parents/children (e.g. a wrapper grows around a translated arm).
function translateRegions(
  regions: PositionedGenerateRegion[],
  selectedIds: Set<string>,
  dx: number,
  dy: number,
): PositionedGenerateRegion[] {
  if (selectedIds.size === 0 || (dx === 0 && dy === 0)) return regions;
  return regions.map((region) =>
    selectedIds.has(region.id)
      ? {
          ...region,
          bounds: { ...region.bounds, x: region.bounds.x + dx, y: region.bounds.y + dy },
        }
      : region,
  );
}

function expandRegionsForNodes(
  regions: PositionedGenerateRegion[],
  nodes: PositionedNode[],
): PositionedGenerateRegion[] {
  if (regions.length === 0) return regions;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const regionById = new Map(regions.map((region) => [region.id, region]));
  const childRegionsByParent = new Map<string, PositionedGenerateRegion[]>();
  for (const region of regions) {
    const parent =
      region.parentRegionId && regionById.has(region.parentRegionId) ? region.parentRegionId : '';
    const list = childRegionsByParent.get(parent) ?? [];
    list.push(region);
    childRegionsByParent.set(parent, list);
  }

  const pad = GENERATE_REGION_MIN_CONTENT_PADDING;
  const padRect = (
    rect: PositionedGenerateRegion['bounds'],
  ): PositionedGenerateRegion['bounds'] => ({
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  });
  const expandedById = new Map<string, PositionedGenerateRegion>();

  // A region hugs its direct content (owned nodes and/or child regions) with one padding
  // ring, never shrinking. Bottom-up recursion makes wrappers hug their arm regions the
  // same way arms hug their leaf nodes.
  const expand = (region: PositionedGenerateRegion): PositionedGenerateRegion => {
    const cached = expandedById.get(region.id);
    if (cached) return cached;

    const contentRects: PositionedGenerateRegion['bounds'][] = [];
    for (const nodeId of region.nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const size = resolvedNodeDimensions(node);
      contentRects.push(
        padRect({ x: node.position.x, y: node.position.y, width: size.width, height: size.height }),
      );
    }
    for (const child of childRegionsByParent.get(region.id) ?? []) {
      contentRects.push(padRect(expand(child).bounds));
    }

    const content = unionRegionBounds(contentRects);
    const result: PositionedGenerateRegion = content
      ? {
          ...region,
          bounds: snapRegionBounds({
            x: Math.min(region.bounds.x, content.x),
            y: Math.min(region.bounds.y, content.y),
            width:
              Math.max(region.bounds.x + region.bounds.width, content.x + content.width) -
              Math.min(region.bounds.x, content.x),
            height:
              Math.max(region.bounds.y + region.bounds.height, content.y + content.height) -
              Math.min(region.bounds.y, content.y),
          }),
          fixed: region.fixed,
        }
      : region;
    expandedById.set(region.id, result);
    return result;
  };

  const expanded = regions.map((region) => expand(region));
  return annotateGenerateRegionWarnings(expanded, nodes);
}

function unionRegionBounds(
  rects: PositionedGenerateRegion['bounds'][],
): PositionedGenerateRegion['bounds'] | undefined {
  if (rects.length === 0) return undefined;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function snapDelta(value: number): number {
  return Math.round(value / diagramSizing.gridSize) * diagramSizing.gridSize;
}

function snapRegionBounds(
  bounds: PositionedGenerateRegion['bounds'],
): PositionedGenerateRegion['bounds'] {
  const grid = diagramSizing.gridSize;
  const x = Math.round(bounds.x / grid) * grid;
  const y = Math.round(bounds.y / grid) * grid;
  const width = Math.max(grid * 8, Math.round(bounds.width / grid) * grid);
  const height = Math.max(grid * 4, Math.round(bounds.height / grid) * grid);
  return { x, y, width, height };
}

createRoot(document.getElementById('root')!).render(<App />);
