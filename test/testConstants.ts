/**
 * Arguments for Chromium to ensure stable font rendering across different environments.
 */
export const chromiumStabilizationArgs = [
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-font-subpixel-positioning',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox'
];
