import { describe, expect, test } from 'vitest';
import { diagramSizing } from '../../src/diagram/constants';
import { diagramNodeDimensions } from '../../src/diagram/nodeSizing';
import type { DiagramNode, DiagramNodeKind } from '../../src/ir/types';

describe('diagram node sizing', () => {
  test.each([
    ['module', diagramSizing.nodeWidth],
    ['instance', diagramSizing.nodeWidth],
    ['mux', diagramSizing.muxWidth],
    ['register', diagramSizing.registerWidth],
    ['port', diagramSizing.portWidth],
    ['comb', diagramSizing.nodeWidth],
    ['bus', diagramSizing.nodeWidth],
    ['unknown', diagramSizing.nodeWidth]
  ] satisfies Array<[DiagramNodeKind, number]>)('keeps the default %s width', (kind, expectedWidth) => {
    expect(diagramNodeDimensions(nodeOfKind(kind)).width).toBe(expectedWidth);
  });

  test.each([
    ['module', diagramSizing.nodeWidth],
    ['instance', diagramSizing.nodeWidth],
    ['mux', diagramSizing.muxWidth],
    ['register', diagramSizing.registerWidth],
    ['port', diagramSizing.portWidth],
    ['comb', diagramSizing.nodeWidth],
    ['literal', diagramSizing.literalMinWidth],
    ['bus', diagramSizing.nodeWidth],
    ['unknown', diagramSizing.nodeWidth]
  ] satisfies Array<[DiagramNodeKind, number]>)('extends long-label %s widths on the snap grid', (kind, minimumWidth) => {
    const width = diagramNodeDimensions(nodeOfKind(kind, true)).width;

    expect(width).toBeGreaterThan(minimumWidth);
    expect(width % diagramSizing.gridSize).toBe(0);
  });

  test('keeps a toy case mux at the default width', () => {
    const width = diagramNodeDimensions({
      id: 'mux',
      kind: 'mux',
      label: 'case sel',
      ports: [
        { id: 'sel', name: 'sel', direction: 'input' },
        { id: 'zero', name: 'zero', label: "1'b0", direction: 'input' },
        { id: 'default', name: 'default', label: 'default', direction: 'input' },
        { id: 'y', name: 'y', direction: 'output' }
      ]
    }).width;

    expect(width).toBe(diagramSizing.muxWidth);
  });

  test('keeps expanded mux widths on even grid units for centered select ports', () => {
    const width = diagramNodeDimensions({
      id: 'mux',
      kind: 'mux',
      label: 'case sel',
      ports: [
        { id: 'sel', name: 'select_signal_with_long_name', direction: 'input' },
        { id: 'case0', name: 'case0', label: "2'd0", direction: 'input' },
        { id: 'case1', name: 'case1', label: "2'd1", direction: 'input' },
        { id: 'default', name: 'default', label: 'default', direction: 'input' },
        { id: 'out', name: 'output_value_with_long_name', direction: 'output' }
      ]
    }).width;

    expect((width / diagramSizing.gridSize) % 2).toBe(0);
  });

  test('does not widen comb nodes for hidden input labels', () => {
    const width = diagramNodeDimensions({
      id: 'comb',
      kind: 'comb',
      label: 'comb',
      ports: [
        { id: 'hidden', name: 'very_long_hidden_input_label_that_is_not_rendered', direction: 'input', width: '[255:0]' },
        { id: 'out', name: 'y', direction: 'output' }
      ]
    }).width;

    expect(width).toBe(diagramSizing.nodeWidth);
  });

  test('keeps comb width independent from similarly placed mux width', () => {
    const outputName = 'decoded_wide_label_growth';
    const combWidth = diagramNodeDimensions({
      id: 'comb',
      kind: 'comb',
      label: 'comb_wide_label_growth',
      ports: [
        { id: 'hidden', name: 'wide_label_growth', direction: 'input', width: '[255:0]' },
        { id: 'out', name: outputName, direction: 'output', width: '[255:0]' }
      ]
    }).width;
    const muxWidth = diagramNodeDimensions({
      id: 'mux',
      kind: 'mux',
      label: 'case sel',
      ports: [
        { id: 'sel', name: 'sel', direction: 'input' },
        { id: 'case0', name: 'case0', label: 'wide_label_growth', direction: 'input', width: '[255:0]' },
        { id: 'case1', name: 'case1', label: 'default_wide_label_growth', direction: 'input' },
        { id: 'out', name: 'wide_label_growth', direction: 'output' }
      ]
    }).width;

    expect(combWidth).toBeLessThan(muxWidth);
    expect(combWidth % diagramSizing.gridSize).toBe(0);
  });

  test('does not widen comb nodes for hidden block labels', () => {
    const width = diagramNodeDimensions({
      id: 'comb',
      kind: 'comb',
      label: 'very_long_comb_block_label_that_is_not_rendered',
      ports: [
        { id: 'in', name: 'a', direction: 'input' },
        { id: 'out', name: 'y', direction: 'output' }
      ]
    }).width;

    expect(width).toBe(diagramSizing.nodeWidth);
  });

  test('keeps compact combinational minimum height while growing with rows', () => {
    const oneRow = diagramNodeDimensions({
      id: 'comb:one',
      kind: 'comb',
      label: '',
      ports: [
        { id: 'in', name: 'a', direction: 'input' },
        { id: 'out', name: 'y', direction: 'output' }
      ]
    }).height;
    const twoRows = diagramNodeDimensions({
      id: 'comb:two',
      kind: 'comb',
      label: '',
      ports: [
        { id: 'in:a', name: 'a', direction: 'input' },
        { id: 'in:b', name: 'b', direction: 'input' },
        { id: 'out', name: 'y', direction: 'output' }
      ]
    }).height;
    const threeRows = diagramNodeDimensions({
      id: 'comb:three',
      kind: 'comb',
      label: '',
      ports: [
        { id: 'in:a', name: 'a', direction: 'input' },
        { id: 'in:b', name: 'b', direction: 'input' },
        { id: 'in:c', name: 'c', direction: 'input' },
        { id: 'out', name: 'y', direction: 'output' }
      ]
    }).height;

    expect(oneRow).toBe(diagramSizing.gridSize * 3);
    expect(twoRows).toBe(diagramSizing.gridSize * 4);
    expect(threeRows).toBe(diagramSizing.gridSize * 5);
  });

  test('keeps literal handle centers on the route grid', () => {
    const dimensions = diagramNodeDimensions(nodeOfKind('literal'));

    expect(dimensions.width).toBeGreaterThanOrEqual(diagramSizing.literalMinWidth);
    expect(dimensions.width % diagramSizing.gridSize).toBe(0);
    expect(dimensions.height).toBe(diagramSizing.gridSize * 2);
    expect((dimensions.height / 2) % diagramSizing.gridSize).toBe(0);
  });

  test('does not widen nodes for single-bit width [0:0]', () => {
    const defaultWidth = diagramNodeDimensions({
      id: 'port',
      kind: 'port',
      label: 'clk',
      ports: [{ id: 'p', name: 'clk', direction: 'input' }]
    }).width;

    const singleBitWidth = diagramNodeDimensions({
      id: 'port',
      kind: 'port',
      label: 'clk',
      ports: [{ id: 'p', name: 'clk', direction: 'input', width: '[0:0]' }]
    }).width;

    expect(singleBitWidth).toBe(defaultWidth);
  });
});

function nodeOfKind(kind: DiagramNodeKind, extended = false): DiagramNode {
  const long = 'very_long_signal_or_block_label_for_width_growth';
  const label = extended ? long : kind === 'instance' ? 'u' : kind === 'register' ? 'q' : kind === 'unknown' ? 'x' : kind;

  if (kind === 'port') {
    return {
      id: `node:${kind}`,
      kind,
      label,
      ports: [{ id: 'p', name: label, direction: 'input', width: extended ? '[127:0]' : undefined }]
    };
  }

  if (kind === 'mux') {
    return {
      id: `node:${kind}`,
      kind,
      label,
      ports: [
        { id: 'sel', name: 'sel', direction: 'input' },
        { id: 'in0', name: extended ? long : 'a', label: extended ? long : 'a', direction: 'input' },
        { id: 'out', name: extended ? long : 'y', direction: 'output' }
      ]
    };
  }

  if (kind === 'register') {
    return {
      id: `node:${kind}`,
      kind,
      label,
      ports: [
        { id: 'd', name: 'D', direction: 'input' },
        { id: 'clk', name: 'clk', direction: 'input' },
        { id: 'q', name: 'Q', direction: 'output' }
      ],
      metadata: extended ? { width: '[255:0]' } : undefined
    };
  }

  if (kind === 'bus') {
    return {
      id: `node:${kind}`,
      kind,
      label,
      ports: [
        { id: 'in', name: 'instr', direction: 'input' },
        { id: 'tap', name: extended ? long : '[6:0]', label: extended ? long : '[6:0]', direction: 'output' }
      ]
    };
  }

  if (kind === 'literal') {
    return {
      id: `node:${kind}`,
      kind,
      label: extended ? `literal_${long}` : "8'h42",
      ports: [
        { id: 'out', name: extended ? long : 'literal_y', direction: 'output', width: extended ? '[255:0]' : undefined }
      ]
    };
  }

  return {
    id: `node:${kind}`,
    kind,
    label,
    instanceOf: kind === 'instance' ? (extended ? long : 'child') : undefined,
    ports: [
      { id: 'in', name: extended ? long : 'a', direction: 'input', width: extended ? '[127:0]' : undefined },
      { id: 'out', name: extended ? long : 'y', direction: 'output', width: extended ? '[127:0]' : undefined }
    ]
  };
}
