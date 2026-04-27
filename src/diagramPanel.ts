import * as vscode from 'vscode';
import { buildDesignGraph } from './parser/backend';
import type { DesignGraph, DiagramViewModel, PositionedNode } from './ir/types';
import { buildViewModel, mergeEdgeRoutePoints, mergeEdgeWaypoint, mergeNodePositions } from './layout/mergeLayout';
import { LayoutStore, type SavedLayout } from './storage/layoutStore';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'layoutChanged'; moduleName: string; nodes: PositionedNode[] }
  | { type: 'edgeLayoutChanged'; moduleName: string; edgeId: string; waypoint: { x: number; y: number } }
  | { type: 'edgeRouteChanged'; moduleName: string; edgeId: string; routePoints: Array<{ x: number; y: number }> }
  | { type: 'openModule'; moduleName: string }
  | { type: 'resetLayout'; moduleName: string };

export class DiagramPanel {
  private panel?: vscode.WebviewPanel;
  private watcher?: vscode.FileSystemWatcher;
  private documentChangeDisposable?: vscode.Disposable;
  private rebuildTimer?: NodeJS.Timeout;
  private rebuildVersion = 0;
  private graph?: DesignGraph;
  private layout?: SavedLayout;
  private currentModule?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onDispose: () => void
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      this.panel = vscode.window.createWebviewPanel('svsch.diagram', 'SVSCH Diagram', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
      });
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message), undefined, this.context.subscriptions);
      this.panel.onDidDispose(() => this.dispose(), undefined, this.context.subscriptions);
    }

    this.ensureWatcher();
    await this.rebuild();
  }

  async rebuild(live = false): Promise<void> {
    const version = ++this.rebuildVersion;
    const workspaceRoot = workspaceRootPath();
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('SVSCH requires an open workspace folder.');
      return;
    }
    await this.postStatus('rebuilding');

    const config = vscode.workspace.getConfiguration('svsch');
    const projectFolder = config.get<string>('projectFolder') || '.';
    const backend = config.get<'verible' | 'fallback'>('parser.backend') || 'verible';
    const veriblePath = config.get<string>('veriblePath') || 'verible-verilog-syntax';
    const store = new LayoutStore(workspaceRoot);

    this.layout = await store.read();
    this.graph = await buildDesignGraph({
      workspaceRoot,
      projectFolder,
      backend,
      veriblePath,
      overlays: live ? openHdlDocumentOverlays(workspaceRoot, projectFolder) : undefined,
      includeExternalDiagnostics: !live
    });
    if (version !== this.rebuildVersion) {
      return;
    }
    this.currentModule = this.currentModule && this.graph.modules[this.currentModule]
      ? this.currentModule
      : this.graph.rootModules[0] ?? Object.keys(this.graph.modules)[0] ?? '';

    await this.postView();
    await this.postStatus('idle');
  }

  async resetLayoutForCurrentModule(): Promise<void> {
    if (!this.currentModule) {
      return;
    }
    const workspaceRoot = workspaceRootPath();
    if (!workspaceRoot) {
      return;
    }
    const store = new LayoutStore(workspaceRoot);
    const layout = this.layout ?? await store.read();
    delete layout.modules[this.currentModule];
    await store.write(layout);
    this.layout = layout;
    await this.postView();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.documentChangeDisposable?.dispose();
    this.watcher = undefined;
    this.documentChangeDisposable = undefined;
    this.panel = undefined;
    this.onDispose();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.postView();
      return;
    }
    if (message.type === 'openModule') {
      if (this.graph?.modules[message.moduleName]) {
        this.currentModule = message.moduleName;
        await this.postView();
      }
      return;
    }
    if (message.type === 'resetLayout') {
      this.currentModule = message.moduleName;
      await this.resetLayoutForCurrentModule();
      return;
    }
    if (message.type === 'layoutChanged') {
      await this.saveLayout(message.moduleName, message.nodes);
      return;
    }
    if (message.type === 'edgeLayoutChanged') {
      await this.saveEdgeLayout(message.moduleName, message.edgeId, message.waypoint);
      return;
    }
    if (message.type === 'edgeRouteChanged') {
      await this.saveEdgeRoute(message.moduleName, message.edgeId, message.routePoints);
    }
  }

  private async saveLayout(moduleName: string, nodes: PositionedNode[]): Promise<void> {
    const workspaceRoot = workspaceRootPath();
    if (!workspaceRoot) {
      return;
    }
    const store = new LayoutStore(workspaceRoot);
    const base = this.layout ?? await store.read();
    this.layout = mergeNodePositions(base, moduleName, nodes);
    await store.write(this.layout);
  }

  private async saveEdgeLayout(moduleName: string, edgeId: string, waypoint: { x: number; y: number }): Promise<void> {
    const workspaceRoot = workspaceRootPath();
    if (!workspaceRoot) {
      return;
    }
    const store = new LayoutStore(workspaceRoot);
    const base = this.layout ?? await store.read();
    this.layout = mergeEdgeWaypoint(base, moduleName, edgeId, waypoint);
    await store.write(this.layout);
  }

  private async saveEdgeRoute(moduleName: string, edgeId: string, routePoints: Array<{ x: number; y: number }>): Promise<void> {
    const workspaceRoot = workspaceRootPath();
    if (!workspaceRoot) {
      return;
    }
    const store = new LayoutStore(workspaceRoot);
    const base = this.layout ?? await store.read();
    this.layout = mergeEdgeRoutePoints(base, moduleName, edgeId, routePoints);
    await store.write(this.layout);
  }

  private async postView(): Promise<void> {
    if (!this.panel || !this.graph || !this.layout || this.currentModule === undefined) {
      return;
    }
    const view: DiagramViewModel = await buildViewModel(this.graph, this.currentModule, this.layout);
    await this.panel.webview.postMessage({
      type: 'graph',
      view,
      modules: Object.keys(this.graph.modules).sort()
    });
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    const pattern = new vscode.RelativePattern(workspaceRootPath() ?? '.', '**/*.{sv,v,svh,vh}');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const schedule = (live = false) => {
      if (this.rebuildTimer) {
        clearTimeout(this.rebuildTimer);
      }
      this.rebuildTimer = setTimeout(() => {
        void this.rebuild(live);
      }, live ? 350 : 250);
    };
    this.watcher.onDidCreate(() => schedule(false));
    this.watcher.onDidChange(() => schedule(false));
    this.watcher.onDidDelete(() => schedule(false));
    this.documentChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
      if (isHdlUri(event.document.uri)) {
        schedule(true);
      }
    });
  }

  private async postStatus(status: 'idle' | 'rebuilding'): Promise<void> {
    await this.panel?.webview.postMessage({
      type: 'status',
      status
    });
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'));
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource} https:; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>SVSCH Diagram</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function workspaceRootPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isHdlUri(uri: vscode.Uri): boolean {
  return /\.(sv|v|svh|vh)$/i.test(uri.fsPath);
}

function openHdlDocumentOverlays(workspaceRoot: string, projectFolder: string): Array<{ file: string; text: string }> {
  const projectRoot = vscode.Uri.file(`${workspaceRoot}/${projectFolder || '.'}`).fsPath;
  return vscode.workspace.textDocuments
    .filter((document) => isHdlUri(document.uri) && document.uri.fsPath.startsWith(projectRoot))
    .map((document) => ({
      file: vscode.workspace.asRelativePath(document.uri, false),
      text: document.getText()
    }));
}
