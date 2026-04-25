declare module 'elkjs/lib/elk.bundled.js' {
  export interface ElkNode {
    id: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    children?: ElkNode[];
    edges?: Array<{
      id: string;
      sources: string[];
      targets: string[];
    }>;
    layoutOptions?: Record<string, string>;
    properties?: Record<string, string>;
  }

  export default class ELK {
    layout(graph: ElkNode): Promise<ElkNode>;
  }
}
