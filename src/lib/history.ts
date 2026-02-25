import { LatLng } from './types';

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
