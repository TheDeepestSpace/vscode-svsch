import { test, expect } from '@playwright/test';
import { openFixture, fitGraphView } from './helper';

test.describe('variable bit select complex visual', () => {
  test('renders multiple variable bit select block combinations', async ({ page }) => {
    await openFixture(page, 'var_bit_select_complex.sv', 'auto');
    await fitGraphView(page, 0.2);

    await expect(page.locator('[data-node-kind="select"]')).toHaveCount(4);

    // Inputs 'in' and 's' should always have '[]'
    await expect(page.locator('[data-node-kind="select"] >> text="in[]"')).toHaveCount(4);
    await expect(page.locator('[data-node-kind="select"] >> text="s[]"')).toHaveCount(4);

    // Two bit selects (1-bit output) should have plain 'out'
    await expect(page.locator('[data-node-kind="select"] >> text="out"')).toHaveCount(2);
    // Two part selects (multi-bit output) should have 'out[]'
    await expect(page.locator('[data-node-kind="select"] >> text="out[]"')).toHaveCount(2);

    await expect(page).toHaveScreenshot('variable-bit-select-complex.png');
  });
});
