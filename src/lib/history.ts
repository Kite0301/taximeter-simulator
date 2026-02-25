import { LatLng } from './types';
import { FareRuntime } from './fare';

type FileInfo = { exists: boolean };
type ExpoFileSystem = {
  documentDirectory: string | null;
  getInfoAsync: (fileUri: string) => Promise<FileInfo>;
  readAsStringAsync: (fileUri: string) => Promise<string>;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
};

// Avoid static type resolution dependency so the app can compile in constrained environments.
const FileSystem = require('expo-file-system') as ExpoFileSystem;

const HISTORY_FILE = `${FileSystem.documentDirectory ?? ''}drive-history-v1.json`;
const SESSION_SNAPSHOT_FILE = `${FileSystem.documentDirectory ?? ''}session-snapshot-v1.json`;
const MAX_HISTORY_ITEMS = 100;

export type SessionEvent = {
  atMs: number;
  type: 'start' | 'pause' | 'resume' | 'finish';
};

export type PauseLog = {
  pausedAtMs: number;
  resumedAtMs: number;
  durationMs: number;
};

export type DriveHistoryItem = {
  id: string;
  createdAtMs: number;
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
  distanceKm: number;
  fareYen: number;
  presetId: string;
  from: LatLng | null;
  to: LatLng | null;
  acceptedSamples: number;
  filteredSamples: number;
  distanceChargeSteps: number;
  timeChargeSteps: number;
  pauseLogs: PauseLog[];
  events: SessionEvent[];
};

export type SessionSnapshot = {
  savedAtMs: number;
  sessionState: 'running' | 'paused';
  startedAtMs: number;
  elapsedMs: number;
  distanceKm: number;
  fareYen: number;
  billingMode: 'distance' | 'time' | 'unknown';
  selectedPresetId: string;
  acceptedSamples: number;
  filteredSamples: number;
  fareRuntime: FareRuntime;
  from: LatLng | null;
  to: LatLng | null;
  pauseLogs: PauseLog[];
  events: SessionEvent[];
};

export async function loadDriveHistory(): Promise<DriveHistoryItem[]> {
  try {
    const info = await FileSystem.getInfoAsync(HISTORY_FILE);
    if (!info.exists) return [];

    const raw = await FileSystem.readAsStringAsync(HISTORY_FILE);
    const parsed = JSON.parse(raw) as DriveHistoryItem[];
    if (!Array.isArray(parsed)) return [];

    return parsed;
  } catch {
    return [];
  }
}

export async function appendDriveHistory(item: DriveHistoryItem): Promise<void> {
  const current = await loadDriveHistory();
  const next = [item, ...current].slice(0, MAX_HISTORY_ITEMS);
  await FileSystem.writeAsStringAsync(HISTORY_FILE, JSON.stringify(next));
}

export async function exportDriveHistoryJson(): Promise<string> {
  const current = await loadDriveHistory();
  const exportPath = `${FileSystem.documentDirectory ?? ''}drive-history-export-${Date.now()}.json`;
  await FileSystem.writeAsStringAsync(exportPath, JSON.stringify(current, null, 2));
  return exportPath;
}

export async function loadSessionSnapshot(): Promise<SessionSnapshot | null> {
  try {
    const info = await FileSystem.getInfoAsync(SESSION_SNAPSHOT_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(SESSION_SNAPSHOT_FILE);
    const parsed = JSON.parse(raw) as SessionSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  await FileSystem.writeAsStringAsync(SESSION_SNAPSHOT_FILE, JSON.stringify(snapshot));
}

export async function clearSessionSnapshot(): Promise<void> {
  await FileSystem.writeAsStringAsync(SESSION_SNAPSHOT_FILE, '');
}
