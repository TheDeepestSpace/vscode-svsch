import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignGraph } from '../ir/types';
import { extractDesignWithUhdm } from './uhdmExtractor';
import { logger } from '../logger';
const HDL_EXTENSIONS = new Set(['.sv', '.v', '.svh', '.vh']);

export interface ParserOptions {
  workspaceRoot: string;
  projectFolder: string;
  backend: 'uhdm';
  veriblePath: string;
  surelogPath?: string;
  backendPath?: string;
  includePaths?: string[];
  defines?: Record<string, string>;
  moduleName?: string;
  listOnly?: boolean;
  overlays?: Array<{
    file: string;
    text: string;
  }>;
  includeExternalDiagnostics?: boolean;
}

export async function buildDesignGraph(options: ParserOptions): Promise<DesignGraph> {
  const projectRoot = path.resolve(options.workspaceRoot, options.projectFolder || '.');
  const { sources, headers } = await collectHdlFiles(projectRoot);

  let graph: DesignGraph = { rootModules: [], modules: {}, diagnostics: [], generatedAt: new Date().toISOString() };

  if (sources.length === 0) {
    graph.diagnostics.push({
      severity: 'warning',
      message: `No SystemVerilog or Verilog source files found in ${options.projectFolder || '.'}.`
    });
    return graph;
  }

  // Only use UHDM backend, no fallbacks
  if (!options.surelogPath || !options.backendPath) {
    graph.diagnostics.push({
      severity: 'error',
      message: 'UHDM backend requires surelogPath and backendPath to be configured.'
    });
    return graph;
  }

  // Automatically add directories containing headers to include paths
  const autoIncludePaths = Array.from(new Set(headers.map(h => path.dirname(h))));
  const allIncludePaths = [...(options.includePaths || []), ...autoIncludePaths];

  try {
    graph = await extractDesignWithUhdm(
      sources, 
      options.workspaceRoot, 
      options.surelogPath, 
      options.backendPath,
      allIncludePaths,
      options.defines,
      options.listOnly ? '--list-only' : options.moduleName
    );
  } catch (e: any) {
    logger.error('UHDM Extraction Crashed', e);
    graph.diagnostics.push({
      severity: 'error',
      message: `UHDM extraction crashed: ${e.message}`
    });
  }

  return graph;
}

async function collectHdlFiles(root: string): Promise<{ sources: string[], headers: string[] }> {
  const sources: string[] = [];
  const headers: string[] = [];
  const SRC_EXT = new Set(['.sv', '.v']);
  const HDR_EXT = new Set(['.svh', '.vh']);

  async function walk(dir: string): Promise<void> {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.svsch') {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const ext = path.extname(entry.name);
        if (SRC_EXT.has(ext)) {
          sources.push(fullPath);
        } else if (HDR_EXT.has(ext)) {
          headers.push(fullPath);
        }
      }
    }
  }

  await walk(root);
  return { 
    sources: sources.sort(), 
    headers: headers.sort() 
  };
}
