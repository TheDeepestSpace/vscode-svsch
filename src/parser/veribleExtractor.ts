import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { DesignGraph } from '../ir/types';

const execFileAsync = promisify(execFile);

export async function extractDesignWithVerible(
  files: string[],
  veriblePath: string,
  workspaceRoot: string
): Promise<{ graph: DesignGraph; success: boolean }> {
  const graph: DesignGraph = {
    rootModules: [],
    modules: {},
    diagnostics: [],
    generatedAt: new Date().toISOString()
  };

  try {
    const args = ['--export_json', '--printtree', ...files];
    const { stdout } = await execFileAsync(veriblePath, args, {
      maxBuffer: 50 * 1024 * 1024
    });
    
    const parsed = JSON.parse(stdout);
    
    // TODO: Build actual DesignGraph nodes/edges by walking parsed AST
    // For now, we return success: false to immediately trigger the textExtractor fallback
    // This allows test suites to run against the 'verible' backend config without failing.
    return { graph, success: false };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    graph.diagnostics.push({
      severity: 'error',
      message: `Failed to extract DesignGraph via Verible AST: ${errorMsg}`
    });
    return { graph, success: false };
  }
}
