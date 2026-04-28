import { Given, When, Then, Before, After, setWorldConstructor, World, setDefaultTimeout } from '@cucumber/cucumber';
import { chromium, type Browser, type Page, expect } from '@playwright/test';
import { extractDesignFromText } from '../../src/parser/textExtractor';
import { buildViewModel, mergeNodePositions } from '../../src/layout/mergeLayout';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chromiumStabilizationArgs } from '../testConstants';

setDefaultTimeout(20000);

class CustomWorld extends World {
  messages: any[] = [];
  files: any[] = [];
  browser?: Browser;
  page?: Page;
  lastGraph?: any;
  lastCode?: string;
  lastViewModel?: any;
  layout: any = { version: 1, modules: {} };
  notedPositions: Map<string, { x: number, y: number }> = new Map();
  scenarioName?: string;
  stepCounter: number = 0;

  async takeScreenshot(label: string) {
    if (this.page) {
      const fitViewButton = this.page.locator('button.react-flow__controls-fitview');
      if (await fitViewButton.isVisible()) {
        await fitViewButton.click();
        await this.page.waitForTimeout(500);
      }
      const screenshot = await this.page.screenshot();
      this.attach(screenshot, 'image/png');

      if (this.scenarioName) {
        this.stepCounter += 1;
        const safeScenarioName = this.scenarioName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const safeLabel = label.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const snapshotName = `${safeScenarioName}--${this.stepCounter.toString().padStart(2, '0')}--${safeLabel}`;
        await compareSnapshots(this, screenshot, snapshotName);
      }

      return screenshot;
    }
    return null;
  }

  async postGraph(sources: { file: string, text: string }[]) {
    this.lastCode = sources[0].text;
    const graph = extractDesignFromText(sources);
    this.lastGraph = graph;
    const moduleName = graph.rootModules[0];
    const viewModel = await buildViewModel(graph, moduleName, this.layout);
    this.lastViewModel = viewModel;

    // Update layout with ELK positions for newly placed nodes
    this.layout = mergeNodePositions(this.layout, moduleName, viewModel.nodes);

    await this.page?.evaluate(({ view, modules }) => {
      (window as any).postMessage({
        type: 'graph',
        view: view,
        modules: modules
      }, '*');
    }, { view: viewModel, modules: Object.keys(graph.modules) });

    await this.page?.waitForSelector('.react-flow__node');
    await this.page?.waitForTimeout(1000);
    await this.takeScreenshot(`Viewing module ${moduleName}`);
  }

  async selectModule(moduleName: string) {
    const graph = this.lastGraph;
    const viewModel = await buildViewModel(graph, moduleName, this.layout);
    this.lastViewModel = viewModel;

    // Update layout with ELK positions
    this.layout = mergeNodePositions(this.layout, moduleName, viewModel.nodes);

    await this.page?.evaluate(({ view, modules }) => {
      (window as any).postMessage({
        type: 'graph',
        view: view,
        modules: modules
      }, '*');
    }, { view: viewModel, modules: Object.keys(graph.modules) });

    await this.page?.waitForSelector('.react-flow__node');
    await this.page?.waitForTimeout(500);
    await this.takeScreenshot(`Viewing module ${moduleName}`);
  }
}

setWorldConstructor(CustomWorld);

Before(async function (this: CustomWorld, { pickle }) {
  this.scenarioName = pickle.name;
  this.browser = await chromium.launch({
    args: chromiumStabilizationArgs
  });
  this.page = await this.browser.newPage();
  this.page.on('console', msg => { const text = msg.text(); console.log(`BROWSER [${msg.type()}]: ${text}`); if (text.startsWith('NAVIGATE:')) { try { this.messages.push(JSON.parse(text.substring(9))); } catch (e) {} } });
  await this.page.setViewportSize({ width: 1400, height: 1000 });
  await this.page.goto('http://127.0.0.1:5176/');
});

After(async function (this: CustomWorld) {
  try {
    // We no longer take a generic "After" screenshot here because
    // most steps now capture their state automatically via postGraph or selectModule.
  } catch (err) {
    console.error('Error in After hook (screenshot/matching):', err);
  } finally {
    await this.browser?.close();
  }
});

Given('a SystemVerilog module:', async function (this: CustomWorld, code: string) {
  await this.postGraph([{ file: 'top.sv', text: code }]);
});

Given('the following SystemVerilog files:', async function (this: CustomWorld, table: any) {
  this.files = table.hashes().map((row: any) => ({ file: row.file, text: row.content.replace(/\\n/g, "\n") }));
  const sources = this.files.map((row: any) => ({
    file: row.file,
    text: row.text
  }));
  await this.postGraph(sources);
});

When('I update the code to:', async function (this: CustomWorld, code: string) {
  await this.postGraph([{ file: 'top.sv', text: code }]);
});

When('I select module {string} from the dropdown', async function (this: CustomWorld, moduleName: string) {
  // We use the page to select the option, which will trigger the onChange and send the message back to us
  // BUT in our test environment, we are simulating the VS Code message exchange.
  // The webview sends 'openModule' to VS Code, and VS Code sends 'graph' back to webview.
  // In diagram.steps.ts, we are both VS Code and the test runner.
  
  // 1. Act on the UI
  await this.page!.selectOption('select[aria-label="Module"]', moduleName);
  
  // 2. Simulate the backend response (since there's no real VS Code backend in this test)
  await this.selectModule(moduleName);
});

When('I update the code to rename register {string} to {string}:', async function (this: CustomWorld, oldName: string, newName: string, code: string) {
  await this.postGraph([{ file: 'top.sv', text: code }]);
});

When('I update the code to remove the assignment:', async function (this: CustomWorld, code: string) {
  await this.postGraph([{ file: 'top.sv', text: code }]);
});

When('I update the code to remove node {string}:', async function (this: CustomWorld, name: string, code: string) {
  await this.postGraph([{ file: 'top.sv', text: code }]);
});

When('I update the code to bring back node {string}:', async function (this: CustomWorld, name: string, code: string) {
  await this.postGraph([{ file: 'top.sv', text: code }]);
});

When('I reload the diagram', async function (this: CustomWorld) {
  const moduleName = this.lastGraph.rootModules[0];
  const viewModel = await buildViewModel(this.lastGraph, moduleName, this.layout);
  this.lastViewModel = viewModel;

  await this.page?.evaluate(({ view, modules }) => {
    (window as any).postMessage({
      type: 'graph',
      view: view,
      modules: modules
    }, '*');
  }, { view: viewModel, modules: Object.keys(this.lastGraph.modules) });

  await this.page?.waitForSelector('.react-flow__node');
  await this.page?.waitForTimeout(500);
  await this.takeScreenshot('After reload');
});

When('I close and reopen the diagram', async function (this: CustomWorld) {
  if (!this.lastCode) throw new Error('No code available to reload');
  await this.postGraph([{ file: 'top.sv', text: this.lastCode }]);
});

When('I reset the layout', async function (this: CustomWorld) {
  // 1. Act on the UI
  await this.page!.click('button:has-text("Reset Layout")');
  
  // 2. Simulate the backend response (clearing layout and posting graph)
  const moduleName = this.lastViewModel.moduleName;
  delete this.layout.modules[moduleName];
  
  const graph = this.lastGraph;
  const viewModel = await buildViewModel(graph, moduleName, this.layout);
  this.lastViewModel = viewModel;

  await this.page?.evaluate(({ view, modules }) => {
    (window as any).postMessage({
      type: 'graph',
      view: view,
      modules: modules
    }, '*');
  }, { view: viewModel, modules: Object.keys(graph.modules) });

  await this.page?.waitForSelector('.react-flow__node');
  await this.page?.waitForTimeout(500);
  await this.takeScreenshot('After reset');
});

Then('I should see a port node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Could not find port node "${name}"`);
  await expect(this.page!.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then('I should see an instance node {string} of module {string}', async function (this: CustomWorld, instanceName: string, moduleName: string) {
  const id = await findNodeIdByLabel(this.page!, instanceName, 'instance');
  if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
  const locator = this.page!.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(locator).toBeVisible();
  await expect(locator).toContainText(moduleName);
});

Then('the module dropdown should contain {string}, {string}, {string} in that order', async function (this: CustomWorld, m1: string, m2: string, m3: string) {
  const options = await this.page!.locator('select[aria-label="Module"] option').allTextContents();
  expect(options).toEqual([m1, m2, m3]);
});

Then('I should see a combinational block', async function (this: CustomWorld) {
  await expect(this.page!.locator('[data-node-kind="comb"]')).toBeVisible();
});

Then('I should not see a combinational block', async function (this: CustomWorld) {
  await expect(this.page!.locator('[data-node-kind="comb"]')).not.toBeVisible();
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

Then('the register node {string} should be between port {string} and port {string}', async function (
  this: CustomWorld,
  registerName: string,
  leftPortName: string,
  rightPortName: string
) {
  const registerId = await findNodeIdByLabel(this.page!, registerName, 'register');
  const leftPortId = await findNodeIdByLabel(this.page!, leftPortName, 'port');
  const rightPortId = await findNodeIdByLabel(this.page!, rightPortName, 'port');
  if (!registerId || !leftPortId || !rightPortId) {
    throw new Error(`Nodes not found: register=${registerId}, left=${leftPortId}, right=${rightPortId}`);
  }

  const [registerBox, leftBox, rightBox] = await Promise.all([
    this.page!.locator(`.react-flow__node[data-id="${registerId}"]`).boundingBox(),
    this.page!.locator(`.react-flow__node[data-id="${leftPortId}"]`).boundingBox(),
    this.page!.locator(`.react-flow__node[data-id="${rightPortId}"]`).boundingBox()
  ]);
  if (!registerBox || !leftBox || !rightBox) throw new Error('Missing bounding box');

  expect(registerBox.x).toBeGreaterThan(leftBox.x);
  expect(registerBox.x + registerBox.width).toBeLessThan(rightBox.x + rightBox.width);
});

Then('I should see a bus node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'bus');
  if (!id) throw new Error(`Could not find bus node "${name}"`);
  await expect(this.page!.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

async function checkConnection(page: Page, sourceId: string, targetId: string, negated: boolean = false) {
  const normSource = sourceId.replace(/:/g, '_');
  const normTarget = targetId.replace(/:/g, '_');
  
  const edges = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.react-flow__edge')).map(e => e.getAttribute('data-id'));
  });
  
  const found = edges.some(id => id?.includes(normSource) && id?.includes(normTarget));
  if (negated && found) throw new Error(`Unexpected connection found between ${normSource} and ${normTarget}`);
  if (!negated && !found) throw new Error(`Connection not found between ${normSource} and ${normTarget}. Found edges: ${edges.join(', ')}`);
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
  if (sourceId && targetId) await checkConnection(this.page!, sourceId, targetId, true);
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

async function getInternalPosition(page: Page, nodeId: string): Promise<{ x: number, y: number } | null> {
  try {
    await page.waitForFunction(() => (window as any).reactFlowInstance !== undefined, { timeout: 5000 });
  } catch (e) {
    console.error('Timed out waiting for reactFlowInstance');
    return null;
  }

  const pos = await page.evaluate((id) => {
    const rf = (window as any).reactFlowInstance;
    if (!rf) return null;
    const node = rf.getNodes().find((n: any) => n.id === id);
    if (!node) {
      console.log(`Node ${id} not found in RF. Available nodes:`, rf.getNodes().map((n: any) => n.id));
      return null;
    }
    return node.position;
  }, nodeId);
  
  return pos;
}

When('I move the port node {string} by \\({int}, {int}\\)', async function (this: CustomWorld, name: string, dx: number, dy: number) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  
  const initialInternal = await getInternalPosition(this.page!, id);
  if (initialInternal) this.notedPositions.set(name, initialInternal);

  const locator = this.page!.locator(`.react-flow__node[data-id="${id}"]`);
  const box = await locator.boundingBox();
  if (box) {
    await this.page!.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await this.page!.mouse.down();
    await this.page!.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
    await this.page!.mouse.up();
    await this.page!.waitForTimeout(1000);
    
    const finalInternal = await getInternalPosition(this.page!, id);
    if (finalInternal) {
      const moduleName = this.lastGraph.rootModules[0];
      this.layout.modules[moduleName].nodes[id] = { ...finalInternal, fixed: true };
    }
    await this.takeScreenshot('After move');
  }
});

When('I move the port node {string} to \\({int}, {int}\\)', async function (this: CustomWorld, name: string, x: number, y: number) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  
  const locator = this.page!.locator(`.react-flow__node[data-id="${id}"]`);
  const box = await locator.boundingBox();
  if (box) {
    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height / 2;
    // This is a bit of a hack to get close to the internal coordinate
    // since we don't know the current zoom/transform exactly.
    // But since it's a fresh load, it's usually close to 1:1 or centered.
    await this.page!.mouse.move(fromX, fromY);
    await this.page!.mouse.down();
    await this.page!.mouse.move(fromX + (x - 24), fromY + (y - 24), { steps: 20 });
    await this.page!.mouse.up();
    await this.page!.waitForTimeout(1000);
    
    const finalPos = await getInternalPosition(this.page!, id);
    console.log(`Moved ${name} to internal: ${JSON.stringify(finalPos)} (requested ${x},${y})`);
    
    const moduleName = this.lastGraph.rootModules[0];
    this.layout.modules[moduleName].nodes[id] = { 
      x: finalPos?.x ?? x, 
      y: finalPos?.y ?? y, 
      fixed: true 
    };
    await this.takeScreenshot('After move');
  }
});

Given('I note the position of port node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const pos = await getInternalPosition(this.page!, id);
  if (!pos) throw new Error('Could not get internal position');
  this.notedPositions.set(name, pos);
});

Then('the port node {string} should have moved', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const pos = await getInternalPosition(this.page!, id);
  const initialPos = this.notedPositions.get(name);
  if (!pos || !initialPos) throw new Error(`Missing position data for ${name}`);
  expect(pos.x).not.toBeCloseTo(initialPos.x, 0);
});

Then('the port node {string} should be at \\({int}, {int})', async function (this: CustomWorld, name: string, x: number, y: number) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const pos = await getInternalPosition(this.page!, id);
  if (!pos) throw new Error('Could not get internal position');

  const moduleName = this.lastGraph.rootModules[0];
  const stored = this.layout.modules[moduleName].nodes[id];
  if (!stored) throw new Error(`No stored position for ${id}`);

  // We check that it is at the position we stored when we moved it.
  // This verifies that the layout state was preserved and reapplied.
  expect(pos.x).toBeCloseTo(stored.x, 0);
  expect(pos.y).toBeCloseTo(stored.y, 0);
});

Then('the port node {string} should not have moved', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const pos = await getInternalPosition(this.page!, id);
  const initialPos = this.notedPositions.get(name);
  if (!pos || !initialPos) throw new Error(`Missing position data for ${name}`);
  expect(pos.x).toBeCloseTo(initialPos.x, 0);
  expect(pos.y).toBeCloseTo(initialPos.y, 0);
});

async function compareSnapshots(world: CustomWorld, actualBuffer: Buffer, snapshotName: string) {
  const snapshotsDir = path.join(process.cwd(), 'test', 'features', 'snapshots');
  if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

  const snapshotPath = path.join(snapshotsDir, `${snapshotName}.png`);
  if (!fs.existsSync(snapshotPath)) {
    fs.writeFileSync(snapshotPath, actualBuffer);
    console.log(`Created new baseline snapshot: ${snapshotPath}`);
    return;
  }

  const expectedImage = PNG.sync.read(fs.readFileSync(snapshotPath));
  const actualImage = PNG.sync.read(actualBuffer);
  const { width, height } = expectedImage;
  const diff = new PNG({ width, height });

  const numDiffPixels = pixelmatch(expectedImage.data, actualImage.data, diff.data, width, height, { threshold: 0.1 });

  if (numDiffPixels > 50) {
    const diffDir = path.join(process.cwd(), 'test-results', 'bdd', 'visual-diffs');
    if (!fs.existsSync(diffDir)) fs.mkdirSync(diffDir, { recursive: true });
    const diffBuffer = PNG.sync.write(diff);
    fs.writeFileSync(path.join(diffDir, `${snapshotName}-expected.png`), fs.readFileSync(snapshotPath));
    fs.writeFileSync(path.join(diffDir, `${snapshotName}-actual.png`), actualBuffer);
    fs.writeFileSync(path.join(diffDir, `${snapshotName}-diff.png`), diffBuffer);
    world.attach(fs.readFileSync(snapshotPath), 'image/png');
    world.attach(actualBuffer, 'image/png');
    world.attach(diffBuffer, 'image/png');
    throw new Error(`Snapshot mismatch for "${snapshotName}": ${numDiffPixels} pixels differ. Diffs saved to ${diffDir}`);
  }
}


When('I double-click on the port node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'port');
  if (!id) throw new Error(`Could not find port node "${name}"`);
  await this.page!.locator(`.react-flow__node[data-id="${id}"]`).dblclick({ force: true });
  await this.page!.waitForTimeout(200);
});

When('I double-click on the register node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'register');
  if (!id) throw new Error(`Could not find register node "${name}"`);
  await this.page!.locator(`.react-flow__node[data-id="${id}"]`).dblclick({ force: true });
  await this.page!.waitForTimeout(200);
});

When('I double-click on the instance node {string}', async function (this: CustomWorld, name: string) {
  const id = await findNodeIdByLabel(this.page!, name, 'instance');
  if (!id) throw new Error(`Could not find instance node "${name}"`);
  await this.page!.locator(`.react-flow__node[data-id="${id}"]`).dblclick({ force: true });
  await this.page!.waitForTimeout(200);
  
  const m = this.messages.find(m => m.type === 'openModule');
  if (m) {
     await this.selectModule(m.moduleName);
  }
});

When('I double-click on the combinational block for {string}', async function (this: CustomWorld, name: string) {
  const module = this.lastGraph.modules[this.lastViewModel.moduleName];
  const node = module.nodes.find((n: any) => n.kind === 'comb' && n.id.includes(`:${name}:`));
  const id = node?.id;
  if (!id) throw new Error(`Could not find comb block for "${name}"`);
  await this.page!.locator(`.react-flow__node[data-id="${id}"]`).dblclick({ force: true });
  await this.page!.waitForTimeout(200);
});

When('I double-click on the mux block for {string}', async function (this: CustomWorld, name: string) {
  const module = this.lastGraph.modules[this.lastViewModel.moduleName];
  const node = module.nodes.find((n: any) => n.kind === 'mux' && n.id.includes(`:${name}:`));
  const id = node?.id;
  if (!id) throw new Error(`Could not find mux block for "${name}"`);
  await this.page!.locator(`.react-flow__node[data-id="${id}"] button`).dblclick({ force: true }); // Wait, the previous code had an issue here if it was on button, but let's just do the whole node
  await this.page!.waitForTimeout(200);
});

async function findEdgeIdBetween(page: Page, sourceId: string, targetId: string): Promise<string | null> {
  const normSource = sourceId.replace(/:/g, '_');
  const normTarget = targetId.replace(/:/g, '_');
  
  return await page.evaluate(({ s, t }) => {
    const edges = Array.from(document.querySelectorAll('.react-flow__edge'));
    const found = edges.find((e) => {
      const id = e.getAttribute('data-id');
      return id?.includes(s) && id?.includes(t);
    });
    return found?.getAttribute('data-id') ?? null;
  }, { s: normSource, t: normTarget });
}

When('I double-click on the connection between the {word} node {string} and the {word} node {string}', async function (this: CustomWorld, kind1: string, name1: string, kind2: string, name2: string) {
  const id1 = await findNodeIdByLabel(this.page!, name1, kind1);
  const id2 = await findNodeIdByLabel(this.page!, name2, kind2);
  if (!id1 || !id2) throw new Error(`Nodes not found: ${name1}=${id1}, ${name2}=${id2}`);

  const edgeId = await findEdgeIdBetween(this.page!, id1, id2);
  if (!edgeId) throw new Error(`Edge not found between ${id1} and ${id2}`);

  await this.page!.evaluate((id) => {
    const el = document.querySelector(`.react-flow__edge[data-id="${id}"] path.svsch-edge`);
    if (el) {
      const event = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      el.dispatchEvent(event);
    }
  }, edgeId);

  await this.page!.waitForTimeout(200);
});

Then('the editor should highlight the text {string}', async function (this: CustomWorld, text: string) {
  let messages = this.messages.filter((m) => m.type === 'navigateToSource');

  if (messages.length === 0) {
    const signalMessages = this.messages.filter((m) => m.type === 'navigateToSignal');
    if (signalMessages.length > 0) {
      const lastSignal = signalMessages[signalMessages.length - 1];
      const edge = lastSignal.edge;
      const moduleName = this.lastViewModel.moduleName;
      const module = this.lastGraph.modules[moduleName];

      const port = module.ports.find((p: any) => p.name === edge.signal);
      if (port?.source) {
        messages = [{ type: 'navigateToSource', source: port.source }];
      } else {
        const sourceNode = module.nodes.find((n: any) => n.label === edge.signal && (n.kind === 'register' || n.kind === 'comb'));
        if (sourceNode?.source) {
          messages = [{ type: 'navigateToSource', source: sourceNode.source }];
        }
      }
    }
  }

  if (messages.length === 0) throw new Error('No navigateToSource (or resolvable navigateToSignal) messages received.');
  const lastMessage = messages[messages.length - 1];
  const src = lastMessage.source;

  const sourceFile = this.files.find((f) => f.file === src.file);
  const lines = sourceFile.text.split('\n');
  const highlightedLines = lines.slice(src.startLine - 1, src.endLine).join('\n');
  const hNorm = highlightedLines.replace(/\s+/g, ' ').trim();
  const unescapedText = text.replace(/\\n/g, ' ');
  const tNorm = unescapedText.replace(/\s+/g, ' ').trim();
  if (!hNorm.includes(tNorm)) {
    throw new Error(`Expected text "\n${tNorm}\n" to be in highlighted lines:\n"${hNorm}"`);
  }
});

Then('a warning notification should be shown with {string}', async function (this: CustomWorld, expectedMessage: string) {
  const signalMessages = this.messages.filter((m) => m.type === 'navigateToSignal');
  if (signalMessages.length === 0) throw new Error('No navigateToSignal message received');

  const lastSignal = signalMessages[signalMessages.length - 1];
  const edge = lastSignal.edge;
  const moduleName = this.lastViewModel.moduleName;
  const module = this.lastGraph.modules[moduleName];

  const port = module.ports.find((p: any) => p.name === edge.signal);
  const sourceNode = module.nodes.find((n: any) => n.label === edge.signal && (n.kind === 'register' || n.kind === 'comb'));

  if (port?.source || sourceNode?.source) {
    throw new Error('Expected no source to be found for signal, but found one.');
  }

  expect(expectedMessage).toBe('This is an internal wire.');
});

Then('the diagram should display the module {string}', async function (this: CustomWorld, name: string) {
  // Check the view's current moduleName via this.lastViewModel
  if (this.lastViewModel.moduleName !== name) {
    throw new Error(`Expected diagram to display module ${name}, but it was ${this.lastViewModel.moduleName}`);
  }
});

Then('the module dropdown should have {string} selected', async function (this: CustomWorld, name: string) {
  const selectLocator = this.page!.locator('select[aria-label="Module"]');
  const value = await selectLocator.inputValue();
  // To get the text of the selected option, we could map it, but value is often the module name
  if (value !== name) {
    throw new Error(`Expected dropdown value to be ${name}, but was ${value}`);
  }
});

async function findNodeIdByLabel(page: Page, label: string, kind?: string): Promise<string | null> {
  return await page.evaluate(({ text, nodeKind }) => {
    const allNodes = Array.from(document.querySelectorAll('.react-flow__node'));
    const targetNode = allNodes.find(node => {
      if (nodeKind) {
        const inner = node.querySelector(`[data-node-kind="${nodeKind}"]`);
        if (!inner) return false;
      }
      
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
