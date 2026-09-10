import { describe, expect, it } from 'vitest';
import { extractDesignFromText } from '../../src/parser/textExtractor';

function registerMetadata(
  moduleName: string,
  code: string,
  options?: { clockSignalNames?: string[]; resetSignalNames?: string[] },
) {
  const graph = extractDesignFromText([{ file: `${moduleName}.sv`, text: code }], options);
  const mod = graph.modules[moduleName];
  const reg = mod.nodes.find((n) => n.kind === 'register');
  return reg?.metadata;
}

describe('textExtractor clock/reset signal name detection', () => {
  it('identifies default-named clk/rst_n without any configuration', () => {
    const code = `
      module default_names (
        input logic clk,
        input logic rst_n,
        input logic d,
        output logic q
      );
        always_ff @(posedge clk or negedge rst_n) begin
          if (!rst_n) q <= 1'b0;
          else q <= d;
        end
      endmodule
    `;
    const metadata = registerMetadata('default_names', code);
    expect(metadata?.clockSignal).toBe('clk');
    expect(metadata?.resetSignal).toBe('rst_n');
    expect(metadata?.resetKind).toBe('async');
  });

  it('identifies a non-default clock/reset pair listed reset-first, using configured names', () => {
    // "clr_n" starts with 'c' (the old heuristic picked whichever signal started with
    // 'c' as the clock), and it's listed before "tck" in the sensitivity list, so the
    // old positional-plus-prefix heuristic would have misidentified the reset as the clock.
    const code = `
      module custom_names_reordered (
        input logic tck,
        input logic clr_n,
        input logic d,
        output logic q
      );
        always_ff @(negedge clr_n or posedge tck) begin
          if (!clr_n) q <= 1'b0;
          else q <= d;
        end
      endmodule
    `;
    const metadata = registerMetadata('custom_names_reordered', code, {
      clockSignalNames: ['TCK'],
      resetSignalNames: ['CLR'],
    });
    expect(metadata?.clockSignal).toBe('tck');
    expect(metadata?.resetSignal).toBe('clr_n');
    expect(metadata?.resetActiveLow).toBe(true);
  });

  it('falls back to positional guessing (and can misidentify) when names are non-default', () => {
    const code = `
      module custom_names_reordered_default (
        input logic tck,
        input logic clr_n,
        input logic d,
        output logic q
      );
        always_ff @(negedge clr_n or posedge tck) begin
          if (!clr_n) q <= 1'b0;
          else q <= d;
        end
      endmodule
    `;
    const metadata = registerMetadata('custom_names_reordered_default', code);
    // Neither "clr_n" nor "tck" matches the default clock/reset substring lists, so
    // detection falls back to sensitivity-list order and picks the first term as the
    // clock -- which is wrong here. This documents the gap that configuring
    // svsch.clockSignalNames/svsch.resetSignalNames closes.
    expect(metadata?.clockSignal).toBe('clr_n');
  });

  it('identifies a sync reset by configured name among multiple if-condition identifiers', () => {
    const code = `
      module sync_reset_custom (
        input logic tck,
        input logic en_n,
        input logic clr,
        input logic d,
        output logic q
      );
        always_ff @(posedge tck) begin
          if (en_n && clr) q <= 1'b0;
          else q <= d;
        end
      endmodule
    `;
    const metadata = registerMetadata('sync_reset_custom', code, {
      clockSignalNames: ['tck'],
      resetSignalNames: ['clr'],
    });
    expect(metadata?.clockSignal).toBe('tck');
    expect(metadata?.resetSignal).toBe('clr');
    expect(metadata?.resetKind).toBe('sync');
  });

  it('falls back to the first if-condition identifier when no reset name matches', () => {
    const code = `
      module sync_reset_default (
        input logic tck,
        input logic en_n,
        input logic clr,
        input logic d,
        output logic q
      );
        always_ff @(posedge tck) begin
          if (en_n && clr) q <= 1'b0;
          else q <= d;
        end
      endmodule
    `;
    const metadata = registerMetadata('sync_reset_default', code);
    // Default reset names ("rst"/"reset") match neither "en_n" nor "clr", so detection
    // falls back to the first if-condition identifier -- "en_n" -- which is wrong.
    expect(metadata?.resetSignal).toBe('en_n');
  });
});
