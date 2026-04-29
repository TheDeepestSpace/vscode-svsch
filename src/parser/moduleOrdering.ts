import type { DesignGraph, DesignModule } from '../ir/types';

export function orderGraphModules(graph: DesignGraph): DesignGraph {
  const instantiated = new Set<string>();
  for (const designModule of Object.values(graph.modules)) {
    for (const node of designModule.nodes) {
      if (node.kind === 'instance' && node.instanceOf) {
        instantiated.add(node.instanceOf);
      }
    }
  }

  if (graph.rootModules.length === 0) {
    graph.rootModules = Object.keys(graph.modules).filter((name) => !instantiated.has(name));
  }
  if (graph.rootModules.length === 0) {
    graph.rootModules = Object.keys(graph.modules).slice(0, 1);
  }
  graph.rootModules = sortRoots(graph.rootModules);

  const dependencies = new Map<string, Set<string>>();
  for (const designModule of Object.values(graph.modules)) {
    const deps = new Set<string>();
    for (const node of designModule.nodes) {
      if (node.kind === 'instance' && node.instanceOf) {
        deps.add(node.instanceOf);
      }
    }
    dependencies.set(designModule.name, deps);
  }

  const sortedModules: string[] = [];
  const visited = new Set<string>();

  function visit(moduleName: string): void {
    if (visited.has(moduleName) || !graph.modules[moduleName]) {
      return;
    }
    visited.add(moduleName);
    sortedModules.push(moduleName);

    for (const dep of [...(dependencies.get(moduleName) ?? [])].sort()) {
      visit(dep);
    }
  }

  for (const moduleName of graph.rootModules) {
    visit(moduleName);
  }
  for (const moduleName of Object.keys(graph.modules)) {
    visit(moduleName);
  }

  const orderedModules: Record<string, DesignModule> = {};
  for (const moduleName of sortedModules) {
    orderedModules[moduleName] = graph.modules[moduleName];
  }
  graph.modules = orderedModules;

  return graph;
}

function sortRoots(roots: string[]): string[] {
  return [...roots].sort((a, b) => {
    const aTop = a.toLowerCase().includes('top');
    const bTop = b.toLowerCase().includes('top');
    if (aTop && !bTop) return -1;
    if (!aTop && bTop) return 1;
    return a.localeCompare(b);
  });
}
