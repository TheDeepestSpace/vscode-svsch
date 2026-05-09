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

export interface RouteChange {
  edgeId: string;
  routePoints: OrthogonalPoint[];
}

export type RouteChangeHandler = (changes: RouteChange[], commit: boolean) => void;
