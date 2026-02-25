import * as Location from 'expo-location';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  createFareRuntime,
  DEFAULT_FARE_PRESET,
  FARE_PRESETS,
  formatYen,
  getPresetById,
  updateFareBySegment,
} from './src/lib/fare';
import { distanceKmBetween, formatDuration } from './src/lib/geo';
import { LatLng } from './src/lib/types';

type PermissionState = 'unknown' | 'granted' | 'denied';
type BillingMode = 'distance' | 'time' | 'unknown';
type SessionState = 'idle' | 'running' | 'paused';

const LOCATION_UPDATE_INTERVAL_MS = 1000;
const EDGE_PADDING = 16;
const LANDSCAPE_SIDE_PADDING = 22;
const MAX_REASONABLE_SPEED_KMH = 180;
const POOR_ACCURACY_METERS = 80;
const MAX_DISTANCE_FACTOR_KM_PER_SEC = (MAX_REASONABLE_SPEED_KMH / 3600) * 1.5;

function getNoisySampleReason(params: {
  deltaKm: number;
  deltaSeconds: number;
  speedKmh: number;
  accuracyMeters: number | null;
}): string | null {
  const { deltaKm, deltaSeconds, speedKmh, accuracyMeters } = params;

  if (!Number.isFinite(deltaKm) || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return 'invalid_delta';
  }

  if (speedKmh > MAX_REASONABLE_SPEED_KMH) {
    return 'speed_spike';
  }

  const dynamicDistanceCap = MAX_DISTANCE_FACTOR_KM_PER_SEC * deltaSeconds + 0.02;
  if (deltaKm > dynamicDistanceCap) {
    return 'distance_jump';
  }

  if (accuracyMeters !== null && accuracyMeters > POOR_ACCURACY_METERS && deltaKm > 0.03) {
    return 'poor_accuracy_jump';
  }

  return null;
}

export default function App() {
  const [permission, setPermission] = useState<PermissionState>('unknown');
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_FARE_PRESET.id);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [distanceKm, setDistanceKm] = useState(0);
  const [speedKmh, setSpeedKmh] = useState<number | null>(null);
  const [fareYen, setFareYen] = useState(DEFAULT_FARE_PRESET.baseFareYen);
  const [billingMode, setBillingMode] = useState<BillingMode>('unknown');
  const [acceptedSamples, setAcceptedSamples] = useState(0);
  const [filteredSamples, setFilteredSamples] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const watchSub = useRef<Location.LocationSubscription | null>(null);
  const lastPoint = useRef<LatLng | null>(null);
  const lastSampleTimeMs = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fareRuntimeRef = useRef(createFareRuntime(DEFAULT_FARE_PRESET));
  const elapsedAccumulatedMsRef = useRef(0);
  const runningSegmentStartMsRef = useRef<number | null>(null);

  const selectedPreset = useMemo(
    () => getPresetById(selectedPresetId),
    [selectedPresetId]
  );

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  async function requestLocationPermission(): Promise<boolean> {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.status === 'granted') {
      setPermission('granted');
      return true;
    }

    const requested = await Location.requestForegroundPermissionsAsync();
    if (requested.status === 'granted') {
      setPermission('granted');
      return true;
    }

    setPermission('denied');
    setErrorMessage('位置情報の許可が必要です。端末設定から許可してください。');
    return false;
  }

  function resetMeter(preset = selectedPreset) {
    setStartedAtMs(null);
    setElapsedMs(0);
    setDistanceKm(0);
    setSpeedKmh(null);
    setFareYen(preset.baseFareYen);
    setBillingMode('unknown');
    setAcceptedSamples(0);
    setFilteredSamples(0);
    fareRuntimeRef.current = createFareRuntime(preset);
    elapsedAccumulatedMsRef.current = 0;
    runningSegmentStartMsRef.current = null;
    lastPoint.current = null;
    lastSampleTimeMs.current = null;
  }

  function stopLocationWatch() {
    if (watchSub.current) {
      watchSub.current.remove();
      watchSub.current = null;
    }
  }

  function stopElapsedTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function stopSession() {
    stopLocationWatch();
    stopElapsedTimer();
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    timerRef.current = setInterval(() => {
      if (!runningSegmentStartMsRef.current) return;
      const segmentElapsed = Date.now() - runningSegmentStartMsRef.current;
      setElapsedMs(elapsedAccumulatedMsRef.current + segmentElapsed);
    }, 250);
  }

  async function startLocationWatch() {
    stopLocationWatch();
    watchSub.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: LOCATION_UPDATE_INTERVAL_MS,
        distanceInterval: 1,
      },
      (loc) => {
        const nextPoint: LatLng = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };

        if (lastPoint.current && lastSampleTimeMs.current) {
          const deltaKm = distanceKmBetween(lastPoint.current, nextPoint);
          const deltaSeconds = Math.max(0.1, (loc.timestamp - lastSampleTimeMs.current) / 1000);
          const rawSpeedKmh = (loc.coords.speed ?? 0) * 3.6;
          const fallbackSpeedKmh = deltaSeconds > 0 ? (deltaKm / deltaSeconds) * 3600 : 0;
          const currentSpeedKmh = rawSpeedKmh > 0 ? rawSpeedKmh : fallbackSpeedKmh;
          const noisySampleReason = getNoisySampleReason({
            deltaKm,
            deltaSeconds,
            speedKmh: currentSpeedKmh,
            accuracyMeters: loc.coords.accuracy ?? null,
          });

          if (noisySampleReason) {
            setFilteredSamples((prev) => prev + 1);
            setSpeedKmh(null);
            setBillingMode('unknown');
            console.debug('[gps-noise-filtered]', noisySampleReason, {
              deltaKm,
              deltaSeconds,
              speedKmh: currentSpeedKmh,
              accuracyMeters: loc.coords.accuracy ?? null,
            });
            lastPoint.current = nextPoint;
            lastSampleTimeMs.current = loc.timestamp;
            return;
          }

          setAcceptedSamples((prev) => prev + 1);

          if (deltaKm > 0) {
            setDistanceKm((prev) => prev + deltaKm);
          }

          const nextRuntime = updateFareBySegment({
            preset: selectedPreset,
            runtime: fareRuntimeRef.current,
            deltaDistanceKm: Math.max(0, deltaKm),
            deltaSeconds,
            speedKmh: currentSpeedKmh,
          });

          fareRuntimeRef.current = nextRuntime;
          setFareYen(nextRuntime.fareYen);
          setSpeedKmh(currentSpeedKmh);
          setBillingMode(
            currentSpeedKmh <= selectedPreset.lowSpeedThresholdKmh ? 'time' : 'distance'
          );
        }

        lastPoint.current = nextPoint;
        lastSampleTimeMs.current = loc.timestamp;
      }
    );
  }

  function finalizeRunningSegment(nowMs: number) {
    if (!runningSegmentStartMsRef.current) return;
    const segmentElapsed = nowMs - runningSegmentStartMsRef.current;
    elapsedAccumulatedMsRef.current += Math.max(0, segmentElapsed);
    runningSegmentStartMsRef.current = null;
    setElapsedMs(elapsedAccumulatedMsRef.current);
  }

  function enterPausedState() {
    const now = Date.now();
    finalizeRunningSegment(now);
    stopSession();
    setSpeedKmh(null);
    setSessionState('paused');
  }

  function finishSession() {
    stopSession();
    resetMeter(selectedPreset);
    setSessionState('idle');
  }

  async function startSession() {
    setErrorMessage(null);
    const granted = await requestLocationPermission();
    if (!granted) return;

    resetMeter(selectedPreset);
    const start = Date.now();
    setStartedAtMs(start);
    elapsedAccumulatedMsRef.current = 0;
    runningSegmentStartMsRef.current = start;
    setSessionState('running');
    startElapsedTimer();
    await startLocationWatch();
  }

  async function resumeSession() {
    if (sessionState !== 'paused') return;
    const now = Date.now();
    runningSegmentStartMsRef.current = now;
    lastPoint.current = null;
    lastSampleTimeMs.current = null;
    setSessionState('running');
    startElapsedTimer();
    await startLocationWatch();
  }

  const canStart = permission !== 'denied' && sessionState === 'idle';
  const canChangePreset = sessionState === 'idle';

  function handlePresetChange(nextPresetId: string) {
    if (!canChangePreset) return;
    const nextPreset = getPresetById(nextPresetId);
    setSelectedPresetId(nextPresetId);
    resetMeter(nextPreset);
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="light-content" />
        <View style={styles.container}>
        <View style={styles.leftPane}>
          <Text style={styles.title}>TAXIMETER SIMULATOR</Text>
          <View style={styles.meterCard}>
            <View style={styles.farePanel}>
              <Text style={styles.label}>FARE</Text>
              <Text style={styles.fare}>{formatYen(fareYen)}</Text>
            </View>

            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.label}>TIME</Text>
                <Text style={styles.value}>{formatDuration(elapsedMs)}</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.label}>DISTANCE</Text>
                <Text style={styles.value}>{distanceKm.toFixed(2)} km</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.label}>SPEED</Text>
                <Text style={styles.value}>
                  {speedKmh === null ? '-- km/h' : `${speedKmh.toFixed(1)} km/h`}
                </Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.label}>MODE</Text>
                <Text style={styles.modeValue}>
                  {billingMode === 'time' ? '低速時間' : billingMode === 'distance' ? '距離' : '待機'}
                </Text>
              </View>
            </View>

            <Text style={styles.meta}>
              {startedAtMs ? `Started: ${new Date(startedAtMs).toLocaleTimeString()}` : 'Ready'}
            </Text>
          </View>
        </View>

        <View style={styles.rightPane}>
          <View style={styles.presetCard}>
            <Text style={styles.label}>料金プリセット</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
              {FARE_PRESETS.map((preset) => {
                const active = selectedPresetId === preset.id;
                return (
                  <Pressable
                    key={preset.id}
                    onPress={() => handlePresetChange(preset.id)}
                    disabled={!canChangePreset}
                    style={({ pressed }) => [
                      styles.presetButton,
                      active && styles.presetButtonActive,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.presetText, active && styles.presetTextActive]}>
                      {preset.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Text style={styles.meta}>セッション中（計測中/一時停止中）は切替不可</Text>
          </View>

          <View style={styles.logicCard}>
            <Text style={styles.label}>計算ロジック（{selectedPreset.label}）</Text>
            <Text style={styles.logicLine}>
              1. 時速 {selectedPreset.lowSpeedThresholdKmh}km 以下は時間加算
            </Text>
            <Text style={styles.logicLine}>
              2. それより速いと距離加算
            </Text>
            <Text style={styles.logicLine}>
              3. 距離: {Math.round(selectedPreset.distanceStepKm * 1000)}m ごとに +{selectedPreset.distanceStepFareYen}円
            </Text>
            <Text style={styles.logicLine}>
              4. 時間: {selectedPreset.lowSpeedStepSeconds}秒ごとに +{selectedPreset.lowSpeedStepFareYen}円
            </Text>
            <Text style={styles.logicLine}>
              5. ノイズ除外: accepted={acceptedSamples} / filtered={filteredSamples}
            </Text>
          </View>

          {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

          {sessionState === 'idle' ? (
            <Pressable
              onPress={startSession}
              disabled={!canStart}
              style={({ pressed }) => [styles.button, styles.startButton, pressed && styles.pressed]}
            >
              <Text style={styles.buttonText}>運転開始</Text>
            </Pressable>
          ) : null}

          {sessionState === 'running' ? (
            <Pressable
              onPress={enterPausedState}
              style={({ pressed }) => [styles.button, styles.stopButton, pressed && styles.pressed]}
            >
              <Text style={styles.buttonText}>一時停止</Text>
            </Pressable>
          ) : null}

          {sessionState === 'paused' ? (
            <View style={styles.pausedActionRow}>
              <Pressable
                onPress={resumeSession}
                style={({ pressed }) => [styles.button, styles.resumeButton, pressed && styles.pressed]}
              >
                <Text style={styles.buttonText}>再開</Text>
              </Pressable>
              <Pressable
                onPress={finishSession}
                style={({ pressed }) => [styles.button, styles.stopButton, pressed && styles.pressed]}
              >
                <Text style={styles.buttonText}>終了</Text>
              </Pressable>
            </View>
          ) : null}
          {sessionState === 'paused' ? (
            <Text style={styles.meta}>一時停止中: 再開で継続、終了でリセット</Text>
          ) : null}
        </View>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#111827',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + EDGE_PADDING : EDGE_PADDING,
    paddingBottom: EDGE_PADDING,
    paddingLeft: LANDSCAPE_SIDE_PADDING,
    paddingRight: LANDSCAPE_SIDE_PADDING,
  },
  container: {
    flex: 1,
    flexDirection: 'row',
    padding: 12,
    gap: 14,
  },
  leftPane: {
    flex: 1.5,
    gap: 10,
  },
  rightPane: {
    flex: 1,
    gap: 10,
  },
  title: {
    color: '#9ca3af',
    fontSize: 16,
    letterSpacing: 2,
  },
  meterCard: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#f3f4f6',
    backgroundColor: '#030712',
    padding: 14,
    gap: 12,
  },
  farePanel: {
    flex: 1,
    minHeight: 180,
    borderRadius: 10,
    backgroundColor: '#04110a',
    borderWidth: 1,
    borderColor: '#14532d',
    padding: 14,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  statBox: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  label: {
    color: '#9ca3af',
    fontSize: 12,
    letterSpacing: 1,
  },
  fare: {
    color: '#22c55e',
    fontSize: 76,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  value: {
    color: '#f9fafb',
    fontSize: 24,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  modeValue: {
    color: '#f9fafb',
    fontSize: 22,
    fontWeight: '700',
  },
  meta: {
    color: '#6b7280',
    fontSize: 12,
  },
  presetCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
    backgroundColor: '#0b1220',
    padding: 12,
    gap: 8,
  },
  presetRow: {
    gap: 8,
  },
  presetButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4b5563',
    paddingVertical: 8,
    paddingHorizontal: 12,
    minWidth: 84,
    alignItems: 'center',
  },
  presetButtonActive: {
    borderColor: '#22c55e',
    backgroundColor: '#052e16',
  },
  presetText: {
    color: '#e5e7eb',
    fontSize: 14,
    fontWeight: '700',
  },
  presetTextActive: {
    color: '#bbf7d0',
  },
  logicCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
    backgroundColor: '#0b1220',
    padding: 12,
    gap: 4,
  },
  logicLine: {
    color: '#d1d5db',
    fontSize: 13,
  },
  error: {
    color: '#fca5a5',
    fontSize: 13,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    flex: 1,
  },
  pausedActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  startButton: {
    backgroundColor: '#15803d',
  },
  resumeButton: {
    backgroundColor: '#0369a1',
  },
  stopButton: {
    backgroundColor: '#b91c1c',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.85,
  },
});
