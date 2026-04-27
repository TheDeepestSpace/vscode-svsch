import { Given, When, Then, Before, After, setWorldConstructor, World, setDefaultTimeout } from '@cucumber/cucumber';
import { chromium, type Browser, type Page, expect } from '@playwright/test';
import { extractDesignFromText } from '../../src/parser/textExtractor';
import { buildViewModel, mergeNodePositions } from '../../src/layout/mergeLayout';

setDefaultTimeout(20000);

class CustomWorld extends World {
  browser?: Browser;
  page?: Page;
  lastGraph?: any;
  lastViewModel?: any;
  layout: any = { version: 1, modules: {} };
  initialPos?: { x: number, y: number };

  async takeScreenshot(label: string) {
    if (this.page) {
      const screenshot = await this.page.screenshot();
      this.attach(screenshot, 'image/png');
    }
  }

  async postGraph(code: string) {
    const graph = extractDesignFromText([{ file: 'top.sv', text: code }]);
    this.lastGraph = graph;
    const moduleName = graph.rootModules[0];
    const viewModel = await buildViewModel(graph, moduleName, this.layout);
    this.lastViewModel = viewModel;

    // Update layout with ELK positions for newly placed nodes
    this.layout = mergeNodePositions(this.layout, moduleName, viewModel.nodes);

    await this.page?.evaluate((view) => {
      (window as any).postMessage({
        type: 'graph',
        view: view,
        modules: [view.moduleName]
      }, '*');
    }, viewModel);

    await this.page?.waitForSelector('.react-flow__node');
    await this.page?.waitForTimeout(1000);
  }
}

setWorldConstructor(CustomWorld);

Before(async function (this: CustomWorld) {
  this.browser = await chromium.launch();
  this.page = await this.browser.newPage();
  await this.page.setViewportSize({ width: 1400, height: 1000 });
  await this.page.goto('http://127.0.0.1:5174/');
});

After(async function (this: CustomWorld) {
  // Final state screenshot
  await this.takeScreenshot('After');
  await this.browser?.close();
});

async function findNodeIdByLabel(page: Page, label: string, kind?: string): Promise<string | null> {
  return await page.evaluate(({ text, nodeKind }) => {
    const allNodes = Array.from(document.querySelectorAll('.react-flow__node'));
    const targetNode = allNodes.find(node => {
      if (nodeKind) {
        const inner = node.querySelector(`[data-node-kind="${nodeKind}"]`);
        if (!inner) return false;
      }
      
      // Special case for bus nodes which don't show their full name in text labels
      if (nodeKind === 'bus') {
        const id = node.getAttribute('data-id');
        if (id?.includes(text)) return true;
      }

      const labels = Array.from(node.querySelectorAll('.port-skin-label, .node-title, .bus-tap span, .mux-side-port span, .mux-output-port span, .register-port span, .bus-title'));
      return labels.some(l => l.textContent?.trim() === text || l.textContent?.includes(text));
    });
    return targetNode?.getAttribute('data-id') ?? null;
  }, { text: label, nodeKind: kind });
}

Given('a SystemVerilog module:', async function (this: CustomWorld, code: string) {
  await this.postGraph(code);
});

When('I update the code to:', async function (this: CustomWorld, code: string) {
  await this.takeScreenshot('Before Update');
  await this.postGraph(code);
});

When('I update the code to rename register {string} to {string}:', async function (this: CustomWorld, oldName: string, newName: string, code: string) {
  await this.takeScreenshot('Before Rename');
  await this.postGraph(code);
});

When('I update the code to remove the assignment:', async function (this: CustomWorld, code: string) {
  await this.takeScreenshot('Before Removal');
  await this.postGraph(code);
});

When('I reload the diagram', async function (this: CustomWorld) {
  const moduleName = this.lastGraph.rootModules[0];
  const viewModel = await buildViewModel(this.lastGraph, moduleName, this.layout);
  this.lastViewModel = viewModel;

  await this.page?.evaluate((view) => {
    (window as any).postMessage({
      type: 'graph',
      view: view,
      modules: [view.moduleName]
    }, '*');
  }, viewModel);

  await this.page?.waitForSelector('.react-flow__node');
  await this.page?.waitForTimeout(500);
});

Then('I should see a port node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Could not find port node "${name}"`);
  await expect(this.page!.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then('I should see a combinational block', async function (this: CustomWorld) {
  await expect(this.page!.locator('[data-node-kind="comb"]')).toBeVisible();
});

Then('I should see a register node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'register');
  if (!id) throw new Error(`Could not find register node "${name}"`);
  await expect(this.page!.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then('I should not see a register node {string}', async function (this: CustomWorld, name: string) {
  const oldId = `reg:top:${name}`;
  const locator = this.page!.locator(`.react-flow__node[data-id="${oldId}"]`);
  await expect(locator).not.toBeVisible();
});

Then('I should see a bus node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'bus');
  if (!id) {
     // Debug: find what node kind the bus_in might have
     const nodes = await this.page!.evaluate(() => 
       Array.from(document.querySelectorAll('.react-flow__node')).map(n => ({
         id: n.getAttribute('data-id'),
         kind: n.querySelector('[data-node-kind]')?.getAttribute('data-node-kind'),
         text: n.textContent?.trim()
       }))
     );
     throw new Error(`Could not find bus node "${name}". Found: ${JSON.stringify(nodes)}`);
  }
  await expect(this.page!.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

async function checkConnection(page: Page, sourceId: string, targetId: string, negated: boolean = false) {
  const normSource = sourceId.replace(/:/g, '_');
  const normTarget = targetId.replace(/:/g, '_');
  
  const edges = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.react-flow__edge')).map(e => e.getAttribute('data-id'));
  });
  
  const found = edges.some(id => id?.includes(normSource) && id?.includes(normTarget));
  if (negated && found) {
    throw new Error(`Unexpected connection found between ${normSource} and ${normTarget}`);
  }
  if (!negated && !found) {
    throw new Error(`Connection not found between ${normSource} and ${normTarget}. Found edges: ${edges.join(', ')}`);
  }
}

Then('there should be a connection between {string} and {string}', async function (this: CustomWorld, source: string, target: string) {
  const sourceId = await findNodeIdByLabel(this.page!, source);
  const targetId = await findNodeIdByLabel(this.page!, target);
  if (!sourceId || !targetId) throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
  await checkConnection(this.page!, sourceId, targetId);
});

Then('there should not be a connection between {string} and {string}', async function (this: CustomWorld, source: string, target: string) {
  const sourceId = await findNodeIdByLabel(this.page!, source);
  const targetId = await findNodeIdByLabel(this.page!, target);
  if (sourceId && targetId) {
    await checkConnection(this.page!, sourceId, targetId, true);
  }
});

Then('there should be a connection between {string} and the combinational block', async function (this: CustomWorld, source: string) {
  const sourceId = await findNodeIdByLabel(this.page!, source);
  const targetId = await this.page?.evaluate(() => document.querySelector('[data-node-kind="comb"]')?.closest('.react-flow__node')?.getAttribute('data-id'));
  if (!sourceId || !targetId) throw new Error(`Nodes not found: ${source}=${sourceId}, comb=${targetId}`);
  await checkConnection(this.page!, sourceId, targetId);
});

Then('there should be a connection between the combinational block and {string}', async function (this: CustomWorld, target: string) {
  const sourceId = await this.page?.evaluate(() => document.querySelector('[data-node-kind="comb"]')?.closest('.react-flow__node')?.getAttribute('data-id'));
  const targetId = await findNodeIdByLabel(this.page!, target);
  if (!sourceId || !targetId) throw new Error(`Nodes not found: comb=${sourceId}, ${target}=${targetId}`);
  await checkConnection(this.page!, sourceId, targetId);
});

Then('there should be a connection between {string} and the register node {string}', async function (this: CustomWorld, source: string, reg: string) {
  const sourceId = await findNodeIdByLabel(this.page!, source);
  const targetId = await findNodeIdByLabel(this.page!, reg, 'register');
  if (!sourceId || !targetId) throw new Error(`Nodes not found: ${source}=${sourceId}, reg ${reg}=${targetId}`);
  await checkConnection(this.page!, sourceId, targetId);
});

Then('there should be a connection between the bus node {string} and {string}', async function (this: CustomWorld, bus: string, target: string) {
  const sourceId = await findNodeIdByLabel(this.page!, bus, 'bus');
  const targetId = await findNodeIdByLabel(this.page!, target);
  if (!sourceId || !targetId) throw new Error(`Nodes not found: bus ${bus}=${sourceId}, ${target}=${targetId}`);
  await checkConnection(this.page!, sourceId, targetId);
});

When('I move the port node {string} by \\({int}, {int}\\)', async function (this: CustomWorld, name: string, dx: number, dy: number) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const locator = this.page!.locator(`.react-flow__node[data-id="${id}"]`);
  const box = await locator.boundingBox();
  if (box) {
    this.initialPos = { x: box.x, y: box.y };
    await this.page!.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await this.page!.mouse.down();
    await this.page!.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
    await this.page!.mouse.up();
    await this.page!.waitForTimeout(1000);
  }
});

Then('the port node {string} should have moved', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  const locator = this.page!.locator(`.react-flow__node[data-id="${id}"]`);
  const box = await locator.boundingBox();
  if (!box || !this.initialPos) throw new Error('Missing bounding box or initial position');
  expect(box.x).not.toBeCloseTo(this.initialPos.x, 0);
  expect(box.y).not.toBeCloseTo(this.initialPos.y, 0);
});
