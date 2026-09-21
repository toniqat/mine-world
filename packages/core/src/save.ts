import type { DroneState } from './agents/drone';
import type { GameConfig } from './config';
import type { ScannerInfo } from './csp';
import type { BasesSnapshot } from './econ/bases';
import type { EconSnapshot } from './econ/income';
import type { DroneLoadout, LogEntry } from './game';

/** Structured-clone friendly save format (IndexedDB stores it directly). */
export interface SaveData {
  version: 1;
  savedAt: number;
  cfg: GameConfig;
  time: number;
  world: {
    overrides: Array<[number, 0 | 1]>;
    chunkPressure: Array<[number, number]>;
    densityDebt: number;
    interventions: number;
    /** Start-area centre; absent in older saves, which always started at (0, 0). */
    start?: { x: number; y: number; started: boolean };
  };
  board: Array<[number, Uint8Array]>;
  scanners: ScannerInfo[];
  nextScannerId: number;
  econ: EconSnapshot;
  upgrades: [string, number][];
  /** Main-base level and undelivered goods; absent in older saves (level 1). */
  bases?: BasesSnapshot;
  drones: DroneState[];
  /** Drone equipment; absent in older saves (no drones). */
  droneLoadout?: DroneLoadout;
  log: LogEntry[];
  nextLogId: number;
  rescuesLeft: number;
  stats: Record<string, number>;
}
