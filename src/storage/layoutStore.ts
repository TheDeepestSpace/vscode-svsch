import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SavedNodeLayout {
  x: number;
  y: number;
  stale?: boolean;
}

export interface SavedEdgeLayout {
  waypoint?: {
    x: number;
    y: number;
  };
  routePoints?: Array<{
    x: number;
    y: number;
  }>;
  stale?: boolean;
}

export interface SavedViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SavedModuleLayout {
  nodes: Record<string, SavedNodeLayout>;
  edges?: Record<string, SavedEdgeLayout>;
  viewport?: SavedViewport;
  expanded?: Record<string, boolean>;
}

export interface SavedLayout {
  version: 1;
  modules: Record<string, SavedModuleLayout>;
}

export class LayoutStore {
  constructor(private readonly workspaceRoot: string) {}

  get layoutPath(): string {
    return path.join(this.workspaceRoot, '.svsch', 'layout.json');
  }

  async read(): Promise<SavedLayout> {
    try {
      const raw = await fs.readFile(this.layoutPath, 'utf8');
      const parsed = JSON.parse(raw) as SavedLayout;
      return {
        version: 1,
        modules: parsed.modules ?? {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Unable to read SVSCH layout: ${(error as Error).message}`);
      }
      return { version: 1, modules: {} };
    }
  }

  async write(layout: SavedLayout): Promise<void> {
    await fs.mkdir(path.dirname(this.layoutPath), { recursive: true });
    await fs.writeFile(this.layoutPath, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
  }
}
