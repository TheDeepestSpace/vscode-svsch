import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openFixture, paddedGraphClip, paddedLocatorClip } from './helper';

const parameterRow = (page: Page, name: string) => page
  .locator('.module-parameter-row')
  .filter({ has: page.locator('.module-parameter-name', { hasText: new RegExp(`^${name}$`) }) });

test.describe('parameter visual rendering', () => {
  test('renders module parameters and symbolic port widths as inline metadata', async ({ page }) => {
    await openFixture(page, 'parameter_sizing.sv', 'auto', 'param_child');

    await expect(page.locator('.module-parameter-table')).toContainText('param_child');
    await expect(page.locator('.module-parameter-table')).toContainText('Meta-parameters:');
    await expect(page.locator('.module-parameter-table')).toContainText('Localparams:');
    await expect(parameterRow(page, 'WIDTH')).toContainText('8');
    await expect(parameterRow(page, 'DEPTH')).toContainText('4');
    await expect(parameterRow(page, 'TOTAL')).toContainText('WIDTH + DEPTH');
    await expect(page.locator('[data-node-id="port:param_child:data_i"] .svsch-param-token', { hasText: 'WIDTH' })).toBeVisible();
    await expect(page.locator('[data-node-id="port:param_child:data_o"] .svsch-param-token', { hasText: 'WIDTH' })).toBeVisible();

    await expect(page).toHaveScreenshot('parameter-symbolic-widths-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders parameter values and symbolic overrides on module instance blocks', async ({ page }) => {
    await openFixture(page, 'parameter_sizing.sv', 'auto', 'parameter_sizing_top');

    const defaultInstance = page.locator('[data-node-id="instance:parameter_sizing_top:u_default"]');
    const overrideInstance = page.locator('[data-node-id="instance:parameter_sizing_top:u_override"]');

    await expect(parameterRow(page, 'TOP_W')).toContainText('12');
    await expect(parameterRow(page, 'DEPTH_OVERRIDE')).toContainText('2');
    await expect(defaultInstance.locator('.instance-parameter-chip', { hasText: 'WIDTH' })).toContainText('8');
    await expect(defaultInstance.locator('.instance-parameter-chip', { hasText: 'DEPTH' })).toContainText('4');
    await expect(overrideInstance.locator('.instance-parameter-chip', { hasText: 'WIDTH' })).toContainText('TOP_W');
    await expect(overrideInstance.locator('.instance-parameter-chip', { hasText: 'DEPTH' })).toContainText('DEPTH_OVERRIDE');
    await expect(overrideInstance.locator('.instance-parameter-chip', { hasText: 'DEPTH' }).locator('.svsch-param-token', { hasText: 'DEPTH_OVERRIDE' })).toBeVisible();

    await expect(page).toHaveScreenshot('parameterized-instance-node.png', {
      clip: await paddedLocatorClip(page, '[data-node-id="instance:parameter_sizing_top:u_override"]')
    });
  });

  test('stacks many instance parameters without truncating compile-time expressions', async ({ page }) => {
    await openFixture(page, 'parameter_sizing.sv', 'auto', 'many_parameter_top');

    const instance = page.locator('[data-node-id="instance:many_parameter_top:u_many"]');
    const chips = instance.locator('.instance-parameter-chip');

    await expect(chips).toHaveCount(5);
    await expect(chips.nth(0)).toContainText('WIDTH=TOP_W');
    await expect(chips.nth(1)).toContainText('ADDR_W=TOP_ADDR');
    await expect(chips.nth(2)).toContainText('DEPTH=LOCAL_DEPTH');
    await expect(chips.nth(3)).toContainText('MASK=LOCAL_MASK');
    await expect(chips.nth(4)).toContainText('MODE=TOP_W + TOP_ADDR');

    const boxes = await chips.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }));
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index].top).toBeGreaterThan(boxes[index - 1].top);
    }
    for (const box of boxes) {
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    }

    await expect(page).toHaveScreenshot('many-parameterized-instance-node.png', {
      clip: await paddedLocatorClip(page, '[data-node-id="instance:many_parameter_top:u_many"]')
    });
  });
});
