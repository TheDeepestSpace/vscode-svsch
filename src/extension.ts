import * as vscode from 'vscode';
import { DiagramPanel } from './diagramPanel';
import { PartialDiagramPanel } from './partialDiagramPanel';
import { ElaborationService } from './elaborationService';
import { createVscodeElaborationHost } from './vscodeElaborationHost';
import { logger } from './logger';

let panel: DiagramPanel | undefined;
let partialPanel: PartialDiagramPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  logger.init();
  logger.log('SVSCH extension activated');
  let elaborationService: ElaborationService | undefined;

  const getElaborationService = () => {
    if (!elaborationService) {
      elaborationService = new ElaborationService(createVscodeElaborationHost(context));
      context.subscriptions.push(elaborationService);
    }
    return elaborationService;
  };

  // At most one partial pane exists at a time: while it's open, every "Add
  // to Partial" click reuses it; closing it discards all of its (purely
  // in-memory) state, and the next click starts a fresh one.
  const getPartialPanel = () => {
    if (!partialPanel) {
      partialPanel = new PartialDiagramPanel(context, () => {
        partialPanel = undefined;
      });
    }
    return partialPanel;
  };

  const getPanel = () => {
    if (!panel) {
      panel = new DiagramPanel(context, getElaborationService(), () => {
        panel = undefined;
      });
      panel.onAddToPartial = async (module, nodeIds) => {
        await getPartialPanel().addNodes(module, nodeIds);
      };
      // v1 scopes the partial pane to one module (issue #403); once the main
      // panel leaves that module, the pane no longer applies. Check the
      // existing `partialPanel` variable rather than `getPartialPanel()`, so
      // navigating away doesn't spuriously create a pane that was never open.
      panel.onLeaveModule = () => {
        partialPanel?.close();
      };
    }
    return panel;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('svsch.openDiagram', async () => {
      await getPanel().open();
    }),
    vscode.commands.registerCommand('svsch.setProjectFolder', async () => {
      const folder = await vscode.window.showInputBox({
        title: 'SVSCH: Set Project Folder',
        prompt: 'Workspace-relative folder containing SystemVerilog/Verilog files',
        value: vscode.workspace.getConfiguration('svsch').get<string>('projectFolder') || 'src',
      });
      if (folder === undefined) {
        return;
      }
      await vscode.workspace
        .getConfiguration('svsch')
        .update('projectFolder', folder, vscode.ConfigurationTarget.Workspace);
      await getPanel().rebuild();
    }),
    vscode.commands.registerCommand('svsch.rebuildDiagram', async () => {
      await getPanel().rebuild();
    }),
    vscode.commands.registerCommand('svsch.resetLayout', async () => {
      await getPanel().resetLayoutForCurrentModule();
    }),
  );
}

export function deactivate(): void {
  panel?.dispose();
  partialPanel?.dispose();
}
