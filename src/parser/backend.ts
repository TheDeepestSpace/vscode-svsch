import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesignGraph } from '../ir/types';
import { extractDesignFromText } from './textExtractor';
import { extractDesignWithVerible } from './veribleExtractor';

const execFileAsync = promisify(execFile);
const HDL_EXTENSIONS = new Set(['.sv', '.v', '.svh', '.vh']);

export interface ParserOptions {
  workspaceRoot: string;
  projectFolder: string;
  backend: 'verible' | 'fallback';
  veriblePath: string;
  overlays?: Array<{
    file: string;
    text: string;
  }>;
  includeExternalDiagnostics?: boolean;
}

export async function buildDesignGraph(options: ParserOptions): Promise<DesignGraph> {
  const projectRoot = path.resolve(options.workspaceRoot, options.projectFolder || '.');
  const files = await collectHdlFiles(projectRoot);
  const sources = await Promise.all(
    files.map(async (file) => ({
      file,
      text: await fs.readFile(file, 'utf8')
    }))
  );
  const sourceMap = new Map(sources.map((source) => [path.resolve(source.file), source]));

  for (const overlay of options.overlays ?? []) {
    const resolved = path.resolve(options.workspaceRoot, overlay.file);
    if (!resolved.startsWith(projectRoot)) {
      continue;
    }
    sourceMap.set(resolved, {
      file: resolved,
      text: overlay.text
    });
  }

  let graph: DesignGraph = { rootModules: [], modules: {}, diagnostics: [], generatedAt: new Date().toISOString() };
  let usedVeribleIR = false;

  if (options.backend === 'verible') {
    try {
      const result = await extractDesignWithVerible(files, options.veriblePath, options.workspaceRoot);
      if (result.success) {
        graph = result.graph;
        usedVeribleIR = true;
      }
    } catch (e) {
      // Verible crashed or binary not found
    }
  }

  if (!usedVeribleIR) {
    // Fallback to regex textExtractor
    graph = extractDesignFromText(
      [...sourceMap.values()].map((source) => ({
        file: path.relative(options.workspaceRoot, source.file),
        text: source.text
      }))
    );

    // If backend was set to verible, still grab external diagnostics
    if (options.backend === 'verible' && options.includeExternalDiagnostics !== false) {
      const diagnostics = await runVeribleDiagnostics(files, options.veriblePath, options.workspaceRoot);
      graph.diagnostics.push(...diagnostics);
      
      // Give a trace that fallback was used for diagram generation
      if (files.length > 0) {
          graph.diagnostics.push({
            severity: 'info',
            message: 'Verible AST extractor returned success=false. Falling back to built-in toy extractor for diagram generation.'
          });
      }
    }
  }

  if (files.length === 0) {
    graph.diagnostics.push({
      severity: 'warning',
      message: `No SystemVerilog or Verilog files found in ${options.projectFolder || '.'}.`
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

async function runVeribleDiagnostics(files: string[], veriblePath: string, workspaceRoot: string): Promise<DesignGraph['diagnostics']> {
  const diagnostics: DesignGraph['diagnostics'] = [];

  for (const file of files) {
    try {
      await execFileAsync(veriblePath, ['--export_json', file], {
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (error) {
      const execError = error as Error & { stderr?: string; code?: number };
      diagnostics.push({
        severity: execError.code === undefined ? 'warning' : 'error',
        message: `Verible could not parse ${path.relative(workspaceRoot, file)}: ${execError.stderr?.trim() || execError.message}`,
        source: {
          file: path.relative(workspaceRoot, file)
        }
      });
    }
  }

  if (files.length > 0 && diagnostics.length === files.length) {
    diagnostics.push({
      severity: 'warning',
      message: 'Falling back to the built-in toy extractor. Configure svsch.veriblePath when Verible is installed elsewhere.'
    });
  }

  return diagnostics;
}
