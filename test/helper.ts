import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildDesignGraph } from '../src/parser/backend';
import type { DesignGraph } from '../src/ir/types';

export async function runParser(backend: 'fallback' | 'verible', fileOrFiles: string | {file: string, text: string}[], singleText?: string): Promise<DesignGraph> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svsch-test-'));
  
  if (typeof fileOrFiles === 'string') {
    const tmpFile = path.join(tmpDir, fileOrFiles);
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(tmpFile, singleText!);
  } else {
    for (const f of fileOrFiles) {
      const tmpFile = path.join(tmpDir, f.file);
      await fs.mkdir(path.dirname(tmpFile), { recursive: true });
      await fs.writeFile(tmpFile, f.text);
    }
  }
  
  try {
    return await buildDesignGraph({
      workspaceRoot: tmpDir,
      projectFolder: '.',
      backend,
      veriblePath: 'verible-verilog-syntax',
      includeExternalDiagnostics: false
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
