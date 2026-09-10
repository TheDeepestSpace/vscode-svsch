import { Given, When, Then, BddWorld } from './fixtures';
import { expect } from '@playwright/test';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Natural-flow steps: VS Code folder configuration, and
// command palette interactions.  These steps let the extension build and
// display the diagram through its normal pipeline rather than via injection.
// ---------------------------------------------------------------------------

When('I open the workspace folder in VS Code', async function (this: BddWorld) {
  await this.evaluateInVSCode((_vscode) => {
    return (_vscode as any).workspace
      .getConfiguration('svsch')
      .update('projectFolder', '.', (_vscode as any).ConfigurationTarget.Workspace);
  });
});

When('I open the command palette with Ctrl+Shift+P', async function (this: BddWorld) {
  await this.workbox.keyboard.press('Control+Shift+P');
  await this.workbox.waitForSelector('.quick-input-widget', { timeout: 5_000 });
});

When('I type {string}', async function (this: BddWorld, text: string) {
  await this.workbox.keyboard.type(text);
});

When('I press Enter', async function (this: BddWorld) {
  await this.workbox.keyboard.press('Enter');
});

Then('the SVSCH diagram panel opens', async function (this: BddWorld) {
  await this.workbox.waitForSelector(
    '.tab[aria-label*="SVSCH Diagram"], .tab[title*="SVSCH Diagram"]',
    {
      timeout: 30_000,
    },
  );
  // Wait for the extension's graph build + webview render (Surelog may be slow on first run)
  await this.webviewPage.locator('.react-flow__node').first().waitFor({ timeout: 90_000 });
  await this.takeScreenshot('SVSCH diagram panel open');
});

Then(
  'the {string} module is selected in the module dropdown',
  async function (this: BddWorld, moduleName: string) {
    await expect(this.webviewPage.locator('select[aria-label="Module"]')).toHaveValue(moduleName, {
      timeout: 10_000,
    });
    await this.takeScreenshot(`Module ${moduleName} selected in dropdown`);
  },
);

// ---------------------------------------------------------------------------
// Composite step: write files + open diagram via command palette in one shot.
// ---------------------------------------------------------------------------

Given('svsch.fileList is set to {string}', async function (this: BddWorld, relativePath: string) {
  await this.evaluateInVSCode((_vscode, arg) => {
    return (_vscode as any).workspace
      .getConfiguration('svsch')
      .update('fileList', arg, (_vscode as any).ConfigurationTarget.Workspace);
  }, relativePath);
});

Given(
  'svsch.projectFolder is set to {string}',
  async function (this: BddWorld, relativePath: string) {
    await this.evaluateInVSCode((_vscode, arg) => {
      return (_vscode as any).workspace
        .getConfiguration('svsch')
        .update('projectFolder', arg, (_vscode as any).ConfigurationTarget.Workspace);
    }, relativePath);
  },
);

Given(
  'I disable clock and reset cuts using this setting:',
  async function (this: BddWorld, docString: string) {
    const [key, value] = Object.entries(JSON.parse(`{${docString.trim()}}`))[0];
    const configKey = key.startsWith('svsch.') ? key.slice('svsch.'.length) : key;
    await this.evaluateInVSCode(
      (_vscode, arg) => {
        return (_vscode as any).workspace
          .getConfiguration('svsch')
          .update(arg.key, arg.value, (_vscode as any).ConfigurationTarget.Workspace);
      },
      { key: configKey, value },
    );
  },
);

When('I open the {string} module in SVSCH', async function (this: BddWorld, moduleName: string) {
  if (this._bddWorkspaceFiles.length === 0) {
    throw new Error('No BDD workspace files were prepared before opening the SVSCH diagram.');
  }

  const folder = commonProjectFolder(this._bddWorkspaceFiles);

  await this.evaluateInVSCode((_vscode, f) => {
    return (_vscode as any).workspace
      .getConfiguration('svsch')
      .update('projectFolder', f, (_vscode as any).ConfigurationTarget.Workspace);
  }, folder);

  await this.workbox.keyboard.press('Control+Shift+P');
  await this.workbox.waitForSelector('.quick-input-widget', { timeout: 5_000 });
  await this.workbox.keyboard.type('SVSCH: Open Diagram');
  await this.workbox.keyboard.press('Enter');

  await this.workbox.waitForSelector(
    '.tab[aria-label*="SVSCH Diagram"], .tab[title*="SVSCH Diagram"]',
    {
      timeout: 30_000,
    },
  );

  await this.webviewPage
    .locator('div.busy-indicator[role="status"]')
    .waitFor({ state: 'hidden', timeout: 90_000 })
    .catch(() => {});

  await this.selectModule(moduleName, false);
  // Remember the original position of every port so movement scenarios can later
  // assert against it without an explicit "I note the position" step.
  await this.recordPortPositions();
  await this.takeScreenshot(`Viewing module ${moduleName}`);
});

function commonProjectFolder(files: string[]): string {
  const relativeDirs = files.map((file) => {
    const relDir = path.relative(BddWorld.BDD_WORKSPACE, path.dirname(file));
    return relDir && relDir !== '' ? relDir : '.';
  });
  if (relativeDirs.length === 0) {
    return '.';
  }

  let commonParts = relativeDirs[0] === '.' ? [] : relativeDirs[0].split(path.sep).filter(Boolean);
  for (const relDir of relativeDirs.slice(1)) {
    const parts = relDir === '.' ? [] : relDir.split(path.sep).filter(Boolean);
    let index = 0;
    while (
      index < commonParts.length &&
      index < parts.length &&
      commonParts[index] === parts[index]
    ) {
      index += 1;
    }
    commonParts = commonParts.slice(0, index);
  }
  return commonParts.length > 0 ? commonParts.join(path.sep) : '.';
}
