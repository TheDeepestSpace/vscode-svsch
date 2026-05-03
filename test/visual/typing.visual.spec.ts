import { expect, test } from '@playwright/test';
import { openFixture, paddedGraphClip } from './helper';

test.describe('typing support visual rendering', () => {
  test('renders enum types instead of widths for ports and registers', async ({ page }) => {
    await openFixture(page, 'enum_types.sv', 'register');

    // Check IO ports
    await expect(page.locator('[data-node-kind="port"] >> text=in_state')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> .svsch-type-label:has-text("state_t")').first()).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=out_state')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> .svsch-type-label:has-text("state_t")')).toHaveCount(2);

    // Check register
    await expect(page.locator('[data-node-kind="register"] >> text=current_state')).toBeVisible();
    await expect(page.locator('[data-node-kind="register"] >> .svsch-type-label:has-text("state_t")')).toBeVisible();

    await expect(page).toHaveScreenshot('enum-types.png', { clip: await paddedGraphClip(page) });
  });

  test('keeps struct wires unlabeled by type name', async ({ page }) => {
    await openFixture(page, 'struct_composition.sv', 'struct');

    await expect(page.locator('[data-node-id="port:top:opcode_i"]')).toContainText('[3:0]');
    await expect(page.locator('[data-node-id="reg:top:pkt.opcode"]')).toContainText('[3:0]');
    await expect(page.locator('[data-node-id="port:top:flat"]')).toContainText('[4:0]');
    await expect(page.locator('.svsch-edge-label >> text=packet_t')).toHaveCount(0);
    await expect(page.locator('path.svsch-edge-struct')).toBeVisible();

    await expect(page).toHaveScreenshot('struct-wires-without-type-label.png', { clip: await paddedGraphClip(page) });
  });
});
