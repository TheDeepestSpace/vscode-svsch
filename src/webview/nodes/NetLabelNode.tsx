import React from 'react';
import { Handle, useStore } from '@xyflow/react';
import { getVscodeApi } from '../vscodeApi';
import { diagramNodeDimensions, nodeWarningIconCenter } from '../../diagram/nodeSizing';
import { InteractionContext } from './shared/context';
import { ArrayStackLeads, handlePositionForSide, NetLabelWire } from './shared/NetLabelWire';
import type { PositionedNode } from '../../ir/types';
import { isExpandNamespacedId } from '../expand/splice';
import { Tooltip } from '../Tooltip';

const vscode = getVscodeApi();

export function NetLabelNode({
  node,
  moduleName,
  selected,
  style,
}: {
  node: PositionedNode;
  moduleName: string;
  selected?: boolean;
  style: React.CSSProperties;
}): React.ReactElement {
  const cutNet = node.metadata?.cutNet;
  // A label spliced in by "Expand instance in place" belongs to the child
  // module's own diagram — it's read-only here (like the rest of the spliced
  // content): no rename, no Tie/Revert, and its netKey is child-local so it
  // must not join the parent's net hover-highlight group.
  const isSpliced = isExpandNamespacedId(node.id);
  // Absent origin (labels saved before this field existed) reads as
  // synthetic: freely renameable, same as always.
  const isDeclaredName = cutNet?.origin === 'declared';
  // The label's current text is still the net's legal name right after a
  // cut, even for a synthetic default — italics mark a name the user has
  // actively chosen to diverge from that default, not the origin itself.
  const isRenamed = cutNet?.isRenamed === true;
  const aliasNames = cutNet?.aliasNames;
  const { hoveredNetKey, setHovered, partialDiagram } = React.useContext(InteractionContext);
  // The label itself lives inside react-flow's zoom-scaled viewport, so its
  // Revert/Tie action pill would otherwise grow and shrink with the canvas
  // like the edge Reroute/Cut controls did before their own counter-scale
  // fix (see OrthogonalEdge) — subscribe rather than reactFlow.getZoom() so
  // it stays live as the user zooms, not just on the next unrelated render.
  const zoom = useStore((state) => state.transform[2]);
  const counterScale = 1 / Math.max(zoom || 1, 0.01);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(node.label);
  const [isDirectlyHovered, setIsDirectlyHovered] = React.useState(false);

  React.useEffect(() => {
    setDraft(node.label);
  }, [node.label]);

  const stopDrag = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(node.label);
      setEditing(false);
      return;
    }
    if (cutNet && trimmed !== node.label) {
      vscode.postMessage({
        type: 'renameCutNet',
        moduleName,
        netKey: cutNet.netKey,
        label: trimmed,
      });
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(node.label);
    setEditing(false);
  };

  const handleSide = cutNet?.handleSide ?? 'left';
  const handlePosition = handlePositionForSide(handleSide);
  const handleType = cutNet?.role === 'source' ? 'target' : 'source';
  const isHovered = !isSpliced && hoveredNetKey !== undefined && hoveredNetKey === cutNet?.netKey;
  // React Flow also marks this label's cut-stub edge selected whenever the
  // block it's attached to is selected (relied on by Auto Layout to carry
  // cut-net-end labels along, see main.tsx). That propagation is not this
  // label's own selection, so it must not drive the highlight — only a
  // genuine hover or the label's own `selected` prop should.
  const isHighlighted = isHovered || selected === true;
  const edgeStyleClasses = [
    cutNet?.edgeStyle?.aggregate === 'struct' ? 'hdl-net-label-struct' : '',
    cutNet?.edgeStyle?.aggregate === 'interface' ? 'hdl-net-label-interface' : '',
    cutNet?.isSourceStacked ? 'hdl-net-label-stacked' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const { width: nodeWidth, height: nodeHeight } = diagramNodeDimensions(node);
  const netLabelClassName =
    `hdl-net-label hdl-net-label-${cutNet?.role ?? 'sink'} ` +
    `hdl-net-label-align-${cutNet?.align ?? 'start'} hdl-net-label-handle-${handleSide}` +
    `${edgeStyleClasses ? ` ${edgeStyleClasses}` : ''}` +
    `${isDirectlyHovered ? ' hdl-net-label-hovered' : ''}` +
    `${selected ? ' hdl-net-label-selected' : ''}`;
  const warningCenter = nodeWarningIconCenter(node, nodeWidth, nodeHeight);

  return (
    <div
      className={netLabelClassName}
      data-node-id={node.id}
      data-node-kind={node.kind}
      style={style}
      tabIndex={0}
      title={isDeclaredName ? `${node.label} (declared in source — cannot be renamed)` : node.label}
      onDoubleClick={(event) => {
        event.stopPropagation();
        // A partial pane's host keeps no netCuts state to rename against.
        if (isDeclaredName || isSpliced || partialDiagram) return;
        setEditing(true);
      }}
      onMouseEnter={() => {
        if (!isSpliced) setHovered(cutNet?.netKey);
        setIsDirectlyHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(undefined);
        setIsDirectlyHovered(false);
      }}
    >
      {cutNet && <Handle type={handleType} id="cut" position={handlePosition} />}
      <NetLabelWire
        node={node}
        handleSide={handleSide}
        edgeStyle={cutNet?.edgeStyle}
        align={cutNet?.align}
        isSourceStacked={cutNet?.isSourceStacked}
        isHighlighted={isHighlighted}
      />
      {cutNet?.isSourceStacked && (
        <ArrayStackLeads
          side={handleSide}
          width={nodeWidth}
          y={nodeHeight / 2}
          trimSink={cutNet?.role === 'source'}
          wide={cutNet?.edgeStyle?.thick === true}
          thick={cutNet?.edgeStyle?.thick === true}
        />
      )}
      {editing ? (
        <input
          className="hdl-net-label-input nodrag nopan"
          value={draft}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onDoubleClick={stopDrag}
          onMouseDown={stopDrag}
          onPointerDown={stopDrag}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <span
          className={
            `hdl-net-label-text${isHighlighted ? ' hdl-net-label-text-hovered' : ''}` +
            `${isRenamed ? ' hdl-net-label-text-synthetic' : ''}`
          }
        >
          <span className="hdl-net-label-text-value">{node.label}</span>
          {aliasNames && aliasNames.length > 0 && (
            <Tooltip content={`Also declared as: ${aliasNames.join(', ')}`} tone="info">
              {(trigger) => (
                <sup
                  {...trigger}
                  className="hdl-net-label-alias-marker nodrag nopan"
                  role="img"
                  aria-label={`This net also has these declared aliases: ${aliasNames.join(', ')}`}
                >
                  *
                </sup>
              )}
            </Tooltip>
          )}
        </span>
      )}
      {cutNet && !isSpliced && (
        <span className="hdl-net-label-actions">
          <span
            className="hdl-net-label-actions-scale"
            style={{ transform: `scale(${counterScale})` }}
          >
            {/* In a partial diagram pane (issue #403) a cut end's only action
                is "extend": pull in the node on the other end of this net —
                resolved by the host against the original module's edge list —
                and tie the net within the partial. Tie/Revert stay
                main-diagram-only; the partial's host has no netCuts to act on. */}
            {partialDiagram && (
              <button
                className="hdl-net-label-extend nodrag nopan"
                type="button"
                aria-label="Extend: pull in the node on the other end of this net"
                title="Extend: pull in the node on the other end of this net"
                onClick={(event) => {
                  event.stopPropagation();
                  vscode.postMessage({
                    type: 'requestExtendNet',
                    moduleName,
                    netKey: cutNet.netKey,
                    originalEdgeId: cutNet.originalEdgeId,
                  });
                }}
                onDoubleClick={stopDrag}
                onMouseDown={stopDrag}
                onPointerDown={stopDrag}
              >
                <span className="hdl-net-label-extend-arrow" aria-hidden="true">
                  {cutNet.role === 'source' ? '→' : '←'}
                </span>
                Extend
              </button>
            )}
            {!partialDiagram && isRenamed && (
              <button
                className="hdl-net-label-revert nodrag nopan"
                type="button"
                aria-label="Revert label to the net's default name"
                title="Revert label to the net's default name"
                onClick={(event) => {
                  event.stopPropagation();
                  vscode.postMessage({
                    type: 'revertCutNetLabel',
                    moduleName,
                    netKey: cutNet.netKey,
                  });
                }}
                onDoubleClick={stopDrag}
                onMouseDown={stopDrag}
                onPointerDown={stopDrag}
              >
                Revert label
              </button>
            )}
            {!partialDiagram && (
              <button
                className="hdl-net-label-tie nodrag nopan"
                type="button"
                aria-label="Tie net back together"
                title="Tie net back together"
                onClick={(event) => {
                  event.stopPropagation();
                  vscode.postMessage({
                    type: 'tieNet',
                    moduleName,
                    netKey: cutNet.netKey,
                  });
                }}
                onDoubleClick={stopDrag}
                onMouseDown={stopDrag}
                onPointerDown={stopDrag}
              >
                Tie
                <kbd className="svsch-shortcut-glyph" aria-hidden="true">
                  <span className="svsch-shortcut-glyph-letter">T</span>
                </kbd>
              </button>
            )}
          </span>
        </span>
      )}
      {node.warningNote && (
        <Tooltip content={node.warningNote}>
          {(trigger) => (
            <span
              {...trigger}
              className="node-warning"
              role="img"
              aria-label={node.warningNote}
              style={{
                left: warningCenter.x,
                top: warningCenter.y,
                transform: 'translate(-50%, -50%)',
              }}
            >
              ⚠
            </span>
          )}
        </Tooltip>
      )}
    </div>
  );
}
