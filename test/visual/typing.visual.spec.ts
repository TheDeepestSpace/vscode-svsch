import { expect, test } from '@playwright/test';
import { openFixture, paddedGraphClip, expectGraphAndScreenshot } from './helper';

test.describe('typing support visual rendering', () => {
  test('renders enum types instead of widths for ports and registers', async ({ page }) => {
    await openFixture(page, 'enum_types.sv', 'register');

    // Check IO ports
    await expect(page.locator('[data-node-kind="port"] >> text=in_state')).toBeVisible();
    await expect(
      page.locator('[data-node-kind="port"] >> .svsch-type-label:has-text("state_t")').first(),
    ).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=out_state')).toBeVisible();
    await expect(
      page.locator('[data-node-kind="port"] >> .svsch-type-label:has-text("state_t")'),
    ).toHaveCount(2);

    // Check register
    await expect(page.locator('[data-node-kind="register"] >> text=current_state')).toBeVisible();
    await expect(
      page.locator('[data-node-kind="register"] >> .svsch-type-label:has-text("state_t")'),
    ).toBeVisible();

    await expectGraphAndScreenshot(page, 'enum-types.png', { clip: await paddedGraphClip(page) });
  });

  test('renders enum literal type links as clickable', async ({ page }) => {
    await openFixture(page, 'enum_types.sv', 'register');

    const literal = page.locator('[data-node-kind="literal"]', { hasText: 'IDLE' });
    await expect(literal).toContainText('state_t');

    const messagePromise = page.waitForEvent('console', (message) =>
      message.text().startsWith('NAVIGATE:'),
    );
    await literal.locator('.svsch-type-label', { hasText: 'state_t' }).click();
    const message = await messagePromise;
    const posted = JSON.parse(message.text().slice('NAVIGATE:'.length).trim());
    expect(posted).toMatchObject({
      type: 'navigateToSource',
      source: { file: 'enum_types.sv', startLine: 1 },
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

    await expect(
      page.locator('[data-node-id="port:typed_instance_ports:pkt_i"] .svsch-type-label', {
        hasText: 'packet_t',
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-node-id="port:typed_instance_ports:state_i"] .svsch-type-label', {
        hasText: 'state_t',
      }),
    ).toBeVisible();
  });

  test('keeps struct wires unlabeled by type name', async ({ page }) => {
    await openFixture(page, 'struct_composition.sv', 'struct');

    await expect(page.locator('[data-node-id="port:struct_composition:opcode_i"]')).toContainText(
      '[3:0]',
    );
    await expect(page.locator('[data-node-id="reg:struct_composition:pkt.opcode"]')).toContainText(
      '[3:0]',
    );
    await expect(page.locator('[data-node-id="port:struct_composition:flat"]')).toContainText(
      '[4:0]',
    );
    await expect(page.locator('.svsch-edge-label >> text=packet_t')).toHaveCount(0);
    // The composition output feeds a plain [4:0] vector — an implicit cast in
    // SV terms — so it routes as a thick multi-bit wire, not a struct route.
    // Its declared net name ("flat") is auto-cut on first open (see
    // withFirstOpenAutoCutEdges), so the wire that carries it is now the
    // cut-stub sink edge running into the flat port, not a live
    // "edge:struct_comp..." edge.
    await expect(page.locator('path.svsch-edge-struct')).toHaveCount(0);
    const castEdge = page.locator('.react-flow__edge[data-id*=":flat:"] path.svsch-edge-thick');
    await expect(castEdge).toHaveCount(1);
    await expect(castEdge.first()).toHaveAttribute('d', /M \d+ \d+ L/);

    await expectGraphAndScreenshot(page, 'struct-wires-without-type-label.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders parametric port widths as clickable parameter tokens', async ({ page }) => {
    // Verify that WIDTH in data_o [WIDTH-1:0] renders as a svsch-param-token
    // (clickable link that navigates to the parameter declaration).
    await openFixture(page, 'parameter_sizing.sv', 'auto', 'many_param_child');

    const dataOutPort = page.locator('[data-node-id="port:many_param_child:data_o"]');
    await expect(dataOutPort).toBeVisible();
    // The port width should show [WIDTH-1:0] with WIDTH as a clickable token.
    await expect(dataOutPort).toContainText('[WIDTH-1:0]');
    const widthToken = dataOutPort.locator('.svsch-param-token', { hasText: 'WIDTH' }).first();
    await expect(widthToken).toBeVisible();

    // Clicking the token should fire a NAVIGATE message to the parameter declaration.
    const messagePromise = page.waitForEvent('console', (message) =>
      message.text().startsWith('NAVIGATE:'),
    );
    await widthToken.click();
    const message = await messagePromise;
    const posted = JSON.parse(message.text().slice('NAVIGATE:'.length).trim());
    expect(posted).toMatchObject({
      type: 'navigateToSource',
      source: { file: 'parameter_sizing.sv' },
    });
  });
});
