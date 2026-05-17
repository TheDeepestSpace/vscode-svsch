import { describe, expect, it } from 'vitest';
import { diagramSizing } from '../../src/diagram/constants';
import {
  portSkinPath,
  interfaceSkinPath
} from '../../src/diagram/interfaceGeometry';

describe('SVG Skin Geometry', () => {
  const grid = diagramSizing.gridSize;
  const nose = diagramSizing.portNoseLength;
  const width = grid * 8;
  const height = grid * 4;
  const skinHeight = grid;

  describe('portSkinPath', () => {
    it('generates a right-pointing chevron for input ports', () => {
      const path = portSkinPath('input', 192, 24, 24, 12);
      expect(path).toBe('M 0 0 H 180 L 192 12 L 180 24 H 0 Z');
    });

    it('generates a left-pointing chevron for output ports', () => {
      const path = portSkinPath('output', 192, 24, 24, 12);
      expect(path).toBe('M 12 0 H 192 V 24 H 12 L 0 12 Z');
    });

    it('generates a double-chevron (harness) for interface ports', () => {
      const path = portSkinPath('harness', 192, 24, 24, 12);
      expect(path).toBe('M 12 0 H 180 L 192 12 L 180 24 H 12 L 0 12 Z');
    });
  });

  describe('interfaceSkinPath', () => {
    it('aligns body top with the first notch', () => {
      const shiftY = grid * 3; // 72px shift
      const leftCenters = [84 + shiftY]; // raw 84, shifted to 156
      const rightCenters = [84 + shiftY];

      const { path, topHatTop } = interfaceSkinPath({
        width,
        height: height + shiftY,
        leftCenters,
        rightCenters,
        topPortCount: 1,
        shiftY
      });

      // shiftY = 72
      // unshifted sideCenters = [84]
      // unshifted sideTop = 84 - 12 = 72
      // unshifted topHatTop = 72 - 24 = 48
      // shifted topHatTop = 48 + 72 = 120
      expect(topHatTop).toBe(120);

      // bodyTop = topHatTop + topHatHeight = 120 + 24 = 144
      // shifted notch top = 156 - 12 = 144
      expect(path).toContain(`V 144`); 
      expect(path).toContain(`L ${width} 156`); // tip of right chevron
    });

    it('generates a plain harness when no top ports are present', () => {
      const { path } = interfaceSkinPath({
        width,
        height,
        leftCenters: [grid * 2],
        rightCenters: [grid * 2],
        topPortCount: 0
      });

      expect(path).toMatch(new RegExp(`^M ${nose}`));
      expect(path).toContain(`L ${width} ${grid * 2}`);
      expect(path).toContain(`L 0 ${grid * 2}`);
      expect(path).not.toContain('H 0'); // since it starts with M nose
    });

    it('does not draw a synthetic right chevron when all modports are on the left', () => {
      const { path } = interfaceSkinPath({
        width,
        height,
        leftCenters: [grid * 2, grid * 4],
        rightCenters: [],
        topPortCount: 2
      });

      expect(path).toContain('L 0');
      expect(path).not.toContain(`L ${width}`);
    });

    it('does not draw a synthetic left chevron when all modports are on the right', () => {
      const { path } = interfaceSkinPath({
        width,
        height,
        leftCenters: [],
        rightCenters: [grid * 2, grid * 4],
        topPortCount: 2
      });

      expect(path).toContain(`L ${width}`);
      expect(path).not.toContain('L 0');
    });

    it('draws an inverted bottom cap for scalar interface outputs', () => {
      const { path, bottomHatTop, bottomHatHeight } = interfaceSkinPath({
        width,
        height: height + grid,
        leftCenters: [grid * 2],
        rightCenters: [grid * 2],
        topPortCount: 1,
        bottomPortCount: 1
      });

      expect(bottomHatHeight).toBe(grid);
      expect(bottomHatTop).toBe(height);
      expect(path).toContain(`V ${height + grid}`);
      expect(path).toContain(`V ${height} H`);
    });
  });
});
