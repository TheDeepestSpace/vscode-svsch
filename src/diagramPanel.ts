import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveSignalSource } from './core';
import { logger } from './logger';
import type {
  DesignGraph,
  DesignModule,
  DiagramViewModel,
  PositionedGenerateRegion,
  PositionedNode,
  SourceRange,
  DiagramEdge,
} from './ir/types';
import {
  buildViewModel,
  firstOpenAutoCutEdges,
  markFirstOpenHandled,
  mergeEdgeRoutePoints,
  mergeEdgeSnapshot,
  mergeEdgeWaypoint,
  mergeFirstOpenNetCuts,
  mergeNetCut,
  mergeNetCuts,
  mergeNodePositions,
  mergeNodeSnapshot,
  mergeRegionBounds,
  mergeRelayoutSelection,
  mergeRerouteEdges,
  mergeRerouteLayout,
  mergeRerouteSingleEdge,
  removeNetCut,
  renameCutNet,
  resetCutLabelPosition,
  revertCutNetLabel,
  revertNodeSizes,
} from './layout/mergeLayout';
import { LayoutStore, type SavedLayout } from './storage/layoutStore';
import { renderSvg } from './cli/svgRenderer';
import { minifySvg } from './cli/svgMinify';
import { generateArmSpan } from './diagram/generateArmSpan';
import { ElaborationService, isListOnlyPlaceholder, type Disposable } from './elaborationService';
import { nodeIsArrayNode } from './ir/nodeMetadata';
import { buildExpandSpliceLayout } from './layout/expandLayout';
import { applyExpandedInstances } from './layout/expandSpliceView';
import type { ExpandSpliceLayout } from './webview/expand/splice';
import { instanceParameterRows, resolvedNodeDimensions } from './diagram/nodeSizing';
import { diagramWebviewHtml } from './webviewPanelHtml';

/** Sent to the webview in response to `requestExpandInstance`, and (ids only,
 * see `expandedInstanceIds` on the `graph` message) proactively fetched by the
 * webview for any instance the module layout already had flagged expanded —
 * see the `expanded` field on SavedModuleLayout for why the flag and the
 * actual child IR are split like this. */
export interface ExpandInstancePayload {
  instanceId: string;
  childModuleName: string;
  module: DesignModule;
  /**
   * The child's standalone place-and-route result dropped into the frame
   * (see buildExpandSpliceLayout) — absent when that pipeline failed, in
   * which case the webview falls back to its own ELK-only placement.
   */
  spliceLayout?: ExpandSpliceLayout;
}

type WebviewMessage =
  | { type: 'ready' }
  | {
      type: 'layoutChanged';
      moduleName: string;
      nodes: PositionedNode[];
      regions?: PositionedGenerateRegion[];
    }
  | { type: 'regionLayoutChanged'; moduleName: string; regions: PositionedGenerateRegion[] }
  | {
      type: 'edgeLayoutChanged';
      moduleName: string;
      edgeId: string;
      waypoint: { x: number; y: number };
    }
  | {
      type: 'edgeRouteChanged';
      moduleName: string;
      edgeId: string;
      routePoints: Array<{ x: number; y: number }>;
    }
  | {
      type: 'edgeRoutesChanged';
      moduleName: string;
      changes: Array<{ edgeId: string; routePoints: Array<{ x: number; y: number }> }>;
      nodes?: PositionedNode[];
    }
  | { type: 'openModule'; moduleName: string }
  | { type: 'resetLayout'; moduleName: string }
  | { type: 'rerouteLayout'; moduleName: string; nodes: PositionedNode[] }
  | { type: 'rerouteEdge'; moduleName: string; edgeId: string; nodes: PositionedNode[] }
  | { type: 'rerouteEdges'; moduleName: string; edgeIds: string[]; nodes: PositionedNode[] }
  | { type: 'cutNet'; moduleName: string; edge: DiagramEdge; nodes: PositionedNode[] }
  | { type: 'cutNets'; moduleName: string; edges: DiagramEdge[]; nodes: PositionedNode[] }
  | {
      type: 'relayoutSelection';
      moduleName: string;
      nodeIds: string[];
      nodes: PositionedNode[];
      /**
       * Frame sizes of currently-expanded instances ("Expand instance in
       * place", issue #232), in sizeOverride grid units. Transient,
       * layout-only: ELK must place blocks against the expanded frame's
       * footprint, but the expansion must never persist into the module's
       * saved layout as a manual resize (see stripExpandSplices in
       * webview/main.tsx). Optional so a stale webview keeps working.
       */
      expandedSizes?: Record<string, { width: number; height: number }>;
    }
  | {
      type: 'expandedFrameSizesChanged';
      moduleName: string;
      /**
       * Frame sizes of every currently-expanded top-level instance in this
       * module ("Expand instance in place", issue #232), in sizeOverride
       * grid units — same shape and purpose as relayoutSelection's
       * `expandedSizes`, but kept live on the panel so *every* view
       * rebuild (not just an explicit Auto Layout) routes other wires
       * around the expanded frame's real footprint instead of the
       * collapsed instance's saved size. Sent whenever the webview's
       * splice set changes (expand, collapse, or module navigation).
       */
      sizes: Record<string, { width: number; height: number }>;
    }
  | { type: 'renameCutNet'; moduleName: string; netKey: string; label: string }
  | { type: 'revertCutNetLabel'; moduleName: string; netKey: string }
  | { type: 'tieNet'; moduleName: string; netKey: string }
  | { type: 'resetCutLabelPosition'; moduleName: string; nodeId: string }
  | { type: 'revertNodeSizes'; moduleName: string; nodeIds: string[] }
  | {
      type: 'requestExpandInstance';
      moduleName: string;
      instanceId: string;
      topLevel: boolean;
      /**
       * The instance node's live rendered geometry — authoritative over the
       * host's own derivation (it reflects unsaved local resizes, and for a
       * nested expand the instance node only exists in the webview's splice
       * state at all). Optional so a stale webview keeps working.
       */
      instanceSize?: { width: number; height: number };
      instanceParamRows?: number;
    }
  | { type: 'collapseInstance'; moduleName: string; instanceId: string; topLevel: boolean }
  | { type: 'navigateToSource'; source: SourceRange }
  | {
      type: 'navigateToRegion';
      region: {
        kind: string;
        isGenerateBlock?: boolean;
        source?: SourceRange;
        bodySource?: SourceRange;
      };
    }
  | { type: 'navigateToSignal'; edge: DiagramEdge }
  | { type: 'addToPartial'; moduleName: string; nodeIds: string[] }
  | { type: 'exportSvg' };

export class DiagramPanel {
  /**
   * Delegate for the selection toolbar's "Add to Partial" action (issue
   * #403) — set by extension.ts, which owns the partial pane's lifecycle so
   * one open pane is reused across clicks. Receives the fully loaded source
   * module and the selected nodes' ids (one or more, for a multi-selection).
   */
  onAddToPartial?: (module: DesignModule, nodeIds: string[]) => Promise<void> | void;

  /**
   * Delegate fired when the main panel stops showing `moduleName` — either
   * navigating to another module or closing the panel entirely. Set by
   * extension.ts to close the partial pane (issue #408): v1 scopes one
   * partial pane to one module, so it can't survive its source module going
   * out of view.
   */
  onLeaveModule?: (moduleName: string) => void;

  private panel?: vscode.WebviewPanel;
  private readonly elaborationInvalidationDisposable: Disposable;
  private rebuildVersion = 0;
  private graph?: DesignGraph;
  private layout: SavedLayout = { version: 1, modules: {} };
  private currentModule?: string;
  private store?: LayoutStore;
  private postViewQueue: Promise<void> = Promise.resolve();
  // Per-module, transient (never persisted) expanded-instance frame sizes —
  // see the `expandedFrameSizesChanged` message. Kept live so every
  // buildViewModel call for a module with an active "Expand instance in
  // place" routes the rest of the diagram around the expanded frame's real
  // on-screen footprint, not the collapsed instance's saved size.
  private expandedFrameSizesByModule = new Map<
    string,
    Record<string, { width: number; height: number }>
  >();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly elaborationService: ElaborationService,
    private readonly onDispose: () => void,
  ) {
    this.elaborationInvalidationDisposable = elaborationService.onDidInvalidate((live) => {
      if (this.panel && workspaceRootPath()) {
        void this.consumeGraph(elaborationService.getGraph(live));
      }
    });
  }

  private getStore(): LayoutStore | undefined {
    if (this.store) {
      return this.store;
    }
    const root = workspaceRootPath();
    if (!root) {
      return undefined;
    }
    this.store = new LayoutStore(root);
    return this.store;
  }

  /** Loads a module's layout into the in-memory cache if it isn't already there. */
  private async ensureModuleLayout(store: LayoutStore, moduleName: string): Promise<void> {
    if (this.layout.modules[moduleName]) {
      return;
    }
    const moduleLayout = await store.readModuleLayout(moduleName);
    this.layout = {
      version: 1,
      modules: { ...this.layout.modules, [moduleName]: moduleLayout },
    };
  }

  /** Persists only the given module's layout — every other module's file is untouched. */
  private async persistModuleLayout(store: LayoutStore, moduleName: string): Promise<void> {
    const moduleLayout = this.layout.modules[moduleName] ?? { nodes: {} };
    await store.writeModuleLayout(moduleName, moduleLayout);
  }

  /**
   * Loads into memory the saved layout (and full elaboration) of a module
   * plus, transitively, every module its diagram's own expanded instances
   * point at. A spliced sub-diagram is a read-only mirror of the child
   * module's own diagram — expansions included, recursively (see
   * buildExpandSpliceLayout) — so the splice layout must see each of those
   * modules' `SavedModuleLayout` even if the user never opened them this
   * session.
   */
  private async ensureExpandedModuleClosure(store: LayoutStore, rootModule: string): Promise<void> {
    const visited = new Set<string>();
    const queue = [rootModule];
    while (queue.length > 0) {
      const moduleName = queue.shift()!;
      if (visited.has(moduleName)) {
        continue;
      }
      visited.add(moduleName);
      let module = this.graph?.modules[moduleName];
      if (module && isListOnlyPlaceholder(module)) {
        await this.loadModule(moduleName);
        module = this.graph?.modules[moduleName];
      }
      if (!module) {
        continue;
      }
      // Only pull in layouts that actually exist on disk: caching a default
      // empty layout for a never-persisted module would defeat postViewNow's
      // first-open detection (and its auto-cut pass) when the user later
      // opens that module directly — and a module with no layout file can't
      // have expanded flags to inherit anyway.
      if (!this.layout.modules[moduleName] && (await store.hasModuleLayout(moduleName))) {
        await this.ensureModuleLayout(store, moduleName);
      }
      const expanded = this.layout.modules[moduleName]?.expanded ?? {};
      for (const instanceId of Object.keys(expanded)) {
        if (!expanded[instanceId]) {
          continue;
        }
        const node = module.nodes.find((candidate) => candidate.id === instanceId);
        if (node?.kind === 'instance' && node.moduleName) {
          queue.push(node.moduleName);
        }
      }
    }
  }

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'svsch.diagram',
        'SVSCH Diagram',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        },
      );
      this.panel.webview.html = diagramWebviewHtml(
        this.context,
        this.panel.webview,
        'SVSCH Diagram',
      );
      this.panel.webview.onDidReceiveMessage(
        (message: WebviewMessage) => this.handleMessage(message),
        undefined,
        this.context.subscriptions,
      );
      this.panel.onDidDispose(() => this.dispose(), undefined, this.context.subscriptions);
    }

    if (!workspaceRootPath()) {
      vscode.window.showWarningMessage('SVSCH requires an open workspace folder.');
      return;
    }
    await this.consumeGraph(this.elaborationService.getGraph());
  }

  async rebuild(live = false): Promise<void> {
    if (!workspaceRootPath()) {
      vscode.window.showWarningMessage('SVSCH requires an open workspace folder.');
      return;
    }
    if (!this.panel) {
      return;
    }
    await this.elaborationService.refresh(live).catch(() => undefined);
  }

  private async consumeGraph(graphPromise: Promise<DesignGraph>): Promise<void> {
    const version = ++this.rebuildVersion;
    await this.postStatus('rebuilding');

    try {
      const graph = await graphPromise;
      if (version !== this.rebuildVersion) {
        return;
      }
      this.graph = graph;

      this.currentModule =
        this.currentModule && this.graph.modules[this.currentModule]
          ? this.currentModule
          : (this.graph.rootModules[0] ?? Object.keys(this.graph.modules)[0] ?? '');

      const currentModule = this.currentModule ? this.graph.modules[this.currentModule] : undefined;
      if (this.currentModule && currentModule && isListOnlyPlaceholder(currentModule)) {
        await this.loadModule(this.currentModule, version);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Rebuild failed: ${message}`, error);
      if (version === this.rebuildVersion) {
        await this.postStatus('idle');
      }
      return;
    }

    if (version !== this.rebuildVersion) {
      return;
    }
    await this.postView();
    await this.postStatus('idle');
  }

  async loadModule(moduleName: string, version = this.rebuildVersion): Promise<void> {
    if (!this.graph) return;

    await this.postStatus('rebuilding');
    const graph = await this.elaborationService.getModule(moduleName);
    if (version !== this.rebuildVersion) {
      return;
    }
    this.graph = graph;
    await this.postStatus('idle');
  }

  async resetLayoutForCurrentModule(): Promise<void> {
    if (!this.currentModule) {
      return;
    }
    const store = this.getStore();
    if (!store) {
      return;
    }
    await store.resetModuleLayout(this.currentModule);
    const { [this.currentModule]: _removed, ...remainingModules } = this.layout.modules;
    this.layout = { version: 1, modules: remainingModules };
    await this.postView();
  }

  dispose(): void {
    this.elaborationInvalidationDisposable.dispose();
    this.panel = undefined;
    if (this.currentModule) {
      this.onLeaveModule?.(this.currentModule);
    }
    this.onDispose();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.postView();
      return;
    }
    if (message.type === 'openModule') {
      if (this.graph?.modules[message.moduleName]) {
        if (this.currentModule && this.currentModule !== message.moduleName) {
          this.onLeaveModule?.(this.currentModule);
        }
        this.currentModule = message.moduleName;
        const module = this.graph.modules[message.moduleName];
        if (isListOnlyPlaceholder(module)) {
          await this.loadModule(message.moduleName);
        }
        await this.postView();
      }
      return;
    }
    if (message.type === 'resetLayout') {
      this.currentModule = message.moduleName;
      await this.resetLayoutForCurrentModule();
      return;
    }
    if (message.type === 'rerouteLayout') {
      this.currentModule = message.moduleName;
      await this.rerouteCurrentModule(message.moduleName, message.nodes);
      return;
    }
    if (message.type === 'rerouteEdge') {
      this.currentModule = message.moduleName;
      await this.rerouteSingleEdge(message.moduleName, message.edgeId, message.nodes);
      return;
    }
    if (message.type === 'rerouteEdges') {
      this.currentModule = message.moduleName;
      await this.rerouteSelectedEdges(message.moduleName, message.edgeIds, message.nodes);
      return;
    }
    if (message.type === 'relayoutSelection') {
      this.currentModule = message.moduleName;
      await this.relayoutSelection(
        message.moduleName,
        message.nodeIds,
        message.nodes,
        message.expandedSizes,
      );
      return;
    }
    if (message.type === 'expandedFrameSizesChanged') {
      await this.setExpandedFrameSizes(message.moduleName, message.sizes);
      return;
    }
    if (message.type === 'layoutChanged') {
      await this.saveLayout(message.moduleName, message.nodes, message.regions);
      return;
    }
    if (message.type === 'regionLayoutChanged') {
      await this.saveRegionLayout(message.moduleName, message.regions);
      return;
    }
    if (message.type === 'edgeLayoutChanged') {
      await this.saveEdgeLayout(message.moduleName, message.edgeId, message.waypoint);
      return;
    }
    if (message.type === 'edgeRouteChanged') {
      await this.saveEdgeRoute(message.moduleName, message.edgeId, message.routePoints);
      return;
    }
    if (message.type === 'edgeRoutesChanged') {
      await this.saveEdgeRoutes(message.moduleName, message.changes, message.nodes);
      return;
    }
    if (message.type === 'cutNet') {
      await this.saveNetCut(message.moduleName, message.edge, message.nodes);
      return;
    }
    if (message.type === 'cutNets') {
      await this.saveNetCuts(message.moduleName, message.edges, message.nodes);
      return;
    }
    if (message.type === 'renameCutNet') {
      await this.renameNetCut(message.moduleName, message.netKey, message.label);
      return;
    }
    if (message.type === 'revertCutNetLabel') {
      await this.revertNetCutLabel(message.moduleName, message.netKey);
      return;
    }
    if (message.type === 'tieNet') {
      await this.tieNet(message.moduleName, message.netKey);
      return;
    }
    if (message.type === 'resetCutLabelPosition') {
      await this.resetCutLabelPosition(message.moduleName, message.nodeId);
      return;
    }
    if (message.type === 'revertNodeSizes') {
      await this.revertNodeSizes(message.moduleName, message.nodeIds);
      return;
    }
    if (message.type === 'requestExpandInstance') {
      await this.requestExpandInstance(
        message.moduleName,
        message.instanceId,
        message.topLevel,
        message.instanceSize,
        message.instanceParamRows,
      );
      return;
    }
    if (message.type === 'collapseInstance') {
      await this.collapseInstance(message.moduleName, message.instanceId, message.topLevel);
      return;
    }
    if (message.type === 'navigateToSource') {
      await this.navigateToSource(message.source);
      return;
    }
    if (message.type === 'navigateToRegion') {
      await this.navigateToRegion(message.region);
      return;
    }
    if (message.type === 'navigateToSignal') {
      await this.navigateToSignal(message.edge);
      return;
    }
    if (message.type === 'addToPartial') {
      const module = this.graph?.modules[message.moduleName];
      if (module && !isListOnlyPlaceholder(module)) {
        await this.onAddToPartial?.(module, message.nodeIds);
      }
      return;
    }
    if (message.type === 'exportSvg') {
      await this.exportSvg();
      return;
    }
  }

  private async exportSvg(): Promise<void> {
    try {
      if (!this.graph || this.currentModule === undefined) {
        return;
      }
      const store = this.getStore();
      if (store) {
        await this.ensureModuleLayout(store, this.currentModule);
        // A spliced sub-diagram mirrors the child module's own saved diagram,
        // expansions included (recursively) — pull in the layouts and
        // elaborations of every module the expand chain reaches before
        // building the view, same as `svsch render` (see
        // loadExpandedLayoutClosureSync in core/index.ts).
        await this.ensureExpandedModuleClosure(store, this.currentModule);
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

      // Re-read after the closure pass above: loading a placeholder module
      // replaces this.graph.
      const graph = this.graph;
      const baseView = await buildViewModel(graph, this.currentModule, this.layout);
      // Splice every expanded instance's sub-diagram into the exported view,
      // exactly like the live canvas (applyActiveSplices) and `svsch render`
      // (core/index.ts) do — without this the export draws just the flat
      // collapsed instance box.
      const viewModel = await applyExpandedInstances({
        graph,
        layout: this.layout,
        view: baseView,
      });
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
          workspaceRootPath() ?? '.',
          `${this.currentModule.replace(/[^a-z0-9]/gi, '_')}.svg`,
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

  private async navigateToSource(source: SourceRange): Promise<void> {
    const opened = await this.openSourceDocument(source);
    if (!opened) {
      return;
    }
    const { document } = opened;
    const startLine = Math.max(0, (source.startLine || 1) - 1);
    const endLine = Math.max(0, (source.endLine || source.startLine || 1) - 1);
    const range = new vscode.Range(
      startLine,
      source.startColumn ?? 0,
      endLine,
      source.endColumn ?? document.lineAt(endLine).text.length,
    );
    await this.revealDocumentRange(document, range);
  }

  private async openSourceDocument(
    source: SourceRange,
  ): Promise<{ document: vscode.TextDocument } | undefined> {
    const workspaceRoot = workspaceRootPath();
    if (!workspaceRoot || !source.file) {
      return undefined;
    }
    const uri = vscode.Uri.file(
      vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), source.file).fsPath,
    );
    const document = await vscode.workspace.openTextDocument(uri);
    return { document };
  }

  private async revealDocumentRange(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): Promise<void> {
    // Find if the document is already open in any tab group
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === document.uri.toString(),
      );

    await vscode.window.showTextDocument(document, {
      viewColumn: tab?.group.viewColumn ?? vscode.ViewColumn.Active,
      selection: range,
    });
  }

  // Double-click on a generate region. The wrapper block's source already spans the
  // whole generate statement; an arm's UHDM ranges only give its expression and a
  // point inside its body, so the arm's begin..end block is recovered from the
  // document text to highlight the full "expression + body".
  private async navigateToRegion(region: {
    kind: string;
    isGenerateBlock?: boolean;
    source?: SourceRange;
    bodySource?: SourceRange;
  }): Promise<void> {
    const source = region.source ?? region.bodySource;
    if (!source?.file) {
      return;
    }
    if (region.isGenerateBlock || !region.bodySource) {
      await this.navigateToSource(source);
      return;
    }
    const opened = await this.openSourceDocument(source);
    if (!opened) {
      return;
    }
    const { document } = opened;
    const range = generateArmHighlightRange(document, region.kind, source, region.bodySource);
    if (!range) {
      await this.navigateToSource(source);
      return;
    }
    await this.revealDocumentRange(document, range);
  }

  private async navigateToSignal(edge: DiagramEdge): Promise<void> {
    if (!this.currentModule || !this.graph) {
      return;
    }

    const source = resolveSignalSource(this.graph, this.currentModule, edge);
    if (source) {
      await this.navigateToSource(source);
      return;
    }

    vscode.window.showWarningMessage('This is an internal wire.');
  }

  private async saveLayout(
    moduleName: string,
    nodes: PositionedNode[],
    regions?: PositionedGenerateRegion[],
  ): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.layout = mergeNodePositions(this.layout, moduleName, nodes);
    if (regions) {
      this.layout = mergeRegionBounds(this.layout, moduleName, regions);
    }
    await this.persistModuleLayout(store, moduleName);
  }

  private async saveRegionLayout(
    moduleName: string,
    regions: PositionedGenerateRegion[],
  ): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.layout = mergeRegionBounds(this.layout, moduleName, regions);
    await this.persistModuleLayout(store, moduleName);
  }

  private async rerouteCurrentModule(moduleName: string, nodes: PositionedNode[]): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.layout = mergeRerouteLayout(this.layout, moduleName, nodes);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async rerouteSingleEdge(
    moduleName: string,
    edgeId: string,
    nodes: PositionedNode[],
  ): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.layout = mergeRerouteSingleEdge(this.layout, moduleName, edgeId, nodes);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async rerouteSelectedEdges(
    moduleName: string,
    edgeIds: string[],
    nodes: PositionedNode[],
  ): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.layout = mergeRerouteEdges(this.layout, moduleName, edgeIds, nodes);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async relayoutSelection(
    moduleName: string,
    nodeIds: string[],
    nodes: PositionedNode[],
    expandedSizes?: Record<string, { width: number; height: number }>,
  ): Promise<void> {
    const store = this.getStore();
    const designModule = this.graph?.modules[moduleName];
    if (!store || !designModule || !this.graph) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.currentModule = moduleName;

    const selected = new Set(nodeIds);
    const originalCentroid = centroidOfPositions(nodes.filter((node) => selected.has(node.id)));

    this.layout = mergeRelayoutSelection(this.layout, moduleName, nodeIds, nodes, designModule);

    if (originalCentroid) {
      // ELK's layered algorithm doesn't reliably keep a released group near where
      // it started — if the group is only wired to other released nodes (not to
      // anything still fixed), ELK treats it as its own connected component and
      // packs components independently, which can drop the whole group far from
      // the original selection. Run the layout once to see where ELK placed it,
      // then rigidly translate the group so its centroid lands back on the
      // original selection's centroid, and commit that as the new fixed
      // position — the same as if the user had dragged it there by hand.
      const relaidView = await buildViewModel(this.graph, moduleName, this.layout, {
        elkSizeOverrides: expandedSizes,
      });
      const relaidCentroid = centroidOfPositions(
        relaidView.nodes.filter((node) => selected.has(node.id)),
      );
      if (relaidCentroid) {
        const dx = originalCentroid.x - relaidCentroid.x;
        const dy = originalCentroid.y - relaidCentroid.y;
        const anchoredNodes = relaidView.nodes
          .filter((node) => selected.has(node.id))
          .map((node) => ({
            ...node,
            position: { x: node.position.x + dx, y: node.position.y + dy },
            fixed: true,
          }));
        this.layout = mergeNodePositions(this.layout, moduleName, anchoredNodes);
      }
    }

    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  // See `expandedFrameSizesChanged` and `expandedFrameSizesByModule` for
  // why this exists: an "Expand instance in place" frame's real footprint
  // only lives in the webview (never persisted), so the panel has to be
  // told about it out-of-band to route the rest of the module's wires
  // around it on every rebuild, not just during an explicit Auto Layout.
  private async setExpandedFrameSizes(
    moduleName: string,
    sizes: Record<string, { width: number; height: number }>,
  ): Promise<void> {
    const previous = this.expandedFrameSizesByModule.get(moduleName);
    const next = Object.keys(sizes).length > 0 ? sizes : undefined;
    if (next) {
      this.expandedFrameSizesByModule.set(moduleName, next);
    } else {
      this.expandedFrameSizesByModule.delete(moduleName);
    }
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      return;
    }
    if (this.currentModule === moduleName) {
      await this.postView();
    }
  }

  private async saveEdgeLayout(
    moduleName: string,
    edgeId: string,
    waypoint: { x: number; y: number },
  ): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.layout = mergeEdgeWaypoint(this.layout, moduleName, edgeId, waypoint);
    await this.persistModuleLayout(store, moduleName);
  }

  private async saveEdgeRoute(
    moduleName: string,
    edgeId: string,
    routePoints: Array<{ x: number; y: number }>,
  ): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.layout = mergeEdgeRoutePoints(this.layout, moduleName, edgeId, routePoints);
    await this.persistModuleLayout(store, moduleName);
    await this.postView(); // Send updated view back to webview immediately
  }

  private async saveEdgeRoutes(
    moduleName: string,
    changes: Array<{ edgeId: string; routePoints: Array<{ x: number; y: number }> }>,
    nodes?: PositionedNode[],
  ): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    let layout = nodes ? mergeNodePositions(this.layout, moduleName, nodes) : this.layout;
    for (const change of changes) {
      layout = mergeEdgeRoutePoints(layout, moduleName, change.edgeId, change.routePoints);
    }
    this.layout = layout;
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async saveNetCut(
    moduleName: string,
    edge: DiagramEdge,
    nodes: PositionedNode[],
  ): Promise<void> {
    const store = this.getStore();
    const designModule = this.graph?.modules[moduleName];
    if (!store || !designModule) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.currentModule = moduleName;
    this.layout = mergeNetCut(this.layout, moduleName, edge, designModule, nodes);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async saveNetCuts(
    moduleName: string,
    edges: DiagramEdge[],
    nodes: PositionedNode[],
  ): Promise<void> {
    const store = this.getStore();
    const designModule = this.graph?.modules[moduleName];
    if (!store || !designModule) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.currentModule = moduleName;
    this.layout = mergeNetCuts(this.layout, moduleName, edges, designModule, nodes);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async renameNetCut(moduleName: string, netKey: string, label: string): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.currentModule = moduleName;
    this.layout = renameCutNet(this.layout, moduleName, netKey, label);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async revertNetCutLabel(moduleName: string, netKey: string): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.currentModule = moduleName;
    this.layout = revertCutNetLabel(this.layout, moduleName, netKey);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async tieNet(moduleName: string, netKey: string): Promise<void> {
    const store = this.getStore();
    const graph = this.graph;
    if (!store || !graph?.modules[moduleName]) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.currentModule = moduleName;
    this.layout = removeNetCut(this.layout, moduleName, netKey);
    // Let the just-restored connection find its natural arrangement once,
    // then anchor that result. Later ties must not re-run ELK over unrelated
    // components and make already-settled portions of the diagram jump.
    const tiedView = await buildViewModel(graph, moduleName, this.layout);
    this.layout = mergeNodePositions(
      this.layout,
      moduleName,
      tiedView.nodes.map((node) => ({
        ...node,
        fixed: node.kind === 'netLabel' ? node.fixed : true,
      })),
    );
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async resetCutLabelPosition(moduleName: string, nodeId: string): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.currentModule = moduleName;
    this.layout = resetCutLabelPosition(this.layout, moduleName, nodeId);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  private async revertNodeSizes(moduleName: string, nodeIds: string[]): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.currentModule = moduleName;
    this.layout = revertNodeSizes(this.layout, moduleName, nodeIds);
    await this.persistModuleLayout(store, moduleName);
    await this.postView();
  }

  // The host hands the webview the child module's own IR/graph (the same
  // data `openModule` already uses) and — the actual layout work — the
  // child's standalone place-and-route result dropped into the frame with
  // its boundary ports wired up by libavoid (see buildExpandSpliceLayout),
  // always freshly derived from the child module's *current* SavedModuleLayout
  // (this.layout, already in-memory and current — no separate snapshot to go
  // stale). It also persists the `expanded` flag so a reopened module knows
  // to re-request this on load. Turning the frame-local layout into canvas
  // nodes/edges (namespacing, translation, drag-sync) stays client-side in
  // webview/expand.
  private async requestExpandInstance(
    moduleName: string,
    instanceId: string,
    topLevel: boolean,
    instanceSize?: { width: number; height: number },
    instanceParamRows?: number,
  ): Promise<void> {
    const store = this.getStore();
    const designModule = this.graph?.modules[moduleName];
    if (!store || !designModule || !this.panel) {
      return;
    }
    const instanceNode = designModule.nodes.find((node) => node.id === instanceId);
    if (!instanceNode || instanceNode.kind !== 'instance' || !instanceNode.moduleName) {
      return;
    }
    // Array-of-instances nodes are excluded from v1 (see issue #232 decision
    // 7) — the toolbar already hides the action for these, but a stale
    // request from an already-open webview should still be refused.
    if (nodeIsArrayNode(instanceNode)) {
      return;
    }
    const childModuleName = instanceNode.moduleName;
    let childModule = this.graph?.modules[childModuleName];
    if (childModule && isListOnlyPlaceholder(childModule)) {
      await this.loadModule(childModuleName);
      childModule = this.graph?.modules[childModuleName];
    }
    if (!childModule || !this.panel) {
      return;
    }

    // The `expanded` flag (used to auto-re-expand on module open) belongs to
    // whichever module is opened *directly* — a nested Expand (inside an
    // already-expanded instance) must not flag the intermediate child module
    // itself, or opening that module standalone later would incorrectly
    // auto-expand it too.
    if (topLevel) {
      await this.ensureModuleLayout(store, moduleName);
      this.layout = setInstanceExpanded(this.layout, moduleName, instanceId, true);
      await this.persistModuleLayout(store, moduleName);
    }

    // The spliced sub-diagram mirrors the child module's own diagram,
    // expansions included (recursively) — pull in the saved layouts and
    // elaborations of every module that chain reaches before computing the
    // splice, or their `expanded` flags wouldn't even be in memory.
    await this.ensureExpandedModuleClosure(store, childModuleName);

    // The child's normal standalone place-and-route, dropped into the frame
    // with the boundary ports wired up by libavoid. Best-effort: on any
    // failure the webview falls back to its own ELK-only placement, the same
    // degraded mode an older host produces.
    let spliceLayout: ExpandSpliceLayout | undefined;
    try {
      spliceLayout = this.graph
        ? await buildExpandSpliceLayout({
            graph: this.graph,
            layout: this.layout,
            childModuleName,
            instanceId,
            instancePorts: instanceNode.ports,
            instanceSize: instanceSize ?? resolvedNodeDimensions(instanceNode),
            instanceParamRows: instanceParamRows ?? instanceParameterRows(instanceNode),
          })
        : undefined;
    } catch (error) {
      logger.warn(`expand splice layout failed for ${childModuleName}: ${String(error)}`);
    }

    // Expanding grows the instance's on-canvas footprint (see
    // buildExpandSpliceLayout's expandedSize) without re-running `moduleName`'s
    // own layout, so a sibling that used to sit clear of the collapsed
    // instance can end up underneath the expanded frame. That's left as-is —
    // free overlap, same as any other manual edit — and resolved by the user
    // running Auto Layout on the diagram afterward (which places released
    // blocks against the frame's real footprint; see relayoutSelection's
    // elkSizeOverrides). *Wire* routing around the expanded frame is handled
    // separately and automatically — see expandedFrameSizesByModule.

    const payload: ExpandInstancePayload = {
      instanceId,
      childModuleName,
      module: childModule,
      spliceLayout,
    };
    await this.panel.webview.postMessage({ type: 'expandInstanceData', moduleName, payload });
  }

  private async collapseInstance(
    moduleName: string,
    instanceId: string,
    topLevel: boolean,
  ): Promise<void> {
    if (!topLevel) {
      return;
    }
    const store = this.getStore();
    if (!store) {
      return;
    }
    await this.ensureModuleLayout(store, moduleName);
    this.layout = setInstanceExpanded(this.layout, moduleName, instanceId, false);
    await this.persistModuleLayout(store, moduleName);
  }

  private postView(): Promise<void> {
    const pending = this.postViewQueue.then(() => this.postViewNow());
    this.postViewQueue = pending.catch(() => {});
    return pending;
  }

  private async postViewNow(): Promise<void> {
    if (!this.panel || !this.graph || this.currentModule === undefined) {
      return;
    }
    const panel = this.panel;
    const graph = this.graph;
    const moduleName = this.currentModule;
    const isCurrentView = () =>
      this.panel === panel && this.graph === graph && this.currentModule === moduleName;
    const store = this.getStore();
    if (store) {
      await this.ensureModuleLayout(store, moduleName);
      if (!isCurrentView()) {
        return;
      }
      // Explicit flag, not "no saved layout exists": mergeNodeSnapshot below
      // now persists a full render snapshot unconditionally, so a module's
      // file can already exist (and moduleLayout.nodes already be non-empty)
      // well before the user has ever genuinely opened it.
      const isFirstOpen = !this.layout.modules[moduleName]?.firstOpenHandled;
      if (isFirstOpen) {
        const designModule = graph.modules[moduleName];
        if (designModule) {
          const includeClockAndReset = vscode.workspace
            .getConfiguration('svsch')
            .get<boolean>('autocut-clk-reset', true);
          const edges = firstOpenAutoCutEdges(designModule, includeClockAndReset);
          if (edges.length > 0) {
            this.layout = mergeFirstOpenNetCuts(this.layout, moduleName, edges, designModule);
          }
          this.layout = markFirstOpenHandled(this.layout, moduleName);
          await this.persistModuleLayout(store, moduleName);
        }
      }
    }
    const view: DiagramViewModel = await buildViewModel(graph, moduleName, this.layout, {
      elkSizeOverrides: this.expandedFrameSizesByModule.get(moduleName),
    });
    if (store) {
      this.layout = mergeNodeSnapshot(this.layout, moduleName, view.nodes);
      this.layout = mergeEdgeSnapshot(this.layout, moduleName, view.edges);
      // Fire-and-forget: this per-render durability snapshot must never make
      // the webview wait on a disk write. LayoutStore debounces per module
      // and skips writes whose content hasn't actually changed, so an idle
      // diagram doesn't churn the file (or its git history) on every repaint.
      void this.persistModuleLayout(store, moduleName);
    }
    if (!isCurrentView()) {
      return;
    }
    const expanded = this.layout.modules[moduleName]?.expanded;
    const expandedInstanceIds = expanded ? Object.keys(expanded).filter((id) => expanded[id]) : [];
    await panel.webview.postMessage({
      type: 'graph',
      view,
      modules: Object.keys(graph.modules),
      expandedInstanceIds,
    });
  }

  private async postStatus(status: 'idle' | 'rebuilding'): Promise<void> {
    await this.panel?.webview.postMessage({
      type: 'status',
      status,
    });
  }
}

function workspaceRootPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function setInstanceExpanded(
  layout: SavedLayout,
  moduleName: string,
  instanceId: string,
  isExpanded: boolean,
): SavedLayout {
  const moduleLayout = layout.modules[moduleName] ?? { nodes: {} };
  const expanded = { ...(moduleLayout.expanded ?? {}) };
  if (isExpanded) {
    expanded[instanceId] = true;
  } else {
    delete expanded[instanceId];
  }
  return {
    version: 1,
    modules: { ...layout.modules, [moduleName]: { ...moduleLayout, expanded } },
  };
}

function centroidOfPositions(
  nodes: Array<{ position: { x: number; y: number } }>,
): { x: number; y: number } | undefined {
  if (nodes.length === 0) {
    return undefined;
  }
  const sum = nodes.reduce(
    (acc, node) => ({ x: acc.x + node.position.x, y: acc.y + node.position.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / nodes.length, y: sum.y / nodes.length };
}

function generateArmHighlightRange(
  document: vscode.TextDocument,
  kind: string,
  source: SourceRange,
  bodySource: SourceRange,
): vscode.Range | undefined {
  const span = generateArmSpan(document.getText(), kind, source, bodySource);
  if (!span) return undefined;
  return new vscode.Range(document.positionAt(span.start), document.positionAt(span.end));
}
