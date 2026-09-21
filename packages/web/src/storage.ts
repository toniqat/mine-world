import type { SaveData } from '@mine/core';
import type { ThemeSetting } from './theme';

/** Persistence: game saves in IndexedDB (structured clone), settings in localStorage. */
const DB_NAME = 'mineworld';
const STORE = 'saves';
const KEY = 'main';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadSave(): Promise<SaveData | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as SaveData) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('loadSave failed', e);
    return null;
  }
}

export async function writeSave(data: SaveData): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSave(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export type InputMode = 'classic' | 'toggle';
export type LangSetting = 'auto' | 'ko' | 'en';

export interface Settings {
  theme: ThemeSetting;
  lang: LangSetting;
  inputMode: InputMode;
  longPressMs: number;
  showProbabilities: boolean;
  showDensity: boolean;
  interventionMode: 'STRICT' | 'FAIR' | 'FORGIVING';
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  lang: 'auto',
  inputMode: 'classic',
  longPressMs: 450,
  showProbabilities: true,
  showDensity: false,
  interventionMode: 'FAIR',
};

const SETTINGS_KEY = 'mineworld.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode etc. */
  }
}
