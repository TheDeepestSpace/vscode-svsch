import { expect } from 'vscode-test-playwright';
import type { FrameLocator, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

export const SYSTEM_LAYOUTS_DIR = path.resolve(__dirname, '../.svsch/layouts');
export type EvaluateInVSCode = <R, Arg = void>(
  fn: (vscode: any, arg: Arg) => R,
  arg?: Arg,
) => Promise<R>;

export async function clearSystemLayout(): Promise<void> {
  await fs.promises.rm(SYSTEM_LAYOUTS_DIR, { recursive: true, force: true }).catch(() => {});
}

export async function openSystemDiagram(
  workbox: Page,
  evaluateInVSCode: EvaluateInVSCode,
): Promise<void> {
  await workbox.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  await dismissSystemNotifications(workbox);
  await installSystemWebviewBridge(evaluateInVSCode);
  await evaluateInVSCode((vscode) => vscode.commands.executeCommand('svsch.openDiagram'));
  await workbox.waitForSelector('.tab[aria-label*="SVSCH"], .tab[title*="SVSCH"]', {
    timeout: 30_000,
  });
  await dismissSystemNotifications(workbox);
}

export async function installSystemWebviewBridge(
  evaluateInVSCode: EvaluateInVSCode,
): Promise<void> {
  await evaluateInVSCode((vscode) => {
    if ((global as any).__svschSystemBridgeInstalled) return;
    (global as any).__svschSystemBridgeInstalled = true;

    const origCreatePanel = vscode.window.createWebviewPanel;
    (vscode.window as any).createWebviewPanel = function (
      viewType: string,
      title: string,
      ...args: any[]
    ) {
      const panel = (origCreatePanel as any).call(vscode.window, viewType, title, ...args);
      if (viewType !== 'svsch.diagram') {
        return panel;
      }

      const origPostMessage = panel.webview.postMessage.bind(panel.webview);
      panel.webview.postMessage = (msg: any) => {
        if (msg?.type === 'graph') {
          (global as any).__svschModules = msg.modules;
          (global as any).__svschCurrentModule = msg.view?.moduleName;
          (global as any).__svschGraphCount = ((global as any).__svschGraphCount ?? 0) + 1;
        }
        return origPostMessage(msg);
      };

      const origOnDidReceiveMessage = panel.webview.onDidReceiveMessage;
      const msgListeners: Array<(msg: any) => void> = [];
      (panel.webview as any).onDidReceiveMessage = function (
        listener: any,
        thisArgs?: any,
        disposables?: any,
      ) {
        msgListeners.push(thisArgs ? listener.bind(thisArgs) : listener);
        return (origOnDidReceiveMessage as any).call(
          panel.webview,
          listener,
          thisArgs,
          disposables,
        );
      };
      (global as any).__svschFireWebviewMessage = (msg: any) => {
        for (const listener of msgListeners) listener(msg);
      };

      return panel;
    };
  });
}

export async function openSystemModule(
  workbox: Page,
  webview: FrameLocator,
  evaluateInVSCode: EvaluateInVSCode,
  moduleName: string,
): Promise<void> {
  const switchedViaHost = await evaluateInVSCode((vscode, requestedModule) => {
    void vscode;
    const modules: string[] = (global as any).__svschModules ?? [];
    if (!modules.includes(requestedModule)) {
      return false;
    }
    if ((global as any).__svschCurrentModule === requestedModule) {
      return true;
    }
    if (!(global as any).__svschFireWebviewMessage) {
      return false;
    }
    (global as any).__svschGraphCountBeforeSwitch = (global as any).__svschGraphCount ?? 0;
    (global as any).__svschFireWebviewMessage({ type: 'openModule', moduleName: requestedModule });
    return true;
  }, moduleName);

  if (switchedViaHost) {
    await expect
      .poll(
        async () =>
          evaluateInVSCode((vscode) => {
            void vscode;
            return (global as any).__svschCurrentModule;
          }),
        { timeout: 15_000 },
      )
      .toBe(moduleName);
  } else {
    const moduleSelect = webview.locator('select[aria-label="Module"]');
    await moduleSelect.selectOption(moduleName);
    await expect(moduleSelect).toHaveValue(moduleName);
  }

  await webview
    .locator('.react-flow__node')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  await waitForSystemModuleRendered(webview, moduleName);
  await waitForViewportToSettle(webview);
  await workbox.waitForTimeout(300);
}

export async function dismissSystemNotifications(workbox: Page): Promise<void> {
  for (const button of await workbox
    .locator('.notification-toast button', { hasText: /Never|Don't show/i })
    .all()) {
    await button.click().catch(() => {});
  }
  const closeAll = workbox.locator('.notifications-toasts .codicon-notifications-clear-all');
  if (await closeAll.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeAll.click().catch(() => {});
  }
}

export async function waitForViewportToSettle(webview: FrameLocator): Promise<void> {
  // fitView() is scheduled via setTimeout(0) after the graph/nodes settle
  // (see main.tsx), so a fixed delay after the first node appears can race
  // it — poll until the transform stops changing instead of guessing a delay.
  await webview.locator('body').evaluate(async () => {
    const getTransform = () =>
      (document.querySelector('.react-flow__viewport') as HTMLElement)?.style.transform ?? '';
    let last = getTransform();
    let stable = 0;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const current = getTransform();
      stable = current === last && current !== '' ? stable + 1 : 0;
      last = current;
      if (stable >= 5) break;
    }
    if (stable < 5) {
      throw new Error('React Flow viewport did not settle within 5 seconds');
    }
  });
  await webview.locator('body').evaluate(() => document.fonts.ready);
}

export async function waitForSystemModuleRendered(
  webview: FrameLocator,
  moduleName: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () =>
          webview.locator('html').evaluate((_element, expectedModule) => {
            const rf = (window as any).reactFlowInstance;
            const nodes = rf?.getNodes?.() ?? [];
            return (
              nodes.length > 0 &&
              nodes.every((node: any) => node.data?.moduleName === expectedModule)
            );
          }, moduleName),
        { timeout: 30_000 },
      )
      .toBe(true);
  } catch (error) {
    const state = await webview.locator('html').evaluate(() => {
      const rf = (window as any).reactFlowInstance;
      const nodes = rf?.getNodes?.() ?? [];
      const edges = rf?.getEdges?.() ?? [];
      const select = document.querySelector(
        'select[aria-label="Module"]',
      ) as HTMLSelectElement | null;
      return {
        selectedModule: select?.value ?? null,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes: nodes.slice(0, 8).map((node: any) => ({
          id: node.id,
          moduleName: node.data?.moduleName,
          label: node.data?.node?.label,
          kind: node.data?.node?.kind,
        })),
      };
    });
    throw new Error(
      `Timed out waiting for rendered module ${moduleName}: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
}
