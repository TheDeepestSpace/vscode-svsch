import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDesignGraph, type ParserOptions } from './parser/backend';
import type {
  ElaborationRequest,
  ElaborationServiceHost,
  InvalidationWatcher,
} from './elaborationService';
import { logger } from './logger';
import { DEFAULT_CLOCK_SIGNAL_NAMES, DEFAULT_RESET_SIGNAL_NAMES } from './parser/textExtractor';

export function createVscodeElaborationHost(
  context: vscode.ExtensionContext,
): ElaborationServiceHost {
  return {
    build: buildDesignGraph,
    createParserOptions: (request) => createParserOptions(context, request),
    withProgress: (task) =>
      Promise.resolve(
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'SVSCH',
            cancellable: false,
          },
          async (progress) =>
            task((message, increment) => {
              logger.log(`Progress: ${message} (${increment}%)`);
              progress.report({ message, increment });
            }),
        ),
      ),
    watch: createSharedWatcher,
  };
}

function createParserOptions(
  context: vscode.ExtensionContext,
  request: ElaborationRequest,
): ParserOptions {
  const workspaceRoot = workspaceRootPath();
  if (!workspaceRoot) {
    throw new Error('SVSCH requires an open workspace folder.');
  }

  const config = vscode.workspace.getConfiguration('svsch');
  const projectFolder = config.get<string>('projectFolder') || '.';
  const surelogPath = resolveSurelogPath(context, workspaceRoot, config.get<string>('surelogPath'));
  const backendPath = resolveBackendPath(context, workspaceRoot);

  return {
    workspaceRoot,
    projectFolder,
    backend: 'uhdm',
    veriblePath: config.get<string>('veriblePath') || 'verible-verilog-syntax',
    surelogPath,
    backendPath,
    includePaths: config.get<string[]>('includePaths') || [],
    defines: config.get<Record<string, string>>('defines') || {},
    clockSignalNames: config.get<string[]>('clockSignalNames', DEFAULT_CLOCK_SIGNAL_NAMES),
    resetSignalNames: config.get<string[]>('resetSignalNames', DEFAULT_RESET_SIGNAL_NAMES),
    moduleName: request.moduleName,
    listOnly: request.listOnly,
    overlays: request.live ? openHdlDocumentOverlays(workspaceRoot, projectFolder) : undefined,
    includeExternalDiagnostics: request.moduleName ? false : !request.live,
    fileList: config.get<string>('fileList') || undefined,
  };
}

function resolveSurelogPath(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  configuredPath: string | undefined,
): string {
  if (configuredPath && configuredPath !== 'surelog') {
    logger.log(`Using user-configured surelogPath: ${configuredPath}`);
    return configuredPath;
  }

  const packagedPath = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'surelog',
    'bin',
    'surelog',
  ).fsPath;
  logger.log(`Checking for packaged surelog at: ${packagedPath}`);
  if (fs.existsSync(packagedPath)) {
    if (process.platform === 'linux' && process.arch !== 'x64') {
      logger.warn(
        `Packaged surelog is x64, but system is ${process.arch}. Falling back to system 'surelog'.`,
      );
    } else {
      logger.log(`Using packaged surelog (absolute): ${packagedPath}`);
      return packagedPath;
    }
  }

  const projectPath = findUp(
    workspaceRoot,
    path.join('dist', 'surelog', 'bin', 'surelog'),
    workspaceRoot,
  );
  if (projectPath) {
    logger.log(`Found packaged surelog at project root: ${projectPath}`);
    return projectPath;
  }

  logger.log("Falling back to system 'surelog' (not found in extension dist or project dist)");
  return 'surelog';
}

function resolveBackendPath(context: vscode.ExtensionContext, workspaceRoot: string): string {
  const packagedPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'svsch_backend').fsPath;
  logger.log(`Checking for backend at: ${packagedPath}`);
  if (fs.existsSync(packagedPath)) {
    logger.log(`Using backend (absolute): ${packagedPath}`);
    return packagedPath;
  }

  const projectPath = findUp(workspaceRoot, path.join('dist', 'svsch_backend'), workspaceRoot);
  if (projectPath) {
    logger.log(`Found backend at project root: ${projectPath}`);
    return projectPath;
  }

  logger.error(`Backend binary NOT FOUND! Tried ${packagedPath} and project roots.`);
  return packagedPath;
}

function findUp(start: string, relativePath: string, boundary: string): string | undefined {
  let current = path.resolve(start);
  const root = path.resolve(boundary);
  if (!isWithin(root, current)) {
    return undefined;
  }

  while (true) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (current === root) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (!isWithin(root, parent)) {
      return undefined;
    }
    current = parent;
  }
}

function createSharedWatcher(onDidInvalidate: (live: boolean) => void): InvalidationWatcher {
  let watcher: vscode.FileSystemWatcher | undefined;
  let watcherSubscriptions: vscode.Disposable[] = [];
  let watchedProjectRoot: string | undefined;
  let rebuildTimer: NodeJS.Timeout | undefined;

  const schedule = (live: boolean) => {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
    }
    rebuildTimer = setTimeout(
      () => {
        rebuildTimer = undefined;
        onDidInvalidate(live);
      },
      live ? 350 : 250,
    );
  };

  const disposeWatcher = () => {
    for (const subscription of watcherSubscriptions) {
      subscription.dispose();
    }
    watcherSubscriptions = [];
    watcher?.dispose();
    watcher = undefined;
    watchedProjectRoot = undefined;
  };

  const recreateWatcher = () => {
    disposeWatcher();
    watchedProjectRoot = projectRootPath();
    if (!watchedProjectRoot) {
      return;
    }

    const pattern = new vscode.RelativePattern(watchedProjectRoot, '**/*.{sv,v,svh,vh}');
    watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onFileEvent = (uri: vscode.Uri) => {
      if (watchedProjectRoot && isWithin(watchedProjectRoot, uri.fsPath)) {
        schedule(false);
      }
    };
    watcherSubscriptions = [
      watcher.onDidCreate(onFileEvent),
      watcher.onDidChange(onFileEvent),
      watcher.onDidDelete(onFileEvent),
    ];
  };

  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        watchedProjectRoot &&
        isHdlUri(event.document.uri) &&
        isWithin(watchedProjectRoot, event.document.uri.fsPath)
      ) {
        schedule(true);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('svsch')) {
        if (event.affectsConfiguration('svsch.projectFolder')) {
          recreateWatcher();
        }
        schedule(false);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      recreateWatcher();
      schedule(false);
    }),
  ];
  recreateWatcher();

  return {
    cancelPending: () => {
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
        rebuildTimer = undefined;
      }
    },
    dispose: () => {
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
      }
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      disposeWatcher();
    },
  };
}

function workspaceRootPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function projectRootPath(): string | undefined {
  const workspaceRoot = workspaceRootPath();
  if (!workspaceRoot) {
    return undefined;
  }
  const projectFolder =
    vscode.workspace.getConfiguration('svsch').get<string>('projectFolder') || '.';
  return path.resolve(workspaceRoot, projectFolder);
}

function isHdlUri(uri: vscode.Uri): boolean {
  return /\.(sv|v|svh|vh)$/i.test(uri.fsPath);
}

function openHdlDocumentOverlays(
  workspaceRoot: string,
  projectFolder: string,
): Array<{ file: string; text: string }> {
  const projectRoot = path.resolve(workspaceRoot, projectFolder || '.');
  return vscode.workspace.textDocuments
    .filter((document) => isHdlUri(document.uri) && isWithin(projectRoot, document.uri.fsPath))
    .map((document) => ({
      file: vscode.workspace.asRelativePath(document.uri, false),
      text: document.getText(),
    }));
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
