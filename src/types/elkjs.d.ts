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
      sections?: Array<{
        id?: string;
        startPoint?: { x: number; y: number };
        endPoint?: { x: number; y: number };
        bendPoints?: Array<{ x: number; y: number }>;
        incomingShape?: string;
        outgoingShape?: string;
        incomingSections?: string[];
        outgoingSections?: string[];
      }>;
    }>;
    layoutOptions?: Record<string, string>;
    properties?: Record<string, string>;
  }

  export default class ELK {
    layout(graph: ElkNode): Promise<ElkNode>;
  }
}
