import { test, expect } from '@playwright/test';
import { openFixture, fitGraphView } from './helper';

test.describe('mixed select and breakout visual', () => {
  test('renders both bus breakout and variable select from same input', async ({ page }) => {
    await openFixture(page, 'mixed_select_breakout.sv', 'auto');
    await fitGraphView(page, 0.2);

    // Verify presence of both kinds of nodes
    await expect(page.locator('[data-node-kind="bus"]')).toBeVisible(); // The breakout/bus node
    await expect(page.locator('[data-node-kind="select"]')).toBeVisible(); // The variable select
    await expect(page.locator('[data-node-kind="literal"] >> text="P_WIDTH"')).toBeVisible(); // The P_WIDTH literal

    // Check labels on the select block
    // Input 'in' should have '[]'
    await expect(page.locator('[data-node-kind="select"] >> text="in[]"')).toBeVisible();
    // Input 's' (the selector) should have '[]'
    await expect(page.locator('[data-node-kind="select"] >> text="s[]"')).toBeVisible();
    // Input 'w' (the width) should have '[]'
    await expect(page.locator('[data-node-kind="select"] >> text="w[]"')).toBeVisible();
    // Output 'out' should have '[]' because it's a part select (vector output)
    await expect(page.locator('[data-node-kind="select"] >> text="out[]"')).toBeVisible();

    // Check the bus breakout tap
    await expect(page.locator('[data-node-kind="bus"] >> text="[7:0]"')).toBeVisible();

    await expect(page).toHaveScreenshot('mixed-select-breakout.png');
  });
});
