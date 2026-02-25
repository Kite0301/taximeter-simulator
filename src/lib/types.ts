export type LatLng = {
  latitude: number;
  longitude: number;
};

export type MeterState = {
  running: boolean;
  startedAtMs: number | null;
  elapsedMs: number;
  distanceKm: number;
  fareYen: number;
};
