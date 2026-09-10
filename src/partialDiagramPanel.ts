import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesignModule, PositionedNode } from './ir/types';
import type { SavedLayout } from './storage/layoutStore';
import { logger } from './logger';
import {
  mergeEdgeRoutePoints,
  mergeNodePositions,
  mergeRelayoutSelection,
  mergeRerouteEdges,
  mergeRerouteLayout,
  mergeRerouteSingleEdge,
  resetCutLabelPosition,
} from './layout/mergeLayout';
import {
  buildPartialViewModel,
  removeNodesFromState,
  resolveExtendTarget,
  type PartialDiagramState,
} from './layout/partialDiagram';
import { renderSvg } from './cli/svgRenderer';
import { minifySvg } from './cli/svgMinify';
import { diagramWebviewHtml } from './webviewPanelHtml';

/**
 * Messages the partial pane's webview posts that this panel acts on. The
 * webview is the same bundle the main diagram panel serves, so it can post
 * the full main-panel vocabulary — anything not listed here (persistence,
 * net cuts, expand, navigation) is deliberately ignored: the partial is
 * ephemeral and derived, with no store behind it. SVG export is served
 * (issue #408): it just re-renders whatever `buildPartialViewModel` already
 * produces, so it needs no store either.
 */
type PartialWebviewMessage =
  | { type: 'ready' }
  | { type: 'requestExtendNet'; moduleName: string; netKey: string; originalEdgeId?: string }
  | { type: 'removeFromPartial'; moduleName: string; nodeIds: string[] }
  | { type: 'layoutChanged'; moduleName: string; nodes: PositionedNode[] }
  | { type: 'rerouteLayout'; moduleName: string; nodes: PositionedNode[] }
  | { type: 'rerouteEdge'; moduleName: string; edgeId: string; nodes: PositionedNode[] }
  | { type: 'rerouteEdges'; moduleName: string; edgeIds: string[]; nodes: PositionedNode[] }
  | { type: 'resetCutLabelPosition'; moduleName: string; nodeId: string }
  | { type: 'relayoutSelection'; moduleName: string; nodeIds: string[]; nodes: PositionedNode[] }
  | { type: 'resetLayout'; moduleName: string }
  | {
      type: 'edgeRoutesChanged';
      moduleName: string;
      changes: Array<{ edgeId: string; routePoints: Array<{ x: number; y: number }> }>;
      nodes?: PositionedNode[];
    }
  | { type: 'exportSvg' }
  | { type: string };

/**
 * The "SVSCH Partial Diagram" pane (issue #403): an ephemeral second webview
 * panel holding a user-assembled subset of one module. All state — the
 * source module snapshot, which nodes are included, which nets are tied, and
 * the pane's private in-memory layout — lives here in the extension host and
 * is discarded whole when the pane closes. Nothing is ever persisted.
 *
 * One instance at most exists at a time (see extension.ts): while the pane is
 * open, every "Add to Partial" click lands in it; once it's closed, the next
 * click builds a fresh one.
 */
export class PartialDiagramPanel {
  private panel?: vscode.WebviewPanel;
  private sourceModule?: DesignModule;
  private state?: PartialDiagramState;
  private layout: SavedLayout = { version: 1, modules: {} };
  private postViewQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onDispose: () => void,
  ) {}

  /**
   * Adds one or more nodes from the main diagram into the pane (e.g. a
   * multi-block selection sent in a single "Add to Partial" click), creating
   * the pane if it isn't open. v1 scope: the pane views exactly one source
   * module — adding a node from a *different* module restarts the pane's
   * content around it. All of them land in a single re-render rather than
   * one per node.
   */
  async addNodes(sourceModule: DesignModule, nodeIds: string[]): Promise<void> {
    const validNodeIds = nodeIds.filter((nodeId) =>
      sourceModule.nodes.some((node) => node.id === nodeId),
    );
    if (validNodeIds.length === 0) {
      return;
    }
    this.ensurePanel();
    if (!this.state || this.state.sourceModuleName !== sourceModule.name) {
      this.state = { sourceModuleName: sourceModule.name, includedNodeIds: [], tiedNetKeys: [] };
      this.layout = { version: 1, modules: {} };
    }
    // Keep the source snapshot current: connectivity lookups (extend) should
    // see the module as the main diagram last showed it.
    this.sourceModule = sourceModule;
    this.panel?.reveal(vscode.ViewColumn.Beside, true);
    let added = false;
    for (const nodeId of validNodeIds) {
      if (!this.state.includedNodeIds.includes(nodeId)) {
        this.state.includedNodeIds.push(nodeId);
        added = true;
      }
    }
    if (added) {
      await this.postView();
    }
  }

  dispose(): void {
    this.panel = undefined;
    this.sourceModule = undefined;
    this.state = undefined;
    this.layout = { version: 1, modules: {} };
    this.onDispose();
  }

  /**
   * Closes the pane programmatically (e.g. the main panel navigated away
   * from the module the pane is scoped to — v1 only supports one partial
   * pane per module, see issue #408). Disposing the real webview panel
   * cascades into `dispose()` via `onDidDispose`, same as the user closing
   * the tab by hand.
   */
  close(): void {
    this.panel?.dispose();
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'svsch.partialDiagram',
      'SVSCH Partial Diagram',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      },
    );
    this.panel.webview.html = diagramWebviewHtml(
      this.context,
      this.panel.webview,
      'SVSCH Partial Diagram',
    );
    this.panel.webview.onDidReceiveMessage(
      (message: PartialWebviewMessage) => this.handleMessage(message),
      undefined,
      this.context.subscriptions,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.context.subscriptions);
  }

  private async handleMessage(message: PartialWebviewMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.postView();
      return;
    }
    if (!this.sourceModule || !this.state) {
      return;
    }
    const moduleName = this.sourceModule.name;
    if (message.type === 'requestExtendNet') {
      const extend = message as Extract<PartialWebviewMessage, { type: 'requestExtendNet' }>;
      await this.extendNet(extend.netKey, extend.originalEdgeId);
      return;
    }
    if (message.type === 'removeFromPartial') {
      const remove = message as Extract<PartialWebviewMessage, { type: 'removeFromPartial' }>;
      await this.removeNodes(remove.nodeIds);
      return;
    }
    if (message.type === 'layoutChanged') {
      const changed = message as Extract<PartialWebviewMessage, { type: 'layoutChanged' }>;
      // The webview already moved the nodes — record the new anchors so the
      // next rebuild keeps them locked, but don't re-render.
      this.layout = mergeNodePositions(this.layout, moduleName, changed.nodes);
      return;
    }
    if (message.type === 'rerouteLayout') {
      const reroute = message as Extract<PartialWebviewMessage, { type: 'rerouteLayout' }>;
      this.layout = mergeRerouteLayout(this.layout, moduleName, reroute.nodes);
      await this.postView();
      return;
    }
    if (message.type === 'rerouteEdge') {
      const reroute = message as Extract<PartialWebviewMessage, { type: 'rerouteEdge' }>;
      this.layout = mergeRerouteSingleEdge(this.layout, moduleName, reroute.edgeId, reroute.nodes);
      await this.postView();
      return;
    }
    if (message.type === 'rerouteEdges') {
      const reroute = message as Extract<PartialWebviewMessage, { type: 'rerouteEdges' }>;
      this.layout = mergeRerouteEdges(this.layout, moduleName, reroute.edgeIds, reroute.nodes);
      await this.postView();
      return;
    }
    if (message.type === 'resetCutLabelPosition') {
      const reset = message as Extract<PartialWebviewMessage, { type: 'resetCutLabelPosition' }>;
      this.layout = resetCutLabelPosition(this.layout, moduleName, reset.nodeId);
      await this.postView();
      return;
    }
    if (message.type === 'relayoutSelection') {
      const relayout = message as Extract<PartialWebviewMessage, { type: 'relayoutSelection' }>;
      // The source module is a superset of the partial's derived module —
      // good enough for clearing the routes of every edge touching a
      // released node, which is all mergeRelayoutSelection reads it for.
      this.layout = mergeRelayoutSelection(
        this.layout,
        moduleName,
        relayout.nodeIds,
        relayout.nodes,
        this.sourceModule,
      );
      await this.postView();
      return;
    }
    if (message.type === 'resetLayout') {
      this.layout = { version: 1, modules: {} };
      await this.postView();
      return;
    }
    if (message.type === 'edgeRoutesChanged') {
      const routes = message as Extract<PartialWebviewMessage, { type: 'edgeRoutesChanged' }>;
      let layout = routes.nodes
        ? mergeNodePositions(this.layout, moduleName, routes.nodes)
        : this.layout;
      for (const change of routes.changes) {
        layout = mergeEdgeRoutePoints(layout, moduleName, change.edgeId, change.routePoints);
      }
      this.layout = layout;
      await this.postView();
      return;
    }
    if (message.type === 'exportSvg') {
      await this.exportSvg();
      return;
    }
    // Everything else the shared webview bundle can post has no meaning for
    // an ephemeral pane — ignore it.
  }

  /**
   * Export SVG for the partial pane (issue #408): re-renders whatever
   * `buildPartialViewModel` currently shows via the same `renderSvg`/
   * `minifySvg` pipeline the main diagram uses. Unlike the main panel's
   * export, there's no expand splicing or LayoutStore to warm first — the
   * partial never supports expand and its layout already lives in memory.
   */
  private async exportSvg(): Promise<void> {
    try {
      if (!this.sourceModule || !this.state) {
        return;
      }
      let reactFlowCss = '';
      try {
        const paths = [
          path.join(
            this.context.extensionUri.fsPath,
            'node_modules',
            '@xyflow',
            'react',
            'dist',
            'style.css',
          ),
          path.join(
            this.context.extensionUri.fsPath,
            '..',
            'node_modules',
            '@xyflow',
            'react',
            'dist',
            'style.css',
          ),
          path.join(
            this.context.extensionUri.fsPath,
            '..',
            '..',
            'node_modules',
            '@xyflow',
            'react',
            'dist',
            'style.css',
          ),
        ];
        for (const p of paths) {
          if (fs.existsSync(p)) {
            reactFlowCss = fs.readFileSync(p, 'utf8');
            break;
          }
        }
      } catch (err) {
        logger.log(`Warning: Could not load React Flow CSS for export: ${err}`);
      }

      let extensionCss = '';
      try {
        const p = path.join(this.context.extensionUri.fsPath, 'media', 'diagram.css');
        if (fs.existsSync(p)) {
          extensionCss = fs.readFileSync(p, 'utf8');
        } else {
          logger.log(
            `Warning: ${p} not found; the exported SVG will have no diagram styling. ` +
              `Run "npm run build:webview".`,
          );
        }
      } catch (err) {
        logger.log(`Warning: Could not load extension CSS for export: ${err}`);
      }

      const viewModel = await buildPartialViewModel(this.sourceModule, this.state, this.layout);
      let svg = renderSvg(viewModel, {
        theme:
          vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark',
        reactFlowCss,
        extensionCss,
      });
      if (vscode.workspace.getConfiguration('svsch').get<boolean>('minifySvg', true)) {
        svg = await minifySvg(svg);
      }

      const defaultUri = vscode.Uri.file(
        path.join(
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.',
          `${this.sourceModule.name.replace(/[^a-z0-9]/gi, '_')}_partial.svg`,
        ),
      );

      // In tests, we bypass the dialog to avoid hanging
      if (process.env.SVSCH_TEST) {
        fs.writeFileSync(defaultUri.fsPath, svg);
        return;
      }

      const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { SVG: ['svg'] },
        title: 'Export Diagram as SVG',
      });

      if (uri) {
        fs.writeFileSync(uri.fsPath, svg);
        vscode.window.showInformationMessage(`Diagram exported to ${path.basename(uri.fsPath)}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.log(`Error exporting SVG: ${msg}`);
      vscode.window.showErrorMessage(`Failed to export SVG: ${msg}`);
    }
  }

  private async extendNet(netKey: string, originalEdgeId?: string): Promise<void> {
    if (!this.sourceModule || !this.state) {
      return;
    }
    const target = resolveExtendTarget(this.sourceModule, this.state, netKey, originalEdgeId);
    if (!target) {
      return;
    }
    this.state.includedNodeIds.push(...target.newNodeIds);
    if (!this.state.tiedNetKeys.includes(netKey)) {
      this.state.tiedNetKeys.push(netKey);
    }
    await this.postView();
  }

  /**
   * "Remove" (issue #408): drops the given blocks from the pane, whether
   * triggered by the selection toolbar's button or its Backspace/Delete
   * hotkey. Removing the pane's last block closes it outright — same
   * end state as closing the tab by hand — rather than leaving an empty,
   * unusable pane open.
   */
  private async removeNodes(nodeIds: string[]): Promise<void> {
    if (!this.state) {
      return;
    }
    this.state = removeNodesFromState(this.state, nodeIds);
    if (this.state.includedNodeIds.length === 0) {
      this.close();
      return;
    }
    await this.postView();
  }

  private postView(): Promise<void> {
    const pending = this.postViewQueue.then(() => this.postViewNow());
    this.postViewQueue = pending.catch(() => {});
    return pending;
  }

  private async postViewNow(): Promise<void> {
    if (!this.panel || !this.sourceModule || !this.state) {
      return;
    }
    const view = await buildPartialViewModel(this.sourceModule, this.state, this.layout);
    // Locked-node layout (issue #405): anchor every real block at the
    // position this render gave it, so the next extend's ELK pass (interactive
    // + FIXED positions, see elkNodeForLayout) only ever places the newly
    // pulled-in node. Net-cut labels stay dynamic — they re-derive from their
    // owning port's lead point, which the anchors keep stable anyway.
    this.layout = mergeNodePositions(
      this.layout,
      this.sourceModule.name,
      view.nodes.map((node) => ({
        ...node,
        fixed: node.kind === 'netLabel' ? node.fixed : true,
      })),
    );
    await this.panel.webview.postMessage({
      type: 'graph',
      view,
      modules: [this.sourceModule.name],
      expandedInstanceIds: [],
      partial: true,
    });
  }
}
