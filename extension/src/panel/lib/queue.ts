/**
 * Panel-side view of the extension queue.
 *
 * The background service worker owns the queue (chrome.storage.local under
 * QUEUE_STORAGE_KEY) and the chrome.alarms scheduler. The panel reads the
 * stored list, subscribes to storage changes + QUEUE_UPDATED broadcasts, and
 * computes the "+3h after latest pending, min 60s lead" cadence slot locally
 * so the Queue button can show/confirm a concrete time.
 */

import type { QueueItem } from '../../shared/models';

/** Contract with the service worker: the queue lives under this key. */
export const QUEUE_STORAGE_KEY = 'exvibe.queue';

const QUEUE_MIN_LEAD_MS = 60_000;
const QUEUE_CADENCE_MS = 3 * 3_600_000;

export function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

export function hasChromeRuntime(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

function isQueueItem(v: unknown): v is QueueItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.kind === 'string' &&
    typeof o.text === 'string' &&
    typeof o.fire_at_iso === 'string' &&
    typeof o.status === 'string'
  );
}

export async function readQueue(): Promise<QueueItem[]> {
  if (!hasChromeStorage()) return [];
  const stored = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
  const raw: unknown = stored[QUEUE_STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isQueueItem);
}

/**
 * Re-fetch on either signal: chrome.storage change (sw wrote the queue) or a
 * QUEUE_UPDATED runtime broadcast. Returns an unsubscribe function.
 */
export function subscribeQueue(onChange: () => void): () => void {
  const unsubs: Array<() => void> = [];

  if (hasChromeStorage()) {
    const storageListener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area === 'local' && QUEUE_STORAGE_KEY in changes) onChange();
    };
    chrome.storage.onChanged.addListener(storageListener);
    unsubs.push(() => chrome.storage.onChanged.removeListener(storageListener));
  }

  if (hasChromeRuntime()) {
    const msgListener = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'QUEUE_UPDATED'
      ) {
        onChange();
      }
    };
    chrome.runtime.onMessage.addListener(msgListener);
    unsubs.push(() => chrome.runtime.onMessage.removeListener(msgListener));
  }

  return () => unsubs.forEach((fn) => fn());
}

/** Cadence: 3h after the latest pending item, never sooner than now + 60s. */
export function nextQueueSlot(items: QueueItem[], nowMs = Date.now()): Date {
  let latestPending = 0;
  for (const item of items) {
    if (item.status !== 'pending') continue;
    const t = Date.parse(item.fire_at_iso);
    if (!Number.isNaN(t) && t > latestPending) latestPending = t;
  }
  const base = latestPending > nowMs ? latestPending : nowMs;
  return new Date(Math.max(base + QUEUE_CADENCE_MS, nowMs + QUEUE_MIN_LEAD_MS));
}
