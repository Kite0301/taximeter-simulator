export type FarePreset = {
  id: string;
  label: string;
  baseFareYen: number;
  baseDistanceKm: number;
  distanceStepKm: number;
  distanceStepFareYen: number;
  lowSpeedThresholdKmh: number;
  lowSpeedStepSeconds: number;
  lowSpeedStepFareYen: number;
};

export type FareRuntime = {
  baseDistanceRemainingKm: number;
  distanceRemainderKm: number;
  lowSpeedRemainderSeconds: number;
  fareYen: number;
};

export const FARE_PRESETS: FarePreset[] = [
  {
    id: 'tokyo',
    label: '東京',
    baseFareYen: 500,
    baseDistanceKm: 1.0,
    distanceStepKm: 0.255,
    distanceStepFareYen: 100,
    lowSpeedThresholdKmh: 10,
    lowSpeedStepSeconds: 90,
    lowSpeedStepFareYen: 100,
  },
  {
    id: 'osaka',
    label: '大阪',
    baseFareYen: 600,
    baseDistanceKm: 1.3,
    distanceStepKm: 0.26,
    distanceStepFareYen: 100,
    lowSpeedThresholdKmh: 10,
    lowSpeedStepSeconds: 95,
    lowSpeedStepFareYen: 100,
  },
];

export const DEFAULT_FARE_PRESET: FarePreset = FARE_PRESETS[0]!;

export function getPresetById(id: string): FarePreset {
  return FARE_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_FARE_PRESET;
}

export function createFareRuntime(preset: FarePreset): FareRuntime {
  return {
    baseDistanceRemainingKm: preset.baseDistanceKm,
    distanceRemainderKm: 0,
    lowSpeedRemainderSeconds: 0,
    fareYen: preset.baseFareYen,
  };
}

export function updateFareBySegment(params: {
  preset: FarePreset;
  runtime: FareRuntime;
  deltaDistanceKm: number;
  deltaSeconds: number;
  speedKmh: number;
}): FareRuntime {
  const { preset, runtime, deltaDistanceKm, deltaSeconds, speedKmh } = params;

  const next: FareRuntime = {
    ...runtime,
  };

  if (!Number.isFinite(deltaDistanceKm) || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return next;
  }

  const inLowSpeedMode = speedKmh <= preset.lowSpeedThresholdKmh;

  if (inLowSpeedMode) {
    next.lowSpeedRemainderSeconds += deltaSeconds;
    const timeSteps = Math.floor(next.lowSpeedRemainderSeconds / preset.lowSpeedStepSeconds);
    if (timeSteps > 0) {
      next.lowSpeedRemainderSeconds -= timeSteps * preset.lowSpeedStepSeconds;
      next.fareYen += timeSteps * preset.lowSpeedStepFareYen;
    }
    return next;
  }

  let chargeableDistance = deltaDistanceKm;
  if (next.baseDistanceRemainingKm > 0) {
    const consumed = Math.min(next.baseDistanceRemainingKm, chargeableDistance);
    next.baseDistanceRemainingKm -= consumed;
    chargeableDistance -= consumed;
  }

  if (chargeableDistance > 0) {
    next.distanceRemainderKm += chargeableDistance;
    const distanceSteps = Math.floor(next.distanceRemainderKm / preset.distanceStepKm);
    if (distanceSteps > 0) {
      next.distanceRemainderKm -= distanceSteps * preset.distanceStepKm;
      next.fareYen += distanceSteps * preset.distanceStepFareYen;
    }
  }

  return next;
}

export function formatYen(amount: number): string {
  return `JPY ${amount.toLocaleString('ja-JP')}`;
}
