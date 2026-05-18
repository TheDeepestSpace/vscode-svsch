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

  test('renders enum literal type links as clickable', async ({ page }) => {
    await openFixture(page, 'enum_types.sv', 'register');

    const literal = page.locator('[data-node-kind="literal"]', { hasText: 'IDLE' });
    await expect(literal).toContainText('state_t');

    const messagePromise = page.waitForEvent('console', (message) => message.text().startsWith('NAVIGATE:'));
    await literal.locator('.svsch-type-label', { hasText: 'state_t' }).click();
    const message = await messagePromise;
    const posted = JSON.parse(message.text().slice('NAVIGATE:'.length).trim());
    expect(posted).toMatchObject({
      type: 'navigateToSource',
      source: { file: 'enum_types.sv', startLine: 1 }
    });
  });

  test('keeps user type labels off module instance ports', async ({ page }) => {
    await openFixture(page, 'typed_instance_ports.sv', 'auto', 'typed_instance_ports');

    const instance = page.locator('[data-node-id="instance:typed_instance_ports:u_child"]');
    await expect(instance).toBeVisible();
    await expect(instance).toContainText('pkt_i');
    await expect(instance).toContainText('state_i');
    await expect(instance).toContainText('pkt_o');
    await expect(instance.locator('.svsch-type-label')).toHaveCount(0);
    await expect(instance).not.toContainText('packet_t');
    await expect(instance).not.toContainText('state_t');

    await expect(page.locator('[data-node-id="port:typed_instance_ports:pkt_i"] .svsch-type-label', { hasText: 'packet_t' })).toBeVisible();
    await expect(page.locator('[data-node-id="port:typed_instance_ports:state_i"] .svsch-type-label', { hasText: 'state_t' })).toBeVisible();
  });

  test('keeps struct wires unlabeled by type name', async ({ page }) => {
    await openFixture(page, 'struct_composition.sv', 'struct');

    await expect(page.locator('[data-node-id="port:struct_composition:opcode_i"]')).toContainText('[3:0]');
    await expect(page.locator('[data-node-id="reg:struct_composition:pkt.opcode"]')).toContainText('[3:0]');
    await expect(page.locator('[data-node-id="port:struct_composition:flat"]')).toContainText('[4:0]');
    await expect(page.locator('.svsch-edge-label >> text=packet_t')).toHaveCount(0);
    await expect(page.locator('path.svsch-edge-struct')).toHaveCount(1);
    await expect(page.locator('path.svsch-edge-struct').first()).toHaveAttribute('d', /M \d+ \d+ L/);

    await expect(page).toHaveScreenshot('struct-wires-without-type-label.png', { clip: await paddedGraphClip(page) });
  });
});
