export enum HdlPosition {
  Left = 'left',
  Top = 'top',
  Right = 'right',
  Bottom = 'bottom',
}

export interface OrthogonalPoint {
  x: number;
  y: number;
}

export interface SerializableOrthogonalRoute {
  routePoints?: OrthogonalPoint[];
  waypoint?: OrthogonalPoint;
}

export type RouteChangeHandler = (edgeId: string, routePoints: OrthogonalPoint[], commit: boolean) => void;
