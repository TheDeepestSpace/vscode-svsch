import { test, expect } from '@playwright/test';
import { openFixture, fitGraphView } from './helper';

test.describe('variable bit select visual', () => {
  test('renders variable bit select block', async ({ page }) => {
    await openFixture(page, 'var_bit_select.sv', 'auto');
    await fitGraphView(page, 0.2);

    await expect(page.locator('[data-node-kind="select"]')).toHaveCount(2);
    await expect(page).toHaveScreenshot('variable-bit-select.png');
  });
});
