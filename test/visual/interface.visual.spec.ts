import { expect, test } from '@playwright/test';
import { canvasClip, fitGraphView, openFixture, paddedGraphClip } from './helper';

test.describe('interface visual rendering', () => {
  test('renders interface ports and patterned aggregate edges', async ({ page }) => {
    await openFixture(page, 'interface_modport.sv', 'interface', 'consumer');

    const busPort = page.locator('[data-node-id="interface:consumer:bus"]');
    const busModport = page.locator('[data-node-id="interface_modport:consumer:bus"]');
    await expect(busPort).toBeVisible();
    await expect(busPort).toHaveClass(/hdl-interface-node/);
    await expect(busPort).toHaveClass(/hdl-port-skinned/);
    await expect(busPort).toContainText('bus');
    await expect(busPort.locator('.port-skin-harness')).toBeVisible();
    await expect(busPort.locator('.port-skin-label .svsch-type-label', { hasText: 'simple_if' }).first()).toBeVisible();
    await expect(busPort.locator('.port-skin-label .svsch-modport-label', { hasText: 'slave' }).first()).toBeVisible();
    await expect(busModport.locator('.bus-tap-right', { hasText: 'valid' })).toBeVisible();
    await expect(busModport.locator('.bus-tap-left', { hasText: 'ready' })).toBeVisible();

    const tapStyle = await busModport.locator('.bus-tap', { hasText: 'valid' }).first().evaluate((element) => {
      const style = getComputedStyle(element.querySelector('span') ?? element);
      const pipe = getComputedStyle(element, '::before');
      return { color: style.color, pipeColor: pipe.backgroundColor };
    });
    expect(tapStyle.color).not.toBe('rgb(214, 214, 214)');
    expect(tapStyle.pipeColor).not.toBe('rgba(0, 0, 0, 0)');

    const patternedView = await openFixture(page, 'interface_modport.sv', 'auto', 'interface_modport');

    const linkNode = page.locator('[data-node-id="interface:interface_modport:link"]');
    await expect(linkNode).toBeVisible();
    await expect(linkNode).toHaveClass(/hdl-interface-instance/);
    await expect(linkNode.locator('.interface-top-port', { hasText: 'clk' })).toBeVisible();
    await expect(linkNode.locator('.bus-tap-left .interface-side-modport-label')).toHaveText('master');
    await expect(linkNode.locator('.bus-tap-right .interface-side-modport-label')).toHaveText('slave');
    await expect(linkNode.locator('.bus-tap', { hasText: 'simple_if' })).toHaveCount(0);
    await expect(linkNode.locator('.hdl-interface-skin')).toBeVisible();

    const linkInterfaceRoutes = patternedView.edges
      .filter((edge) => edge.source === 'interface:interface_modport:link' || edge.target === 'interface:interface_modport:link')
      .filter((edge) => edge.sourcePort?.includes('slave') || edge.targetPort?.includes('master'))
      .map((edge) => edge.routePoints ?? []);
    expect(linkInterfaceRoutes).toHaveLength(2);
    for (const route of linkInterfaceRoutes) {
      expect(new Set(route.map((point) => point.y)).size).toBe(1);
    }

    const interfaceEdge = page.locator('path.svsch-edge-interface').first();
    await expect(interfaceEdge).toBeAttached();
    const edgeStyle = await interfaceEdge.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        stroke: style.stroke,
        strokeWidth: Number.parseFloat(style.strokeWidth)
      };
    });
    const interfaceBgStyle = await page.locator('path.svsch-edge-interface-bg').first().evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        opacity: Number.parseFloat(style.opacity),
        stroke: style.stroke
      };
    });
    const normalEdgeWidth = await page.locator('path.svsch-edge:not(.svsch-edge-interface):not(.svsch-edge-interface-bg):not(.svsch-edge-struct)').first().evaluate((element) => {
      return Number.parseFloat(getComputedStyle(element).strokeWidth);
    });
    expect(edgeStyle.stroke).toContain('svsch-interface-stripes');
    expect(interfaceBgStyle.opacity).toBeCloseTo(1);
    expect(interfaceBgStyle.stroke).not.toBe(edgeStyle.stroke);
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
    await expect(page.locator('.svsch-edge-junction')).toHaveCount(1);
    await expect(page.locator('.svsch-edge-junction')).toHaveAttribute('r', '4.75');
    await expect(page.locator('.svsch-edge-junction-interface')).toHaveCount(0);

    await expect(page).toHaveScreenshot('interface-modport-view-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders multi-modport interface instances with separate side taps and top inputs', async ({ page }) => {
    const view = await openFixture(page, 'interface_multi_modport.sv', 'auto', 'interface_multi_modport');

    const stream = page.locator('[data-node-id="interface:interface_multi_modport:stream"]');
    await expect(stream).toBeVisible();
    await expect(stream).toHaveClass(/hdl-interface-instance/);
    await expect(stream.locator('.hdl-interface-skin-with-tophat')).toBeVisible();
    await expect(stream.locator('.interface-top-port', { hasText: 'clk' })).toBeVisible();
    await expect(stream.locator('.interface-top-port', { hasText: 'rst_n' })).toBeVisible();
    await expect(stream.locator('.hdl-interface-top-feed')).toHaveCount(0);

    const topPortY = await stream.locator('.interface-top-port', { hasText: 'clk' }).evaluate((port) => {
      return Number.parseFloat((port as HTMLElement).style.top);
    });
    const topHandleGeometry = await stream.locator('.interface-top-port .react-flow__handle-top').first().evaluate((handle) => {
      const box = handle.getBoundingClientRect();
      const portBox = handle.closest('.interface-top-port')?.getBoundingClientRect();
      return {
        height: box.height,
        top: Math.round(box.top),
        portTop: portBox ? Math.round(portBox.top) : Number.NaN
      };
    });
    expect(topHandleGeometry.height).toBe(0);
    expect(topHandleGeometry.top).toBe(topHandleGeometry.portTop);
    const streamNode = view.nodes.find((node) => node.id === 'interface:interface_multi_modport:stream');
    expect(streamNode).toBeDefined();
    const expectedTopEdgeY = (streamNode?.position.y ?? 0) + topPortY;
    const topEdgeEndYs = await page.locator('path.svsch-edge').evaluateAll((paths) => {
      return paths
        .map((path) => path.getAttribute('d') ?? '')
        .map((d) => d.trim().match(/L (528|552|576|600) (-?\d+(?:\.\d+)?)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => Number(match[2]));
    });
    expect(topEdgeEndYs.length).toBeGreaterThan(0);
    expect(topEdgeEndYs).toContain(expectedTopEdgeY);

    const leftLabels = stream.locator('.bus-tap-left .interface-side-modport-label');
    const rightLabels = stream.locator('.bus-tap-right .interface-side-modport-label');
    await expect(leftLabels).toHaveText(['producer', 'controller']);
    await expect(rightLabels).toHaveText(['consumer', 'monitor']);

    const tapBoxes = await stream.locator('.bus-tap .interface-side-modport-label').evaluateAll((labels) => {
      return labels.map((label) => {
        const tap = label.closest('.bus-tap') as HTMLElement;
        const box = tap.getBoundingClientRect();
        return {
          text: label.textContent?.trim(),
          left: tap.classList.contains('bus-tap-left'),
          top: Math.round(box.top)
        };
      });
    });
    const producer = tapBoxes.find((tap) => tap.text === 'producer');
    const controller = tapBoxes.find((tap) => tap.text === 'controller');
    const consumer = tapBoxes.find((tap) => tap.text === 'consumer');
    const monitor = tapBoxes.find((tap) => tap.text === 'monitor');
    expect(producer?.left).toBe(true);
    expect(controller?.left).toBe(true);
    expect(consumer?.left).toBe(false);
    expect(monitor?.left).toBe(false);
    expect(new Set(tapBoxes.map((tap) => tap.top)).size).toBeGreaterThan(1);

    await expect(page).toHaveScreenshot('interface-multi-modport-instance-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders alternate multi-modport interface arrangements', async ({ page }) => {
    await openFixture(page, 'interface_modport_arrangements.sv', 'auto', 'interface_uneven_modport');

    const uneven = page.locator('[data-node-id="interface:interface_uneven_modport:link"]');
    await expect(uneven).toBeVisible();
    await expect(uneven.locator('.bus-tap-left .interface-side-modport-label')).toHaveText(['producer', 'controller']);
    await expect(uneven.locator('.bus-tap-right .interface-side-modport-label')).toHaveText(['consumer']);
    await expect(uneven.locator('.interface-top-port', { hasText: 'clk' })).toBeVisible();
    await expect(uneven.locator('.interface-top-port', { hasText: 'rst_n' })).toBeVisible();
    await expect(page).toHaveScreenshot('interface-uneven-modport-instance-canvas.png', { clip: await paddedGraphClip(page) });

    await openFixture(page, 'interface_modport_arrangements.sv', 'auto', 'interface_consumer_fanout');

    const fanout = page.locator('[data-node-id="interface:interface_consumer_fanout:link"]');
    await expect(fanout).toBeVisible();
    await expect(fanout.locator('.bus-tap-left .interface-side-modport-label')).toHaveText(['producer', 'controller']);
    await expect(fanout.locator('.bus-tap-right .interface-side-modport-label')).toHaveText(['consumer']);
    await expect(page.locator('[data-node-id="instance:interface_consumer_fanout:u_sink0"]')).toBeVisible();
    await expect(page.locator('[data-node-id="instance:interface_consumer_fanout:u_sink1"]')).toBeVisible();
    await expect(page.locator('[data-node-id="instance:interface_consumer_fanout:u_sink2"]')).toBeVisible();
    expect(await page.locator('.svsch-edge-junction').count()).toBeGreaterThan(0);
    await expect(page.locator('.svsch-edge-junction-interface').first()).toHaveAttribute('r', '6.5');
    await expect(page).toHaveScreenshot('interface-consumer-fanout-canvas.png', { clip: await paddedGraphClip(page) });

    await openFixture(page, 'interface_modport_arrangements.sv', 'auto', 'interface_all_left_modports');

    const allLeft = page.locator('[data-node-id="interface:interface_all_left_modports:request_bus"]');
    await expect(allLeft).toBeVisible();
    await expect(allLeft.locator('.bus-tap-left .interface-side-modport-label')).toHaveText(['requester', 'arbiter']);
    await expect(allLeft.locator('.bus-tap-right .interface-side-modport-label')).toHaveCount(0);
    await expect(page).toHaveScreenshot('interface-all-left-modports-canvas.png', { clip: await paddedGraphClip(page) });

    await openFixture(page, 'interface_modport_arrangements.sv', 'auto', 'interface_all_right_modports');

    const allRight = page.locator('[data-node-id="interface:interface_all_right_modports:event_bus"]');
    await expect(allRight).toBeVisible();
    await expect(allRight.locator('.bus-tap-left .interface-side-modport-label')).toHaveCount(0);
    await expect(allRight.locator('.bus-tap-right .interface-side-modport-label')).toHaveText(['sink', 'observer']);
    await expect(page).toHaveScreenshot('interface-all-right-modports-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders modules with multiple interface modport ports', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 760 });
    const bridgeTopView = await openFixture(page, 'interface_modport_arrangements.sv', 'auto', 'interface_dual_modport_bridge');
    await fitGraphView(page);

    const upstream = page.locator('[data-node-id="interface:interface_dual_modport_bridge:upstream"]');
    const downstream = page.locator('[data-node-id="interface:interface_dual_modport_bridge:downstream"]');
    const bridge = page.locator('[data-node-id="instance:interface_dual_modport_bridge:u_bridge"]');
    await expect(upstream).toBeVisible();
    await expect(downstream).toBeVisible();
    await expect(bridge).toBeVisible();
    await expect(upstream).toBeInViewport({ ratio: 0.98 });
    await expect(downstream).toBeInViewport({ ratio: 0.98 });
    await expect(bridge).toBeInViewport({ ratio: 0.98 });
    await expect(bridge).toContainText('upstream');
    await expect(bridge).toContainText('downstream');
    expect(bridgeTopView.nodes.find((node) => node.id === 'interface:interface_dual_modport_bridge:upstream')).toBeDefined();
    expect(bridgeTopView.nodes.find((node) => node.id === 'interface:interface_dual_modport_bridge:downstream')).toBeDefined();
    expect(bridgeTopView.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'interface:interface_dual_modport_bridge:upstream',
        target: 'instance:interface_dual_modport_bridge:u_bridge',
        targetPort: 'port:upstream'
      }),
      expect.objectContaining({
        source: 'instance:interface_dual_modport_bridge:u_bridge',
        sourcePort: 'port:downstream',
        target: 'interface:interface_dual_modport_bridge:downstream'
      })
    ]));
    await expect(page).toHaveScreenshot('interface-dual-modport-bridge-top-canvas.png', { clip: await canvasClip(page) });

    await openFixture(page, 'interface_modport_arrangements.sv', 'auto', 'pair_bridge');
    await fitGraphView(page);

    const upstreamPort = page.locator('[data-node-id="interface:pair_bridge:upstream"]');
    const downstreamPort = page.locator('[data-node-id="interface:pair_bridge:downstream"]');
    const upstreamModport = page.locator('[data-node-id="interface_modport:pair_bridge:upstream"]');
    const downstreamModport = page.locator('[data-node-id="interface_modport:pair_bridge:downstream"]');
    await expect(upstreamPort).toBeVisible();
    await expect(downstreamPort).toBeVisible();
    await expect(upstreamModport).toBeVisible();
    await expect(downstreamModport).toBeVisible();
    await expect(upstreamPort).toBeInViewport({ ratio: 0.98 });
    await expect(downstreamPort).toBeInViewport({ ratio: 0.98 });
    await expect(upstreamModport).toBeInViewport({ ratio: 0.98 });
    await expect(downstreamModport).toBeInViewport({ ratio: 0.98 });
    await expect(upstreamPort).toHaveClass(/hdl-port-skinned/);
    await expect(downstreamPort).toHaveClass(/hdl-port-skinned/);
    await expect(upstreamPort.locator('.port-skin-label .svsch-modport-label', { hasText: 'master' }).first()).toBeVisible();
    await expect(downstreamPort.locator('.port-skin-label .svsch-modport-label', { hasText: 'slave' }).first()).toBeVisible();
    await expect(page).toHaveScreenshot('interface-dual-modport-bridge-module-canvas.png', { clip: await canvasClip(page) });
  });

  test('renders interface instance scalar outputs with a bottom cap', async ({ page }) => {
    const outputView = await openFixture(page, 'interface_modport_arrangements.sv', 'auto', 'interface_output_wire');

    const status = page.locator('[data-node-id="interface:interface_output_wire:status"]');
    await expect(status).toBeVisible();
    await expect(status.locator('.hdl-interface-skin-with-tophat')).toBeVisible();
    await expect(status.locator('.hdl-interface-skin-with-bottomhat')).toBeVisible();
    await expect(status.locator('.interface-top-port', { hasText: 'clk' })).toBeVisible();
    await expect(status.locator('.interface-top-port', { hasText: 'rst_n' })).toBeVisible();
    await expect(status.locator('.interface-bottom-port', { hasText: 'done' })).toBeVisible();
    await expect(page.locator('[data-node-id="port:interface_output_wire:done"]')).toBeVisible();
    expect(outputView.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'interface:interface_output_wire:status',
        sourcePort: 'out:done',
        target: 'port:interface_output_wire:done'
      })
    ]));

    await expect(page).toHaveScreenshot('interface-output-wire-canvas.png', { clip: await paddedGraphClip(page) });
  });
});
