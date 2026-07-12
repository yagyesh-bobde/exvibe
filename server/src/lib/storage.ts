/**
 * Atomic JSON persistence for server/data/*.
 * Writes go to a .tmp file in the same directory, then rename into place
 * (same pattern as the Python `_atomic_write_json`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const DATA_DIR = resolve(import.meta.dir, '../../data');
export const RAW_DIR = join(DATA_DIR, 'raw');

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
}

/** Absolute path for a file under server/data/. */
export function dataPath(name: string): string {
  return join(DATA_DIR, name);
}

/** Read + parse a JSON file; return `fallback` if missing or unparseable. */
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** Alias for readJson (route modules use the loadJson/saveJson names). */
export const loadJson = readJson;

/** Atomically write pretty-printed JSON (tmp file + rename). */
export function writeJsonAtomic(path: string, obj: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw e;
  }
}

/** Alias for writeJsonAtomic (route modules use the loadJson/saveJson names). */
export const saveJson = writeJsonAtomic;
