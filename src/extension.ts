import * as vscode from 'vscode';
import * as path from 'node:path';
import { DiagramPanel } from './diagramPanel';
import { ElaborationService } from './elaborationService';
import { createVscodeElaborationHost } from './vscodeElaborationHost';
import { logger } from './logger';
import type { SourceRange } from './ir/types';

let panel: DiagramPanel | undefined;

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

  const getPanel = () => {
    if (!panel) {
      panel = new DiagramPanel(context, getElaborationService(), () => {
        panel = undefined;
      });
    }
    return panel;
  };

  let selectionDebounce: ReturnType<typeof setTimeout> | undefined;
  const selectionDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (selectionDebounce) clearTimeout(selectionDebounce);
    selectionDebounce = setTimeout(() => {
      selectionDebounce = undefined;
      if (!panel) return;
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const documentUri = event.textEditor.document.uri;
      let selections: SourceRange[] = [];
      if (workspaceRoot && documentUri.scheme === 'file') {
        const file = path.relative(workspaceRoot, documentUri.fsPath);
        selections = event.selections.map((selection) => ({
          file,
          startLine: selection.start.line + 1,
          startColumn: selection.start.character,
          endLine: selection.end.line + 1,
          endColumn: selection.end.character,
        }));
      }
      void panel.highlightSourceRanges(selections);
    }, 75);
  });
  context.subscriptions.push(selectionDisposable, {
    dispose: () => {
      if (selectionDebounce) clearTimeout(selectionDebounce);
    },
  });

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
}
