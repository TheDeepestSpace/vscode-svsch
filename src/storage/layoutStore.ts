import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SavedNodeLayout {
  x: number;
  y: number;
  stale?: boolean;
  fixed?: boolean;
  /**
   * Manual grow-only resize override, in grid units. Only ever set together
   * with `fixed: true` (see mergeNodePositions) — resizing a node pins its
   * position the same way generate-region resize pins the region's bounds.
   */
  width?: number;
  height?: number;
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
  /**
   * Full-render safety net (see mergeEdgeSnapshot): the edge's last-computed
   * route, recorded on every render regardless of whether the user ever
   * touched it. Unlike `routePoints`, this never marks the edge as manually
   * fixed and never excludes it from auto-routing — it's only a fallback used
   * if a render's routing pass fails to produce a route for this edge.
   */
  routeSnapshot?: Array<{
    x: number;
    y: number;
  }>;
  stale?: boolean;
}

export interface SavedRegionLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  stale?: boolean;
  fixed?: boolean;
}

export interface SavedViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SavedNetCut {
  label: string;
  source: {
    nodeId: string;
    portId?: string;
  };
  /**
   * Manual cuts initially keep both dangling ends at the exact point where
   * the wire was split, even if their labels overlap. The first Auto Layout
   * involving either endpoint removes this marker and enables normal label
   * placement. Automatic first-open cuts never set it.
   */
  deferLabelPlacement?: boolean;
  /**
   * 'declared' means `label` is the net's actual SV-declared name (a port or
   * wire/reg/var name known from the source) — it must not be silently
   * regenerated and the UI should not allow renaming it. 'synthetic' means
   * the label was invented by the tool (e.g. "NET_3", "u_alu.result") and is
   * freely renameable. Absent on labels saved before this field existed —
   * treated as 'synthetic' for backward compatibility.
   */
  origin?: 'declared' | 'synthetic';
  /**
   * `label`'s value at the moment this net was cut — whatever that default
   * was (even a tool-invented guess), it's still the net's legitimate name
   * right now, so it renders in regular type. Only once the user actively
   * types something else does the label diverge from this and switch to
   * italic; renaming back to this exact value (or using the "revert label"
   * control) restores regular type. Never touched by renameCutNet. Absent
   * on labels saved before this field existed — treated as never-renamed.
   */
  defaultLabel?: string;
}

export interface SavedModuleLayout {
  nodes: Record<string, SavedNodeLayout>;
  edges?: Record<string, SavedEdgeLayout>;
  regions?: Record<string, SavedRegionLayout>;
  viewport?: SavedViewport;
  /**
   * Which of this module's instance nodes currently have "Expand" toggled on
   * (see NodeSelectionToolbar), keyed by instance node id. Read on open so a
   * previously-expanded instance re-expands automatically. This is the only
   * state persisted for "Expand instance in place" — the spliced content
   * itself is never separately saved; it's always re-derived from the child
   * module's own standalone SavedModuleLayout (see webview/expand/splice.ts's
   * SpliceResult doc for why: only that module's own view may edit its
   * layout, so every expand of it just reflects that layout as-is).
   */
  expanded?: Record<string, boolean>;
  /** Per-call-site expansion state, keyed by the funcCall node's stable id. */
  expandedFunctionCalls?: Record<string, boolean>;
  /** Per-call-site expansion state, keyed by the taskCall node's stable id. */
  expandedTaskCalls?: Record<string, boolean>;
  netCuts?: Record<string, SavedNetCut>;
  /**
   * Set once the first-open auto net-cut decision has run for this module,
   * whether or not it actually cut anything. This is the explicit signal for
   * "genuinely first open" — since full-render snapshots (see
   * mergeNodeSnapshot) now make `nodes` non-empty and the module file exist
   * on disk well before any real user interaction, neither can be used as a
   * stand-in for that check anymore.
   */
  firstOpenHandled?: boolean;
}

/**
 * In-memory convenience aggregate spanning every module a caller has loaded
 * in a session. Nothing on disk is ever stored in this shape — each module
 * is persisted independently under `.svsch/layouts/` (see LayoutStore) — but
 * pure layout-merging code and tests find it easier to pass one bag of
 * modules around than a lone SavedModuleLayout.
 */
export interface SavedLayout {
  version: 1;
  modules: Record<string, SavedModuleLayout>;
}

interface PendingModuleWrite {
  layout: SavedModuleLayout | null;
  syncTimer: NodeJS.Timeout | null;
  resolves: Array<() => void>;
  writeQueue: Promise<void>;
  /** Serialized content of the last successful disk write, to skip no-op writes. */
  lastWritten: string | null;
}

/**
 * Persists each module's layout as its own file under `.svsch/layouts/`
 * instead of one monolithic `.svsch/layout.json`. This keeps concurrent edits
 * to different modules from colliding in Git, and keeps every read/write
 * scoped to the single module that actually changed instead of the whole
 * project's layout data.
 */
export class LayoutStore {
  private readonly pending = new Map<string, PendingModuleWrite>();
  private readonly SYNC_DEBOUNCE_MS = 100;

  constructor(private readonly workspaceRoot: string) {}

  get layoutsDir(): string {
    return path.join(this.workspaceRoot, '.svsch', 'layouts');
  }

  private modulePath(moduleName: string): string {
    return path.join(this.layoutsDir, `${encodeURIComponent(moduleName)}.json`);
  }

  async hasModuleLayout(moduleName: string): Promise<boolean> {
    try {
      await fs.access(this.modulePath(moduleName));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `Unable to inspect SVSCH layout for module "${moduleName}": ${(error as Error).message}`,
        );
      }
      return false;
    }
  }

  async readModuleLayout(moduleName: string): Promise<SavedModuleLayout> {
    const filePath = this.modulePath(moduleName);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SavedModuleLayout>;
      return { ...parsed, nodes: parsed.nodes ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `Unable to read SVSCH layout for module "${moduleName}": ${(error as Error).message}`,
        );
      }
      return { nodes: {} };
    }
  }

  /**
   * Schedules a per-module layout write. Debounced and serialized per module
   * so rapid edits to one module coalesce, while writes to different modules
   * never block each other.
   */
  async writeModuleLayout(moduleName: string, layout: SavedModuleLayout): Promise<void> {
    const entry = this.entryFor(moduleName);
    entry.layout = layout;

    if (entry.syncTimer) {
      clearTimeout(entry.syncTimer);
    }

    return new Promise((resolve) => {
      entry.resolves.push(resolve);
      entry.syncTimer = setTimeout(() => {
        entry.syncTimer = null;
        const resolves = entry.resolves;
        entry.resolves = [];
        entry.writeQueue = entry.writeQueue
          .then(() => this.performWrite(moduleName, entry))
          .then(() => {
            for (const r of resolves) r();
          });
      }, this.SYNC_DEBOUNCE_MS);
    });
  }

  /**
   * Deletes a module's saved layout (used by "reset layout"), cancelling any
   * write still pending for it.
   */
  async resetModuleLayout(moduleName: string): Promise<void> {
    const entry = this.entryFor(moduleName);
    if (entry.syncTimer) {
      clearTimeout(entry.syncTimer);
      entry.syncTimer = null;
    }
    entry.layout = null;
    entry.lastWritten = null;
    const resolves = entry.resolves;
    entry.resolves = [];

    entry.writeQueue = entry.writeQueue.then(async () => {
      try {
        await fs.unlink(this.modulePath(moduleName));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(
            `Failed to reset SVSCH layout for module "${moduleName}": ${(error as Error).message}`,
          );
        }
      }
    });
    await entry.writeQueue;
    for (const r of resolves) r();
  }

  /**
   * Immediately writes every module with a pending debounced write, bypassing
   * their debounce timers but still serialized per module.
   */
  async flush(): Promise<void> {
    const flushes: Promise<void>[] = [];
    for (const [moduleName, entry] of this.pending) {
      if (entry.syncTimer) {
        clearTimeout(entry.syncTimer);
        entry.syncTimer = null;
        const resolves = entry.resolves;
        entry.resolves = [];
        entry.writeQueue = entry.writeQueue
          .then(() => this.performWrite(moduleName, entry))
          .then(() => {
            for (const r of resolves) r();
          });
      }
      flushes.push(entry.writeQueue);
    }
    await Promise.all(flushes);
  }

  private entryFor(moduleName: string): PendingModuleWrite {
    let entry = this.pending.get(moduleName);
    if (!entry) {
      entry = {
        layout: null,
        syncTimer: null,
        resolves: [],
        writeQueue: Promise.resolve(),
        lastWritten: null,
      };
      this.pending.set(moduleName, entry);
    }
    return entry;
  }

  private async performWrite(moduleName: string, entry: PendingModuleWrite): Promise<void> {
    if (!entry.layout) {
      return;
    }

    const layout = entry.layout;
    entry.layout = null;

    const content = `${JSON.stringify(layout, null, 2)}\n`;
    // Full-state snapshots (see mergeNodeSnapshot) call writeModuleLayout on
    // every render, not just after a meaningful edit — skip the actual disk
    // write when nothing has changed since the last write so an idle diagram
    // doesn't churn the file (and git history) on every repaint.
    if (content === entry.lastWritten) {
      return;
    }

    const filePath = this.modulePath(moduleName);
    const tmpPath = `${filePath}.tmp`;

    try {
      await fs.mkdir(this.layoutsDir, { recursive: true });
      await fs.writeFile(tmpPath, content, 'utf8');
      await fs.rename(tmpPath, filePath);
      entry.lastWritten = content;
    } catch (error) {
      console.error(
        `Failed to write SVSCH layout for module "${moduleName}": ${(error as Error).message}`,
      );
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
}
