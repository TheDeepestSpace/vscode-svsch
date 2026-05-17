import { expect, test } from '@playwright/test';
import { openFixture, paddedGraphClip } from './helper';

test.describe('interface visual rendering', () => {
  test('renders interface ports and patterned aggregate edges', async ({ page }) => {
    await openFixture(page, 'interface_modport.sv', 'interface', 'consumer');

    const busPort = page.locator('[data-node-id="interface:consumer:bus"]');
    const busModport = page.locator('[data-node-id="interface_modport:consumer:bus"]');
    await expect(busPort).toBeVisible();
    await expect(busPort).toHaveClass(/hdl-interface-node/);
    await expect(busPort).toContainText('bus');
    await expect(busPort.locator('.interface-instance-title .svsch-type-label', { hasText: 'simple_if' }).first()).toBeVisible();
    await expect(busPort.locator('.bus-tap-right .interface-side-modport-label', { hasText: 'slave' })).toBeVisible();
    await expect(busModport.locator('.bus-tap-right', { hasText: 'valid' })).toBeVisible();
    await expect(busModport.locator('.bus-tap-left', { hasText: 'ready' })).toBeVisible();

    const tapStyle = await busModport.locator('.bus-tap', { hasText: 'valid' }).first().evaluate((element) => {
      const style = getComputedStyle(element.querySelector('span') ?? element);
      const pipe = getComputedStyle(element, '::before');
      return { color: style.color, pipeColor: pipe.backgroundColor };
    });
    expect(tapStyle.color).not.toBe('rgb(214, 214, 214)');
    expect(tapStyle.pipeColor).not.toBe('rgba(0, 0, 0, 0)');

    await openFixture(page, 'interface_modport.sv', 'interface', 'interface_modport');

    const linkNode = page.locator('[data-node-id="interface:interface_modport:link"]');
    await expect(linkNode).toBeVisible();
    await expect(linkNode).toHaveClass(/hdl-interface-instance/);
    await expect(linkNode.locator('.interface-top-port', { hasText: 'clk' })).toBeVisible();
    await expect(linkNode.locator('.bus-tap-left .interface-side-modport-label')).toHaveText('master');
    await expect(linkNode.locator('.bus-tap-right .interface-side-modport-label')).toHaveText('slave');
    await expect(linkNode.locator('.bus-tap', { hasText: 'simple_if' })).toHaveCount(0);
    await expect(linkNode.locator('.hdl-interface-skin')).toBeVisible();

    const interfaceEdge = page.locator('path.svsch-edge-interface').first();
    await expect(interfaceEdge).toBeAttached();
    const edgeStyle = await interfaceEdge.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        stroke: style.stroke,
        strokeWidth: Number.parseFloat(style.strokeWidth)
      };
    });
    const interfaceBgOpacity = await page.locator('path.svsch-edge-interface-bg').first().evaluate((element) => {
      return Number.parseFloat(getComputedStyle(element).opacity);
    });
    const normalEdgeWidth = await page.locator('path.svsch-edge:not(.svsch-edge-interface):not(.svsch-edge-interface-bg):not(.svsch-edge-struct)').first().evaluate((element) => {
      return Number.parseFloat(getComputedStyle(element).strokeWidth);
    });
    expect(edgeStyle.stroke).toContain('svsch-interface-stripes');
    expect(interfaceBgOpacity).toBeCloseTo(0.5);
    expect(edgeStyle.strokeWidth).toBeGreaterThan(normalEdgeWidth * 2);

    await expect(page).toHaveScreenshot('interface-patterned-edge-canvas.png', { clip: await paddedGraphClip(page) });

    const masterLabelMessagePromise = page.waitForEvent('console', (message) => message.text().startsWith('NAVIGATE:'));
    await linkNode.locator('.bus-tap-left .interface-side-modport-label', { hasText: 'master' }).click();
    const masterLabelMessage = await masterLabelMessagePromise;
    const masterPosted = JSON.parse(masterLabelMessage.text().slice('NAVIGATE:'.length).trim());
    expect(masterPosted).toMatchObject({
      type: 'navigateToSource',
      source: { file: 'interface_modport.sv', startLine: 6 }
    });
  });

  test('renders an interface view without modports as a blue breakout', async ({ page }) => {
    await openFixture(page, 'interface_plain.sv', 'interface', 'interface packet_if');

    const interfaceNode = page.locator('[data-node-kind="interface"]');
    await expect(interfaceNode).toBeVisible();
    await expect(interfaceNode).toHaveClass(/hdl-interface-node/);
    await expect(interfaceNode.locator('.bus-tap', { hasText: 'data' })).toBeVisible();
    await expect(interfaceNode.locator('.bus-tap', { hasText: 'valid' })).toBeVisible();
    await expect(interfaceNode.locator('.interface-modport-title-button')).toHaveCount(0);

    await expect(page).toHaveScreenshot('interface-plain-view-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders interface modports as dual-sided harnesses', async ({ page }) => {
    await openFixture(page, 'interface_modport.sv', 'interface', 'interface simple_if');

    const master = page.locator('[data-node-id="interface_modport:simple_if:master"]');
    const slave = page.locator('[data-node-id="interface_modport:simple_if:slave"]');
    await expect(master).toBeVisible();
    await expect(slave).toBeVisible();
    await expect(master.locator('.interface-modport-title-button')).toHaveText('master');
    await expect(slave.locator('.interface-modport-title-button')).toHaveText('slave');
    await expect(master.locator('.bus-tap-left', { hasText: 'clk' })).toBeVisible();
    await expect(master.locator('.bus-tap-left', { hasText: 'ready' })).toBeVisible();
    await expect(master.locator('.bus-tap-right', { hasText: 'data' })).toBeVisible();
    await expect(master.locator('.bus-tap-right', { hasText: 'valid' })).toBeVisible();
    await expect(slave.locator('.bus-tap-left', { hasText: 'data' })).toBeVisible();
    await expect(slave.locator('.bus-tap-left', { hasText: 'valid' })).toBeVisible();
    await expect(slave.locator('.bus-tap-right', { hasText: 'ready' })).toBeVisible();
    await expect(page.locator('[data-node-id="port:interface_simple_if:clk"]')).toBeVisible();
    await expect(master.locator('.bus-tap')).toHaveText(['clk', 'data', 'valid', 'ready']);
    await expect(slave.locator('.bus-tap')).toHaveText(['clk', 'data', 'valid', 'ready']);

    await expect(page).toHaveScreenshot('interface-modport-view-canvas.png', { clip: await paddedGraphClip(page) });
  });
});
