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
  overlays?: Array<{
    file: string;
    text: string;
  }>;
  includeExternalDiagnostics?: boolean;
}

export async function buildDesignGraph(options: ParserOptions): Promise<DesignGraph> {
  const projectRoot = path.resolve(options.workspaceRoot, options.projectFolder || '.');
  const files = await collectHdlFiles(projectRoot);

  let graph: DesignGraph = { rootModules: [], modules: {}, diagnostics: [], generatedAt: new Date().toISOString() };

  if (files.length === 0) {
    graph.diagnostics.push({
      severity: 'warning',
      message: `No SystemVerilog or Verilog files found in ${options.projectFolder || '.'}.`
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

  try {
    graph = await extractDesignWithUhdm(files, options.workspaceRoot, options.surelogPath, options.backendPath);
  } catch (e: any) {
    logger.error('UHDM Extraction Crashed', e);
    graph.diagnostics.push({
      severity: 'error',
      message: `UHDM extraction crashed: ${e.message}`
    });
  }

  return graph;
}

async function collectHdlFiles(root: string): Promise<string[]> {
  const results: string[] = [];

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
      } else if (HDL_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results.sort();
}
