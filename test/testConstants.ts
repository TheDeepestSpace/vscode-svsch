/**
 * Arguments for Chromium to ensure stable font rendering across different environments.
 */
export const chromiumStabilizationArgs = [
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-font-subpixel-positioning'
];
