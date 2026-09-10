import { describe, expect, it } from 'vitest';
import { SourceRangeIndex } from '../../src/core/sourceResolution';

describe('SourceRangeIndex', () => {
  const index = new SourceRangeIndex([
    {
      id: 'outer',
      source: {
        file: 'rtl/top.sv',
        startLine: 10,
        startColumn: 2,
        endLine: 20,
        endColumn: 5,
      },
    },
    {
      id: 'inner',
      source: {
        file: 'rtl/top.sv',
        startLine: 12,
        startColumn: 4,
        endLine: 14,
        endColumn: 8,
      },
    },
    {
      id: 'overlap',
      source: {
        file: 'rtl\\top.sv',
        startLine: 13,
        startColumn: 0,
        endLine: 16,
        endColumn: 0,
      },
    },
  ]);

  it('finds an exact source-range match', () => {
    const exactIndex = new SourceRangeIndex([
      {
        id: 'exact',
        source: {
          file: 'rtl/top.sv',
          startLine: 4,
          startColumn: 2,
          endLine: 4,
          endColumn: 15,
        },
      },
    ]);
    expect(
      exactIndex.findNodeIds({
        file: 'rtl/top.sv',
        startLine: 4,
        startColumn: 2,
        endLine: 4,
        endColumn: 15,
      }),
    ).toEqual(['exact']);
  });

  it('returns every nested and overlapping range at a cursor position', () => {
    expect(
      index.findNodeIds({
        file: './rtl/top.sv',
        startLine: 13,
        startColumn: 6,
        endLine: 13,
        endColumn: 6,
      }),
    ).toEqual(['outer', 'inner', 'overlap']);
  });

  it('returns no nodes when the selection does not overlap a source span', () => {
    expect(
      index.findNodeIds({
        file: 'rtl/top.sv',
        startLine: 21,
        startColumn: 0,
        endLine: 21,
        endColumn: 4,
      }),
    ).toEqual([]);
    expect(
      index.findNodeIds({
        file: 'rtl/other.sv',
        startLine: 13,
        startColumn: 6,
        endLine: 13,
        endColumn: 6,
      }),
    ).toEqual([]);
  });
});
