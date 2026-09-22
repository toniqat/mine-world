import type { SaveData } from '@mine/core';
import type { ThemeSetting } from './theme';

/** Persistence: game saves in IndexedDB (structured clone), settings in localStorage. */
const DB_NAME = 'mineworld';
const STORE = 'saves';

/**
 * Save slots: only the endless world ('main') is saved in the browser. The
 * Earth map is played online now (its sessions live on the server); the old
 * single-player 'earth' slot is no longer read.
 */
export type SaveSlot = 'main';

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

export async function loadSave(slot: SaveSlot = 'main'): Promise<SaveData | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(slot);
      req.onsuccess = () => resolve((req.result as SaveData) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('loadSave failed', e);
    return null;
  }
}

export async function writeSave(data: SaveData, slot: SaveSlot = 'main'): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, slot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSave(slot: SaveSlot = 'main'): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(slot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export type InputMode = 'classic' | 'toggle';
export type LangSetting = 'ko' | 'en';

export interface Settings {
  theme: ThemeSetting;
  lang: LangSetting;
  inputMode: InputMode;
  showProbabilities: boolean;
}

/** The default language: Korean only when the system language is Korean, English otherwise. */
export function systemLang(): LangSetting {
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  lang: systemLang(),
  inputMode: 'classic',
  showProbabilities: true,
};

const SETTINGS_KEY = 'mineworld.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const s = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
    // Long press is gone; older settings still carry its delay.
    delete (s as Partial<Settings> & { longPressMs?: number }).longPressMs;
    // Older settings could follow the system language ('auto'); that choice is gone.
    if (s.lang !== 'ko' && s.lang !== 'en') s.lang = systemLang();
    return s;
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
