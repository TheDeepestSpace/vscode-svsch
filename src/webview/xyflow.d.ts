declare module '@xyflow/react' {
    import React from 'react';

    export type Position = 'left' | 'top' | 'right' | 'bottom';
    export const Position: {
        Left: 'left';
        Top: 'top';
        Right: 'right';
        Bottom: 'bottom';
    };

    export interface Node<T = any, U extends string = string> {
        id: string;
        position: { x: number; y: number };
        data: T;
        type?: U;
        [key: string]: any;
    }

    export interface Edge<T = any> {
        id: string;
        source: string;
        target: string;
        data?: T;
        [key: string]: any;
    }

    export interface NodeProps<T extends Node = Node> {
        id: string;
        data: T['data'];
        [key: string]: any;
    }

    export interface EdgeProps<T extends Edge = Edge> {
        id: string;
        sourceX: number;
        sourceY: number;
        targetX: number;
        targetY: number;
        sourcePosition: string;
        targetPosition: string;
        data?: T['data'];
        label?: React.ReactNode;
        [key: string]: any;
    }

    export interface MiniMapNodeProps {
        id: string;
        x: number;
        y: number;
        width: number;
        height: number;
        className?: string;
        [key: string]: any;
    }

    export const Background: React.FC<any>;
    export const Controls: React.FC<any>;
    export const Handle: React.FC<any>;
    export const MiniMap: React.FC<any>;
    export const ReactFlow: <NodeType extends Node = Node, EdgeType extends Edge = Edge>(props: any) => React.ReactElement;
    export const ReactFlowProvider: React.FC<{ children: React.ReactNode }>;

    export function useReactFlow(): any;
    export function useEdgesState<T extends Edge = Edge>(initialEdges: T[]): [T[], (edges: T[] | ((eds: T[]) => T[])) => void, any];
    export function useNodesState<T extends Node = Node>(initialNodes: T[]): [T[], (nodes: T[] | ((nds: T[]) => T[])) => void, any];
    export function useNodes<T extends Node = Node>(): T[];
}
